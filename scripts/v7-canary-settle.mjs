import process from 'node:process';
import keytar from 'keytar';
import { createAccount, createClient } from 'genlayer-js';
import { studionet } from 'genlayer-js/chains';
import { CalldataAddress } from 'genlayer-js/types';

import { assertFinalizedExecution } from '../market/genlayer-client.js';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const EPOCH = /^\d{10}$/;
const SERVICE = 'genlayer-cli';
const FINALIZED = 'FINALIZED';
const STAKE_ATTO = 100_000_000_000_000_000n;

const CONTRACT = String(process.env.V7_CONTRACT_ADDRESS || '').trim();
const EPOCH_END_TEXT = String(process.env.V7_CANARY_EPOCH_END || '').trim();
const ACCOUNT_A_NAME = String(process.env.V7_CANARY_ACCOUNT_A || 'ic-builds-bradbury').trim();
const ACCOUNT_B_NAME = String(process.env.V7_CANARY_ACCOUNT_B || 'grounding-bradbury').trim();

function fail(message) {
  throw new Error(`V7 settlement canary refused: ${message}`);
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function addressBytes(value) {
  if (!ADDRESS.test(value)) fail('an account address was malformed');
  return Uint8Array.from(Buffer.from(value.slice(2), 'hex'));
}

function integer(value, label) {
  try {
    return BigInt(value);
  } catch {
    fail(`${label} was not an integer`);
  }
}

async function unlocked(name) {
  const privateKey = await keytar.getPassword(SERVICE, `account:${name}`);
  if (!privateKey) fail(`GenLayer CLI account ${name} is not unlocked`);
  const account = createAccount(privateKey);
  return { name, account, client: createClient({ chain: studionet, account }) };
}

async function finalized(client, hash) {
  const receipt = await client.waitForTransactionReceipt({
    hash,
    status: FINALIZED,
    interval: 5_000,
    retries: 180,
  });
  assertFinalizedExecution(receipt);
  return receipt;
}

async function entry(client, epochEnd, objective, account) {
  return client.readContract({
    address: CONTRACT,
    functionName: 'get_entry',
    args: [epochEnd, objective, new CalldataAddress(addressBytes(account))],
  });
}

async function quote(client, epochEnd, objective, account) {
  return client.readContract({
    address: CONTRACT,
    functionName: 'get_claim_quote',
    args: [epochEnd, objective, new CalldataAddress(addressBytes(account))],
  });
}

async function main() {
  if (!ADDRESS.test(CONTRACT)) fail('V7_CONTRACT_ADDRESS is required');
  if (!EPOCH.test(EPOCH_END_TEXT)) fail('V7_CANARY_EPOCH_END must be a ten-digit Unix timestamp');
  const epochEnd = BigInt(EPOCH_END_TEXT);
  if (BigInt(Math.floor(Date.now() / 1_000)) < epochEnd + 120n) fail('resolution publication delay has not elapsed');

  const [walletA, walletB] = await Promise.all([unlocked(ACCOUNT_A_NAME), unlocked(ACCOUNT_B_NAME)]);
  if (walletA.account.address.toLowerCase() === walletB.account.address.toLowerCase()) fail('two distinct wallets are required');

  let epoch = await walletB.client.readContract({ address: CONTRACT, functionName: 'get_epoch', args: [epochEnd] });
  if (epoch?.status !== 'OPEN') fail(`epoch status was ${epoch?.status || 'unknown'} before resolution`);
  const resolveHash = await walletB.client.writeContract({
    address: CONTRACT,
    functionName: 'resolve_epoch',
    args: [epochEnd],
    value: 0n,
  });
  emit({ event: 'V7_CANARY_RESOLVE_SUBMITTED', hash: resolveHash });
  await finalized(walletB.client, resolveHash);
  epoch = await walletB.client.readContract({ address: CONTRACT, functionName: 'get_epoch', args: [epochEnd] });
  if (epoch?.status !== 'RESOLVED' || epoch?.result_status !== 'DETERMINED') {
    fail(`resolved epoch was ${epoch?.status || 'unknown'}/${epoch?.result_status || 'unknown'}`);
  }
  emit({
    event: 'V7_CANARY_RESOLVE_VERIFIED',
    hash: resolveHash,
    highWinner: epoch.high_winner_asset_id,
    lowWinner: epoch.low_winner_asset_id,
    venueCount: epoch.venue_count,
    resolutionDigest: epoch.resolution_digest,
  });

  const positions = [
    { wallet: walletA, objective: 'HIGH', asset: 'BTC' },
    { wallet: walletA, objective: 'LOW', asset: 'XRP' },
    { wallet: walletB, objective: 'HIGH', asset: 'ETH' },
    { wallet: walletB, objective: 'LOW', asset: 'BNB' },
  ];
  for (const position of positions) {
    position.before = await entry(position.wallet.client, epochEnd, position.objective, position.wallet.account.address);
    position.quote = await quote(position.wallet.client, epochEnd, position.objective, position.wallet.account.address);
    if (integer(position.before?.stake_atto ?? 0, 'position stake') !== STAKE_ATTO
      || String(position.before?.choice_asset_id || '').toUpperCase() !== position.asset) {
      fail(`${position.wallet.name} ${position.objective} position did not match the canary`);
    }
  }

  const loser = positions.find((position) => position.quote?.eligible !== true
    && integer(position.quote?.amount_atto ?? position.quote?.claim_amount_atto ?? 0, 'loser quote') === 0n);
  let loserHash = null;
  if (loser) {
    loserHash = await loser.wallet.client.writeContract({
      address: CONTRACT,
      functionName: 'claim',
      args: [epochEnd, loser.objective],
      value: 0n,
    });
    emit({ event: 'V7_CANARY_LOSER_CLAIM_SUBMITTED', account: loser.wallet.account.address, objective: loser.objective, hash: loserHash });
    let rejected = false;
    try {
      await finalized(loser.wallet.client, loserHash);
    } catch {
      rejected = true;
    }
    if (!rejected) fail('an ineligible loser claim unexpectedly finalized successfully');
    const loserAfter = await entry(loser.wallet.client, epochEnd, loser.objective, loser.wallet.account.address);
    if (loserAfter?.claimed === true || integer(loserAfter?.claimed_atto ?? 0, 'loser claimed amount') !== 0n) {
      fail('loser state changed after rejected claim');
    }
    emit({ event: 'V7_CANARY_LOSER_CLAIM_REJECTED', account: loser.wallet.account.address, objective: loser.objective, hash: loserHash });
  } else {
    emit({ event: 'V7_CANARY_LOSER_PROOF_UNAVAILABLE', reason: 'Both objective winners were unbacked or otherwise refundable; all positions remain eligible for principal refunds.' });
  }

  const claimParents = [];
  for (const position of positions.filter((candidate) => candidate.quote?.eligible === true)) {
    const amount = integer(position.quote?.amount_atto ?? position.quote?.claim_amount_atto ?? 0, 'claim quote');
    if (amount <= 0n) fail('an eligible claim had no value');
    const hash = await position.wallet.client.writeContract({
      address: CONTRACT,
      functionName: 'claim',
      args: [epochEnd, position.objective],
      value: 0n,
    });
    emit({ event: 'V7_CANARY_CLAIM_SUBMITTED', account: position.wallet.account.address, objective: position.objective, amountAtto: amount.toString(), hash });
    await finalized(position.wallet.client, hash);
    const after = await entry(position.wallet.client, epochEnd, position.objective, position.wallet.account.address);
    if (after?.claimed !== true || integer(after?.claimed_atto ?? 0, 'claimed amount') !== amount) {
      fail('finalized claim post-state did not exactly match its quote');
    }
    claimParents.push(hash);
    emit({ event: 'V7_CANARY_CLAIM_PARENT_VERIFIED', account: position.wallet.account.address, objective: position.objective, amountAtto: amount.toString(), hash });
  }
  if (claimParents.length === 0) fail('no eligible payout or refund was claimable');

  const liability = await walletB.client.readContract({
    address: CONTRACT,
    functionName: 'get_total_player_liability_atto',
    args: [],
  });
  if (integer(liability, 'remaining player liability') !== 0n) fail('player liability remained after all eligible claims');
  emit({ event: 'V7_CANARY_ACCOUNTING_VERIFIED', resolveHash, loserHash, claimParents, playerLiabilityAtto: '0' });
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'V7_CANARY_SETTLEMENT_FAILED', message: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
});
