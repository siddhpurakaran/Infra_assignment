import dotenv from 'dotenv';
import { createTestClient, http } from 'viem'
import { foundry } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'

dotenv.config();

const mnemonic = process.env.PRIVATE_KEY;
if (!mnemonic || mnemonic == "") {
    throw new Error('MNEMONIC environment variable not set');
}

export const client = createTestClient({
    chain: foundry,
    mode: 'anvil',
    transport: http(),
})
// Local Account
export const account = privateKeyToAccount(`0x${mnemonic}`)