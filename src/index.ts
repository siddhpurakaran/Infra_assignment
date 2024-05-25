import axios from 'axios';
import { ethers } from 'ethers';
import keccak256 from 'keccak256';
import dotenv from 'dotenv';
import drandomOracleABI from "../abis/drandomOracleABI.json";
import sequencerOracleABI from "../abis/sequencerOracleABI.json";

dotenv.config();

const DRAND_URL = 'https://api.drand.sh/public/latest';
const PRECOMMIT_DELAY = 9; // Delay in seconds, adjust as needed
const SEQUENCER_INTERVAL = 2000; // in milliseconds
const VERBOSE = process.env.VERBOSE === 'true';

const DRAND_ORACLE_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const SEQUENCER_ORACLE_ADDRESS = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
const RPC_URL = 'http://127.0.0.1:8545';

interface SequencerRandom {
    timestamp: number;
    value: string;
    commitment: string;
}

interface DrandResponse {
    round: number;
    randomness: string;
}

interface PendingTx {
    type: 'drand' | 'sequencer' | 'reveal';
    timestamp: number;
    data: string;
    attempt: number;
}

let isFetchingDrand = false;

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || '', provider);
let nonce = 0;

const drandOracle = new ethers.Contract(DRAND_ORACLE_ADDRESS, drandomOracleABI, wallet);
const sequencerOracle = new ethers.Contract(SEQUENCER_ORACLE_ADDRESS, sequencerOracleABI, wallet);

const sequencerRandoms: SequencerRandom[] = [];
const pendingTxs: PendingTx[] = [];

function log(message: string, data: any) {
    if (VERBOSE) {
        console.log(message, JSON.stringify(data, null, 2));
    }
}

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchDrandRandomness(): Promise<DrandResponse> {
    const response = await axios.get(DRAND_URL);
    const rounddata = {
        round: response.data?.round, randomness: response.data?.randomness
    }
    return rounddata;
}

async function monitorDrandAndSubmitRandomness() {
    setInterval(async () => {
        if (isFetchingDrand) return;

        isFetchingDrand = true;
        try {
            const drandData = await fetchDrandRandomness();
            if (drandData?.randomness != "") {
                // console.log('Fetched Drand randomness:', drandData.randomness);
                await addDrandRandomness(drandData.randomness);
            }
        } catch (error) {
            console.error('Error fetching Drand randomness:', error);
        } finally {
            isFetchingDrand = false;
        }
    }, 3000);
}

function generateAndPostSequencerCommitment() {
    setInterval(async () => {
        const randomTimestamp = Math.floor(Date.now() / 1000) + PRECOMMIT_DELAY;
        const randomValue = ethers.hexlify(ethers.randomBytes(32));
        const commitment = keccak256(randomValue).toString('hex');

        const sequencerRandom = {
            timestamp: randomTimestamp,
            value: randomValue,
            commitment
        };
        await addSequencerCommitment(sequencerRandom);
    }, SEQUENCER_INTERVAL);
}

async function revealCommitment() {
    setInterval(async () => {
        const timestamp = Math.floor(Date.now() / 1000);
        if (sequencerRandoms.length > 0) {
            const sequencerRandom = sequencerRandoms[0];

            if (!sequencerRandom) {
                console.error('No sequencer random value found within timestamp:', timestamp);
            } else {
                if (sequencerRandom.timestamp > timestamp) {
                    console.error('Reveal not allowed for this timestamp now:', sequencerRandom.timestamp);
                } else {
                    while (sequencerRandom.timestamp + 10 <= timestamp) {
                        sequencerRandoms.splice(0, 1);
                    }

                    await revealSequencerRandom(sequencerRandom);
                    sequencerRandoms.splice(0, 1);
                }
            }
        }
    }, SEQUENCER_INTERVAL);
}

// async function getTransactionOptions() {
//     const nonce = await provider.getTransactionCount(wallet.address, 'latest');
//     const gasData = await provider.getFeeData();
//     return { nonce, gasPrice : gasData.gasPrice };
// }

async function addDrandRandomness(randomness: string) {
    const timestamp = Math.floor(Date.now() / 1000);
    const formattedRandomness = ethers.hexlify(ethers.toBeArray(`0x${randomness}`));
    try {
        console.log(nonce);
        const tx = await drandOracle.setDrandValue(timestamp.toString(), formattedRandomness, { nonce: nonce++ })
        log('Submitted Drand value', {
            randomness: randomness,
            transaction: tx.hash
        });
    } catch (error) {
        pendingTxs.push({
            type: 'drand',
            timestamp,
            data: formattedRandomness,
            attempt: 1
        });
        nonce--;
        console.error('Error adding Drand randomness:', error);
        // More retry logic can be added here
    }
}

async function addSequencerCommitment(sequencerRandom: SequencerRandom) {
    const formattedCommitment = ethers.hexlify(ethers.toBeArray(`0x${sequencerRandom.commitment}`));
    try {
        console.log(nonce);
        const tx = await sequencerOracle.setSequencerCommitment(sequencerRandom.timestamp, formattedCommitment, { nonce: nonce++ })
        sequencerRandoms.push(sequencerRandom);
        log('Posted sequencer random commitment', {
            timestamp: sequencerRandom.timestamp,
            commitment: sequencerRandom.commitment,
            transaction: tx.hash
        });
    } catch (error) {
        pendingTxs.push({
            type: 'sequencer',
            timestamp: sequencerRandom.timestamp,
            data: sequencerRandom.commitment,
            attempt: 1
        });
        nonce--;
        console.error('Error submitting sequencer commitment:', error);
        // More advance retry logic can be added here
    }
}

async function revealSequencerRandom(sequencerRandom: SequencerRandom) {
    try {
        // const options = await getTransactionOptions();
        console.log(nonce);
        const tx = await sequencerOracle.revealSequencerRandom(sequencerRandom.timestamp, sequencerRandom.value, { nonce: nonce++ })
        log('Revealed sequencer random value', {
            timestamp: sequencerRandom.timestamp,
            value: sequencerRandom.value,
            transaction: tx.hash
        });
    } catch (error) {
        pendingTxs.push({
            type: 'reveal',
            timestamp: sequencerRandom.timestamp,
            data: sequencerRandom.value,
            attempt: 1
        });
        nonce--;
        console.error('Error revealing sequencer random:', error);
        // More advance retry logic can be added here
    }
}

async function main() {
    nonce = await provider.getTransactionCount(wallet.address, 'latest')
    // Monitor and submit Drand randomness every 3 seconds
    monitorDrandAndSubmitRandomness();

    // Generate & Post sequencer random commitment every 2 seconds
    generateAndPostSequencerCommitment();

    await delay(500);
    // Reveal sequencer random value every 2 seconds
    revealCommitment();
}

main().catch(error => {
    console.error('Error in main execution:', error);
});