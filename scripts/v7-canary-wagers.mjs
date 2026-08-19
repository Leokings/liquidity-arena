import process from 'node:process';
import keytar from 'keytar';
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { CalldataAddress } from 'genlayer-js/types';

import { assertFinalizedExecution } from '../market/genlayer-client.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const EPOCH = /^\d{10}$/;
const SERVICE = 'genlayer-cli';
const STAKE_ATTO = 100_000_000_000_000_000n;
const FINALIZED = 'FINALIZED';

const CONTRACT = String(process.env.V7_CONTRACT_ADDRESS || '').trim();
const EPOCH_END_TEXT = String(process.env.V7_CANARY_EPOCH_END || '').trim();
const ACCOUNT_A = String(process.env.V7_CANARY_ACCOUNT_A || 'ic-builds-bradbury').trim();
const ACCOUNT_B = String(process.env.V7_CANARY_ACCOUNT_B || 'grounding-bradbury').trim();

function fail(message) {
  throw new Error(`V7 canary refused: ${message}`);
}

function addressBytes(value) {
  if (!ADDRESS.test(value)) fail('an account address was malformed');
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function bigintField(value, label) {
  try {
    return BigInt(value);
  } catch {
    fail(`${label} was not an integer`);
  }
}

async function unlockedAccount(name) {
  const privateKey = await keytar.getPassword(SERVICE, `account:${name}`);
  if (!privateKey) fail(`GenLayer CLI account ${name} is not unlocked`);
  return createAccount(privateKey);
}

async function readEntry(client, epochEnd, objective, account) {
  return client.readContract({
    address: CONTRACT,
    functionName: 'get_entry',
    args: [epochEnd, objective, new CalldataAddress(addressBytes(account))],
  });
}

async function submitWager({ accountName, objective, asset }) {
  const account = await unlockedAccount(accountName);
  const client = createClient({ chain: studionet, account });
  const epochEnd = BigInt(EPOCH_END_TEXT);
  const before = await readEntry(client, epochEnd, objective, account.address);
  if (bigintField(before?.stake_atto ?? 0, 'existing stake') !== 0n) {
    fail(`${accountName} already has a ${objective} position`);
  }

  const hash = await client.writeContract({
    address: CONTRACT,
    functionName: 'enter',
    args: [epochEnd, objective, asset],
    value: STAKE_ATTO,
  });
  process.stdout.write(`${JSON.stringify({ event: 'V7_CANARY_WAGER_SUBMITTED', account: account.address, objective, asset, hash })}\n`);

  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: FINALIZED,
    interval: 5_000,
    retries: 180,
  });
  assertFinalizedExecution(receipt);
  const after = await readEntry(client, epochEnd, objective, account.address);
  if (bigintField(after?.stake_atto ?? 0, 'finalized stake') !== STAKE_ATTO
    || String(after?.choice_asset_id || '').toUpperCase() !== asset) {
    fail(`${accountName} ${objective} post-state did not match the wager`);
  }
  process.stdout.write(`${JSON.stringify({ event: 'V7_CANARY_WAGER_VERIFIED', account: account.address, objective, asset, stakeAtto: STAKE_ATTO.toString(), hash })}\n`);
}

async function main() {
  if (!ADDRESS.test(CONTRACT)) fail('V7_CONTRACT_ADDRESS is required');
  if (!EPOCH.test(EPOCH_END_TEXT)) fail('V7_CANARY_EPOCH_END must be a ten-digit Unix timestamp');
  if (!ACCOUNT_A || !ACCOUNT_B || ACCOUNT_A === ACCOUNT_B) fail('two distinct unlocked account names are required');

  const readClient = createClient({ chain: studionet });
  const [config, epoch] = await Promise.all([
    readClient.readContract({ address: CONTRACT, functionName: 'get_config', args: [] }),
    readClient.readContract({ address: CONTRACT, functionName: 'get_epoch', args: [BigInt(EPOCH_END_TEXT)] }),
  ]);
  if (config?.protocol_version !== 'LIQUIDITY_ARENA_V7') fail('the contract is not exact V7');
  if (config?.policy_version !== 'CRYPTO_SPOT_1M_MEDIAN_V1') fail('the settlement policy is not exact V1');
  if (epoch?.status !== 'OPEN' || epoch?.phase !== 'WAGER_OPEN') {
    fail(`epoch phase is ${epoch?.phase || 'unknown'}, not WAGER_OPEN`);
  }
  if (bigintField(epoch?.min_stake_atto, 'minimum stake') !== STAKE_ATTO) fail('canary stake does not equal the epoch minimum');

  for (const wager of [
    { accountName: ACCOUNT_A, objective: 'HIGH', asset: 'BTC' },
    { accountName: ACCOUNT_A, objective: 'LOW', asset: 'XRP' },
    { accountName: ACCOUNT_B, objective: 'HIGH', asset: 'ETH' },
    { accountName: ACCOUNT_B, objective: 'LOW', asset: 'BNB' },
  ]) {
    await submitWager(wager);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'V7_CANARY_FAILED', message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
