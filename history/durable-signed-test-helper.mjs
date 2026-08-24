import { createHash } from 'node:crypto';

import { Interface, Wallet } from 'ethers';
import { abi as genlayerAbi } from 'genlayer-js';

import {
  BRADBURY_CONSENSUS_ADDRESS,
  inspectDurableSignedTransaction,
} from '../keeper-journal/signed-transaction.mjs';

const PRIVATE_KEY = `0x${'11'.repeat(32)}`;
const WALLET = new Wallet(PRIVATE_KEY);
const ADD_TRANSACTION = new Interface([
  'function addTransaction(address sender,address recipient,uint256 initialValidators,uint256 maxRotations,bytes transactionData,uint256 validUntil)',
]);

export const TEST_DURABLE_SIGNER = WALLET.address.toLowerCase();
export const TEST_NEW_TRANSACTION_TOPIC =
  '0xdab9102861c7483a187584d6371d88316f005af507982ccf95c110879f3ed5a5';

export async function durableSignedEvidence({
  contractAddress,
  method,
  args,
  nonce = '7',
} = {}) {
  const calldata = genlayerAbi.calldata.encode(
    genlayerAbi.calldata.makeCalldataObject(method, args, undefined),
  );
  const transactionData = genlayerAbi.transactions.serialize([calldata, false]);
  const data = ADD_TRANSACTION.encodeFunctionData('addTransaction', [
    TEST_DURABLE_SIGNER,
    contractAddress,
    5,
    3,
    transactionData,
    2_000_000_000,
  ]);
  const raw = await WALLET.signTransaction({
    to: BRADBURY_CONSENSUS_ADDRESS,
    data,
    type: 0,
    nonce: Number(nonce),
    value: 0n,
    gasLimit: 900_000n,
    gasPrice: 200_000_000n,
    chainId: 4_221,
  });
  return inspectDurableSignedTransaction(raw);
}

export function durableSubmissionEvidence(evidence, transactionHash) {
  return Object.freeze({
    transactionHash,
    outerTransactionHash: evidence.outerTransactionHash,
    receiptBlockHash: `0x${'c'.repeat(64)}`,
    receiptBlockNumber: '18790587',
    finalizedHeadBlockNumber: '18790588',
    eventTopic: TEST_NEW_TRANSACTION_TOPIC,
    logIndex: '0',
    eventActivator: '0x3b940a5b4a762583453d9e9cf0981be0426a8e79',
    receiptIdentityVerified: true,
    evidenceSha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  });
}

export function durableOuterFailureEvidence(evidence) {
  return Object.freeze({
    outerTransactionHash: evidence.outerTransactionHash,
    receiptBlockHash: `0x${'d'.repeat(64)}`,
    receiptBlockNumber: '18790587',
    finalizedHeadBlockNumber: '18790588',
    receiptStatus: '0',
    receiptCanonical: true,
    newTransactionEventCount: '0',
    failureCode: 'OUTER_RECEIPT_REVERTED',
    evidenceSha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  });
}

export function durableOuterAmbiguityEvidence(evidence, eventCount = '0') {
  return Object.freeze({
    outerTransactionHash: evidence.outerTransactionHash,
    receiptBlockHash: `0x${'e'.repeat(64)}`,
    receiptBlockNumber: '18790587',
    finalizedHeadBlockNumber: '18790588',
    receiptStatus: '1',
    receiptCanonical: true,
    newTransactionEventCount: eventCount,
    receiptIdentityVerified: false,
    ambiguityCode: 'OUTER_RECEIPT_IDENTITY_AMBIGUOUS',
    evidenceSha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
  });
}
