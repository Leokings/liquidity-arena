import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join as joinPath, win32 as windowsPath } from 'node:path';
import process from 'node:process';
import { isDeepStrictEqual } from 'node:util';

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const TRANSACTION_HASH_PATTERN = /Write Transaction Hash:\s*(0x[\da-f]{64})/i;
const ERROR_TAG_PATTERN = /\[(TRANSIENT|EXPECTED|EXTERNAL)\]/i;
const STUDIO_SUCCESS_CONSENSUS_RESULT = 'MAJORITY_AGREE';
const STUDIO_SUCCESS_CONSENSUS_RESULT_CODE = 6;
const STUDIO_SUCCESS_EXECUTION_RESULT = 'SUCCESS';
const STUDIO_SUCCESS_RETURN_STATUS = 'RETURN';
const GENLAYER_TRANSACTION_STATUSES = new Set([
  'UNKNOWN', 'PENDING', 'PROPOSING', 'COMMITTING', 'REVEALING',
  'ACCEPTED', 'FINALIZED',
]);

export const GENLAYER_FINALIZED_STATUS = 'FINALIZED';
export const GENLAYER_SUCCESS_RESULT = 'FINISHED_WITH_RETURN';
export const GENLAYER_STUDIONET_RPC_URL = 'https://studio.genlayer.com/api';

function asText(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function cleanOutput(value) {
  return asText(value).replace(ANSI_ESCAPE_PATTERN, '');
}

export class GenlayerCommandError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GenlayerCommandError';
    Object.assign(this, details);
  }
}

export function extractGenlayerTransactionHash(output) {
  return cleanOutput(output).match(TRANSACTION_HASH_PATTERN)?.[1];
}

export function categorizeGenlayerFailure(value) {
  const text = cleanOutput(value instanceof Error
    ? `${value.message}\n${value.stdout || ''}\n${value.stderr || ''}`
    : value);
  const tagged = text.match(ERROR_TAG_PATTERN)?.[1]?.toUpperCase();
  if (tagged) return tagged;
  if (/\b(?:timed?\s*out|timeout)\b|transaction not found|receipt not found/i.test(text)) {
    return 'RETRYABLE_TIMEOUT';
  }
  if (/\b(?:ECONN\w*|ENOTFOUND|EAI_AGAIN|network|socket|RPC|502|503|504)\b|fetch failed/i.test(text)) {
    return 'RETRYABLE_TRANSPORT';
  }
  return 'UNKNOWN';
}

/**
 * Parse Node's `util.inspect` subset used by the CLI for view-call results.
 * This deliberately avoids eval: contract output is untrusted data.
 */
class InspectValueParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  skipWhitespace() {
    while (/\s/.test(this.source[this.index] || '')) this.index += 1;
  }

  peek() {
    this.skipWhitespace();
    return this.source[this.index];
  }

  consume(expected) {
    this.skipWhitespace();
    if (this.source[this.index] !== expected) {
      throw new Error(`expected ${expected} at offset ${this.index}`);
    }
    this.index += 1;
  }

  parseString() {
    this.skipWhitespace();
    const quote = this.source[this.index];
    this.index += 1;
    let result = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      this.index += 1;
      if (character === quote) return result;
      if (character !== '\\') {
        result += character;
        continue;
      }
      if (this.index >= this.source.length) break;
      const escaped = this.source[this.index];
      this.index += 1;
      const simple = {
        n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0',
        '\\': '\\', "'": "'", '"': '"', '`': '`',
      };
      if (escaped in simple) {
        result += simple[escaped];
      } else if (escaped === 'x') {
        const value = this.source.slice(this.index, this.index + 2);
        if (!/^[\da-f]{2}$/i.test(value)) throw new Error('invalid hexadecimal escape');
        result += String.fromCharCode(Number.parseInt(value, 16));
        this.index += 2;
      } else if (escaped === 'u') {
        const value = this.source.slice(this.index, this.index + 4);
        if (!/^[\da-f]{4}$/i.test(value)) throw new Error('invalid unicode escape');
        result += String.fromCharCode(Number.parseInt(value, 16));
        this.index += 4;
      } else {
        result += escaped;
      }
    }
    throw new Error('unterminated string');
  }

  parseWord() {
    this.skipWhitespace();
    const start = this.index;
    while (/[\w$.-]/.test(this.source[this.index] || '')) this.index += 1;
    if (start === this.index) throw new Error(`expected value at offset ${this.index}`);
    return this.source.slice(start, this.index);
  }

  parseArray() {
    this.consume('[');
    const result = [];
    while (this.peek() !== ']') {
      result.push(this.parseValue());
      if (this.peek() === ',') this.consume(',');
      else if (this.peek() !== ']') throw new Error(`expected comma at offset ${this.index}`);
    }
    this.consume(']');
    return result;
  }

  parseObject() {
    this.consume('{');
    const result = {};
    while (this.peek() !== '}') {
      const key = ['"', "'", '`'].includes(this.peek()) ? this.parseString() : this.parseWord();
      this.consume(':');
      const value = this.parseValue();
      if (Object.hasOwn(result, key)) throw new Error(`duplicate object key: ${key}`);
      if (value !== undefined) result[key] = value;
      if (this.peek() === ',') this.consume(',');
      else if (this.peek() !== '}') throw new Error(`expected comma at offset ${this.index}`);
    }
    this.consume('}');
    return result;
  }

  parseValue() {
    const next = this.peek();
    if (next === '{') return this.parseObject();
    if (next === '[') return this.parseArray();
    if (['"', "'", '`'].includes(next)) return this.parseString();
    const word = this.parseWord();
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === 'undefined') return undefined;
    if (/^-?\d+n$/.test(word)) return word.slice(0, -1);
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(word)) {
      const number = Number(word);
      return Number.isSafeInteger(number) || !Number.isInteger(number) ? number : word;
    }
    return word;
  }
}

/**
 * Parse GenVM's `calldata.readable` representation. It is JSON-like, except
 * object members are commonly emitted without commas and arrays may contain a
 * trailing comma. The receipt is untrusted, so this parser accepts only that
 * narrow data grammar and never evaluates the source.
 */
class StudioReadableParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
  }

  skipWhitespace() {
    while (/\s/.test(this.source[this.index] || '')) this.index += 1;
  }

  peek() {
    this.skipWhitespace();
    return this.source[this.index];
  }

  consume(expected) {
    this.skipWhitespace();
    if (this.source[this.index] !== expected) {
      throw new Error(`expected ${expected} at offset ${this.index}`);
    }
    this.index += 1;
  }

  parseString() {
    this.skipWhitespace();
    if (this.source[this.index] !== '"') {
      throw new Error(`expected a JSON string at offset ${this.index}`);
    }
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      this.index += 1;
      if (character === '\\') {
        if (this.index >= this.source.length) throw new Error('unterminated string escape');
        this.index += 1;
        continue;
      }
      if (character !== '"') continue;
      try {
        return JSON.parse(this.source.slice(start, this.index));
      } catch (error) {
        throw new Error(`invalid JSON string: ${error.message}`);
      }
    }
    throw new Error('unterminated string');
  }

  parseNumber() {
    this.skipWhitespace();
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(
      this.source.slice(this.index),
    );
    if (!match) throw new Error(`expected a number at offset ${this.index}`);
    this.index += match[0].length;
    const number = Number(match[0]);
    if (!Number.isFinite(number)) throw new Error(`invalid number at offset ${this.index}`);
    return Number.isSafeInteger(number) || !Number.isInteger(number) ? number : match[0];
  }

  parseArray() {
    this.consume('[');
    const result = [];
    while (this.peek() !== ']') {
      result.push(this.parseValue());
      if (this.peek() === ',') {
        this.consume(',');
      } else if (this.peek() !== ']') {
        throw new Error(`expected comma at offset ${this.index}`);
      }
    }
    this.consume(']');
    return result;
  }

  parseObject() {
    this.consume('{');
    const result = {};
    while (this.peek() !== '}') {
      const key = this.parseString();
      this.consume(':');
      const value = this.parseValue();
      if (Object.hasOwn(result, key)) throw new Error(`duplicate object key: ${key}`);
      result[key] = value;
      // GenVM commonly omits this separator. If it is present, accept one;
      // otherwise the next token must be a quoted member name or the close.
      if (this.peek() === ',') this.consume(',');
      if (this.peek() !== '}' && this.peek() !== '"') {
        throw new Error(`expected an object member at offset ${this.index}`);
      }
    }
    this.consume('}');
    return result;
  }

  parseValue() {
    const next = this.peek();
    if (next === '{') return this.parseObject();
    if (next === '[') return this.parseArray();
    if (next === '"') return this.parseString();
    for (const [literal, value] of [['true', true], ['false', false], ['null', null]]) {
      if (this.source.startsWith(literal, this.index)) {
        this.index += literal.length;
        return value;
      }
    }
    return this.parseNumber();
  }

  parseDocument() {
    const result = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      throw new Error(`unexpected data at offset ${this.index}`);
    }
    return result;
  }
}

export function parseGenlayerCallOutput(output) {
  const text = cleanOutput(output);
  const resultMarker = /(?:^|\n)[ \t]*Result:[ \t]*\r?\n/.exec(text);
  if (!resultMarker) throw new Error('GenLayer call did not report a standalone Result value.');
  const source = text.slice(resultMarker.index + resultMarker[0].length);
  try {
    return new InspectValueParser(source).parseValue();
  } catch (error) {
    throw new Error(`Unable to parse GenLayer call result: ${error.message}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function uniqueUppercase(values, label) {
  const normalized = values
    .filter((value) => value !== undefined && value !== null && String(value).trim() !== '')
    .map((value) => String(value).trim().toUpperCase());
  const unique = [...new Set(normalized)];
  if (unique.length > 1) {
    throw new Error(`GenLayer receipt reported conflicting ${label} values.`);
  }
  return unique[0] || '';
}

function oneObjectVariant(object, snakeName, camelName, label) {
  const snake = object[snakeName];
  const camel = object[camelName];
  if (snake !== undefined && camel !== undefined) {
    throw new Error(`GenLayer receipt reported conflicting ${label} objects.`);
  }
  const value = snake ?? camel;
  if (!isPlainObject(value)) {
    throw new Error(`GenLayer receipt did not report ${label}.`);
  }
  return value;
}

function decodedCallIdentity(value, label) {
  if (!isPlainObject(value) || value.type !== 'call' || !isPlainObject(value.callData)) {
    throw new Error(`GenLayer receipt reported malformed ${label}.`);
  }
  const { method, args } = value.callData;
  if (typeof method !== 'string' || method.trim() === '' || !Array.isArray(args)) {
    throw new Error(`GenLayer receipt reported malformed ${label}.`);
  }
  return { type: 'call', callData: { method, args } };
}

function studioDecodedCallIdentity(direct) {
  if (direct.data === undefined) return undefined;
  if (!isPlainObject(direct.data)) {
    throw new Error('GenLayer Studio receipt reported malformed data.');
  }
  if (direct.data.calldata === undefined) return undefined;
  if (!isPlainObject(direct.data.calldata)) {
    throw new Error('GenLayer Studio receipt reported malformed data.calldata.');
  }
  const readable = direct.data.calldata.readable;
  if (typeof readable !== 'string' || readable.trim() === '') {
    throw new Error('GenLayer Studio receipt did not report data.calldata.readable.');
  }
  let parsed;
  try {
    parsed = new StudioReadableParser(readable).parseDocument();
  } catch (error) {
    throw new Error(`Unable to parse GenLayer Studio data.calldata.readable: ${error.message}`);
  }
  if (!isPlainObject(parsed) || typeof parsed.method !== 'string' || parsed.method.trim() === ''
    || !Array.isArray(parsed.args)) {
    throw new Error('GenLayer Studio data.calldata.readable did not report exact method and args.');
  }
  return {
    type: 'call',
    callData: { method: parsed.method, args: parsed.args },
  };
}

function studioExecutionResult(direct) {
  const resultName = uniqueUppercase(
    [direct.result_name, direct.resultName],
    'result_name',
  );
  if (!resultName) throw new Error('GenLayer Studio receipt did not report result_name.');
  if (resultName !== STUDIO_SUCCESS_CONSENSUS_RESULT) {
    throw new Error(`GenLayer Studio receipt consensus result is ${resultName}, not MAJORITY_AGREE.`);
  }

  const rawResult = direct.result;
  const numericResult = typeof rawResult === 'number'
    ? rawResult
    : (/^\d+$/.test(String(rawResult ?? '')) ? Number(rawResult) : Number.NaN);
  if (!Number.isSafeInteger(numericResult)) {
    throw new Error('GenLayer Studio receipt did not report a numeric result code.');
  }
  if (numericResult !== STUDIO_SUCCESS_CONSENSUS_RESULT_CODE) {
    throw new Error(
      `GenLayer Studio receipt result code is ${numericResult}, not `
      + `${STUDIO_SUCCESS_CONSENSUS_RESULT_CODE} (MAJORITY_AGREE).`,
    );
  }

  const consensus = oneObjectVariant(
    direct,
    'consensus_data',
    'consensusData',
    'consensus_data',
  );
  const snakeLeaders = consensus.leader_receipt;
  const camelLeaders = consensus.leaderReceipt;
  if (snakeLeaders !== undefined && camelLeaders !== undefined) {
    throw new Error('GenLayer Studio receipt reported conflicting leader_receipt values.');
  }
  const rawLeaders = snakeLeaders ?? camelLeaders;
  const leaders = Array.isArray(rawLeaders) ? rawLeaders : [rawLeaders];
  if (rawLeaders === undefined || leaders.length === 0) {
    throw new Error('GenLayer Studio receipt did not report leader_receipt evidence.');
  }

  const authoritative = [];
  for (const [index, entry] of leaders.entries()) {
    if (!isPlainObject(entry)) {
      throw new Error(`GenLayer Studio leader_receipt[${index}] is malformed.`);
    }
    const mode = uniqueUppercase([entry.mode], `leader_receipt[${index}].mode`);
    if (!mode) throw new Error(`GenLayer Studio leader_receipt[${index}] did not report mode.`);
    if (mode === 'LEADER') authoritative.push({ index, entry });
  }
  if (authoritative.length !== 1) {
    throw new Error(
      `GenLayer Studio receipt must contain exactly one authoritative mode=leader entry; `
      + `received ${authoritative.length}.`,
    );
  }

  const [{ index, entry: leader }] = authoritative;
  const executionResult = uniqueUppercase(
    [leader.execution_result, leader.executionResult],
    `leader_receipt[${index}].execution_result`,
  );
  if (executionResult !== STUDIO_SUCCESS_EXECUTION_RESULT) {
    throw new Error(
      `GenLayer Studio leader_receipt[${index}] execution_result is `
      + `${executionResult || '(missing)'}, not SUCCESS.`,
    );
  }
  if (!isPlainObject(leader.result)) {
    throw new Error(`GenLayer Studio leader_receipt[${index}] did not report a result object.`);
  }
  const returnStatus = uniqueUppercase(
    [leader.result.status],
    `leader_receipt[${index}].result.status`,
  );
  if (returnStatus !== STUDIO_SUCCESS_RETURN_STATUS) {
    throw new Error(
      `GenLayer Studio leader_receipt[${index}] result.status is `
      + `${returnStatus || '(missing)'}, not return.`,
    );
  }

  const genvm = leader.genvm_result ?? leader.genvmResult;
  if (genvm !== undefined) {
    if (!isPlainObject(genvm)) {
      throw new Error(`GenLayer Studio leader_receipt[${index}].genvm_result is malformed.`);
    }
    const rawError = genvm.raw_error ?? genvm.rawError;
    const errorCode = genvm.error_code ?? genvm.errorCode;
    if (rawError !== undefined && rawError !== null) {
      throw new Error(`GenLayer Studio leader_receipt[${index}] reported a GenVM raw error.`);
    }
    if (errorCode !== undefined && errorCode !== null) {
      throw new Error(`GenLayer Studio leader_receipt[${index}] reported a GenVM error code.`);
    }
  }

  return GENLAYER_SUCCESS_RESULT;
}

export function parseGenlayerReceiptOutput(output, {
  transactionHash,
  requireExecution = true,
} = {}) {
  const text = cleanOutput(output);
  const resolvedHash = transactionHash || extractGenlayerTransactionHash(text);
  let result;
  try {
    result = parseGenlayerCallOutput(text);
  } catch (error) {
    if (/(?:^|\n)[ \t]*Result:[ \t]*\r?\n/.test(text)) throw error;
    result = undefined;
  }
  const direct = isPlainObject(result) ? result : {};
  // Fallback is anchored to direct util.inspect properties. Never scan nested
  // stdout/stderr, which can contain contract-controlled lookalike text.
  const directLine = (name, label) => {
    const matches = [...text.matchAll(
      new RegExp(`^ {2}["']?${name}["']?\\s*:\\s*["']?([A-Z_]+)["']?\\s*,?\\s*$`, 'gim'),
    )].map((match) => match[1].toUpperCase());
    const unique = [...new Set(matches)];
    if (unique.length > 1) throw new Error(`GenLayer receipt reported conflicting ${label} values.`);
    return unique[0];
  };
  const statusLine = directLine('(?:status_name|statusName)', 'status_name');
  const executionLine = directLine('txExecutionResultName', 'txExecutionResultName');
  const statusName = uniqueUppercase(
    [direct.status_name, direct.statusName, statusLine],
    'status_name',
  );
  const nativeExecution = uniqueUppercase(
    [direct.tx_execution_result_name, direct.txExecutionResultName, executionLine],
    'txExecutionResultName',
  );
  const hasStudioConsensus = direct.consensus_data !== undefined
    || direct.consensusData !== undefined;
  const hasStudioResult = direct.result_name !== undefined
    || direct.resultName !== undefined
    || direct.result !== undefined;
  let studioExecution = '';
  if (hasStudioConsensus || (!nativeExecution && hasStudioResult)) {
    studioExecution = studioExecutionResult(direct);
  }
  if (nativeExecution && studioExecution && nativeExecution !== studioExecution) {
    throw new Error('GenLayer receipt reported conflicting execution result evidence.');
  }
  const txExecutionResultName = nativeExecution || studioExecution;
  const studioDecoded = studioExecution ? studioDecodedCallIdentity(direct) : undefined;
  if (studioDecoded && direct.txDataDecoded !== undefined) {
    const nativeDecoded = decodedCallIdentity(direct.txDataDecoded, 'txDataDecoded');
    if (nativeDecoded.callData.method !== studioDecoded.callData.method
      || !isDeepStrictEqual(nativeDecoded.callData.args, studioDecoded.callData.args)) {
      throw new Error('GenLayer receipt reported conflicting decoded call identity evidence.');
    }
  }
  const txDataDecoded = studioDecoded || direct.txDataDecoded;
  if (!statusName) throw new Error('GenLayer receipt did not report status_name.');
  if (requireExecution && !txExecutionResultName) {
    throw new Error('GenLayer receipt did not report txExecutionResultName.');
  }
  return Object.freeze({
    transactionHash: resolvedHash,
    statusName,
    txExecutionResultName,
    errorCategory: categorizeGenlayerFailure(text),
    recipient: direct.recipient,
    txDataDecoded,
    output: text,
  });
}

export function assertFinalizedGenlayerExecution(receipt) {
  if (receipt.statusName !== GENLAYER_FINALIZED_STATUS) {
    throw new Error(
      `GenLayer transaction ${receipt.transactionHash || '(unknown)'} is ${receipt.statusName}, not FINALIZED.`,
    );
  }
  if (receipt.txExecutionResultName !== GENLAYER_SUCCESS_RESULT) {
    throw new Error(
      `GenLayer transaction ${receipt.transactionHash || '(unknown)'} finalized with ${receipt.txExecutionResultName}.`,
    );
  }
  return receipt;
}

export async function getGenlayerTransactionStatus({
  rpcUrl,
  transactionHash,
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
} = {}) {
  const url = new URL(String(rpcUrl || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('GenLayer status RPC must be an HTTPS URL without credentials or a fragment.');
  }
  if (!/^0x[\da-f]{64}$/i.test(String(transactionHash || ''))) {
    throw new Error('GenLayer status lookup requires an exact transaction hash.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('GenLayer status lookup requires fetch.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('GenLayer status timeout is invalid.');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'gen_getTransactionStatus',
        params: [String(transactionHash).toLowerCase()],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new GenlayerCommandError('GenLayer transaction status request failed.', { cause: error });
  }
  const text = await response.text();
  if (!response.ok) {
    throw new GenlayerCommandError(
      `GenLayer transaction status RPC returned HTTP ${response.status}.`,
      { status: response.status, stderr: text.slice(0, 4_096) },
    );
  }
  if (text.length > 16 * 1024) throw new Error('GenLayer transaction status response is too large.');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('GenLayer transaction status response is not valid JSON.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || payload.jsonrpc !== '2.0' || payload.id !== 1 || payload.error !== undefined
    || typeof payload.result !== 'string') {
    throw new Error('GenLayer transaction status response is malformed.');
  }
  const status = payload.result.trim().toUpperCase();
  if (!GENLAYER_TRANSACTION_STATUSES.has(status)) {
    throw new Error(`GenLayer transaction status is unknown: ${status || '(empty)'}.`);
  }
  return status;
}

/**
 * Validate the receipt printed by `genlayer write`.
 *
 * The CLI can exit with status 0 even when GenVM reports FINISHED_WITH_ERROR,
 * so the execution result itself is the source of truth for success.
 */
export function parseGenlayerWriteOutput(output) {
  const text = asText(output).replace(ANSI_ESCAPE_PATTERN, '');
  const transactionHash = text.match(TRANSACTION_HASH_PATTERN)?.[1];
  if (!transactionHash) {
    throw new Error('GenLayer write did not report a transaction hash.');
  }

  const receipt = parseGenlayerReceiptOutput(text, { transactionHash });
  if (receipt.txExecutionResultName !== GENLAYER_SUCCESS_RESULT) {
    throw new Error(
      `GenLayer write ${transactionHash} failed with txExecutionResultName `
      + `${receipt.txExecutionResultName}.`,
    );
  }

  return Object.freeze({
    transactionHash,
    txExecutionResultName: receipt.txExecutionResultName,
  });
}

/**
 * Run a CLI command while preserving argument boundaries and exposing a write
 * hash as soon as the CLI prints it. The command does not resolve or stop the
 * child until a Promise returned by `onTransactionHash` settles, allowing a
 * keeper to durably bind the hash before this wrapper can exit.
 */
export function runGenlayerStreamingCommand({
  invocation,
  command,
  args = [],
  spawnImpl = nodeSpawn,
  onTransactionHash = () => {},
  writeStdout = (value) => process.stdout.write(value),
  writeStderr = (value) => process.stderr.write(value),
  stdin = 'inherit',
  stopAfterTransactionHash = false,
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(
        invocation.executable,
        [...invocation.prefixArgs, command, ...args],
        {
          shell: false,
          stdio: [stdin, 'pipe', 'pipe'],
          windowsHide: true,
        },
      );
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let transactionHash;
    let callbackError;
    let callbackPromise;
    let callbackSettled = false;
    let closeResult;
    let processError;
    let settled = false;

    const finish = () => {
      if (settled || (callbackPromise && !callbackSettled)) return;
      if (callbackError) {
        settled = true;
        reject(new GenlayerCommandError('Failed to persist the GenLayer transaction hash.', {
          code: 'HASH_PERSIST_FAILED',
          cause: callbackError,
          stdout,
          stderr,
          status: closeResult?.status,
          signal: closeResult?.signal,
          transactionHash,
        }));
        return;
      }
      if (processError) {
        settled = true;
        reject(new GenlayerCommandError(processError.message, {
          cause: processError,
          stdout,
          stderr,
          transactionHash,
        }));
        return;
      }
      if (!closeResult) return;
      const result = Object.freeze({
        status: closeResult.status,
        signal: closeResult.signal,
        stdout,
        stderr,
        output: `${stdout}\n${stderr}`,
        transactionHash,
      });
      settled = true;
      if (closeResult.status !== 0) {
        reject(new GenlayerCommandError(
          `GenLayer ${command} process exited with status ${closeResult.status ?? 'unknown'}.`,
          result,
        ));
        return;
      }
      resolve(result);
    };

    const inspectHash = () => {
      if (transactionHash || callbackError || callbackPromise) return;
      // stdout/stderr ordering is not defined; never synthesize a hash by
      // joining a label from one stream with bytes from the other.
      const detected = extractGenlayerTransactionHash(stdout)
        || extractGenlayerTransactionHash(stderr);
      if (!detected) return;
      transactionHash = detected;
      try {
        callbackPromise = Promise.resolve(onTransactionHash(detected));
        callbackPromise.then(
          () => {
            callbackSettled = true;
            // The CLI's write action waits for ACCEPTED after broadcasting.
            // Stop it only after the durable callback has bound the hash.
            if (stopAfterTransactionHash && !closeResult) child.kill?.();
            finish();
          },
          (error) => {
            callbackError = error;
            callbackSettled = true;
            if (!closeResult) child.kill?.();
            finish();
          },
        );
      } catch (error) {
        callbackError = error;
        callbackSettled = true;
        child.kill?.();
      }
    };

    child.stdout?.on('data', (chunk) => {
      const value = asText(chunk);
      stdout += value;
      writeStdout(value);
      inspectHash();
    });
    child.stderr?.on('data', (chunk) => {
      const value = asText(chunk);
      stderr += value;
      writeStderr(value);
      inspectHash();
    });
    child.once('error', (error) => {
      processError = error;
      finish();
    });
    child.once('close', (status, signal) => {
      inspectHash();
      closeResult = { status, signal };
      finish();
    });
  });
}

export async function submitGenlayerWrite({
  invocation,
  args,
  onTransactionHash,
  ...options
}) {
  try {
    const result = await runGenlayerStreamingCommand({
      invocation,
      command: 'write',
      args,
      onTransactionHash,
      ...options,
      stopAfterTransactionHash: options.stopAfterTransactionHash ?? true,
    });
    const transactionHash = result.transactionHash
      || extractGenlayerTransactionHash(result.output);
    if (!transactionHash) {
      throw new GenlayerCommandError('GenLayer write did not report a transaction hash.', result);
    }
    return Object.freeze({ ...result, transactionHash });
  } catch (error) {
    // Once a hash exists the submission is authoritative even if the CLI's
    // built-in receipt wait later exits non-zero. The keeper resumes that hash.
    if (
      error instanceof GenlayerCommandError
      && error.transactionHash
      && error.code !== 'HASH_PERSIST_FAILED'
    ) {
      return Object.freeze({
        status: error.status,
        signal: error.signal,
        stdout: error.stdout || '',
        stderr: error.stderr || '',
        output: `${error.stdout || ''}\n${error.stderr || ''}`,
        transactionHash: error.transactionHash,
        commandError: error.message,
      });
    }
    throw error;
  }
}

export async function waitForGenlayerFinalizedReceipt({
  invocation,
  transactionHash,
  retries = 900,
  intervalMs = 5_000,
  ...options
}) {
  const result = await runGenlayerStreamingCommand({
    invocation,
    command: 'receipt',
    args: [
      transactionHash,
      '--status',
      GENLAYER_FINALIZED_STATUS,
      '--retries',
      String(retries),
      '--interval',
      String(intervalMs),
    ],
    ...options,
  });
  return parseGenlayerReceiptOutput(result.output, { transactionHash });
}

export async function getGenlayerDecidedReceipt({
  invocation,
  transactionHash,
  ...options
}) {
  const result = await runGenlayerStreamingCommand({
    invocation,
    command: 'receipt',
    args: [
      transactionHash,
      '--status',
      'ACCEPTED',
      '--retries',
      '0',
      '--interval',
      '1',
    ],
    ...options,
  });
  return parseGenlayerReceiptOutput(result.output, {
    transactionHash,
    requireExecution: false,
  });
}

export async function runGenlayerCall({
  invocation,
  contractAddress,
  method,
  args = [],
  ...options
}) {
  const commandArgs = [contractAddress, method];
  if (args.length > 0) commandArgs.push('--args', ...args.map(String));
  const result = await runGenlayerStreamingCommand({
    invocation,
    command: 'call',
    args: commandArgs,
    ...options,
  });
  return parseGenlayerCallOutput(result.output);
}

/**
 * Resolve the GenLayer CLI without asking a command shell to parse arguments.
 * Windows npm shims are .cmd files, which Node cannot spawn directly with
 * shell:false on every supported Node release. Launching the shim's JS entry
 * with the current Node executable preserves argument boundaries and avoids
 * shell interpolation of round titles or source URLs.
 */
export function resolveGenlayerCommand({
  platform = process.platform,
  pathValue = process.env.PATH || '',
  nodeExecutable = process.execPath,
  isFile = existsSync,
  cwdValue = process.cwd(),
} = {}) {
  const localEntry = joinPath(cwdValue, 'node_modules', 'genlayer', 'dist', 'index.js');
  if (isFile(localEntry)) {
    return Object.freeze({ executable: nodeExecutable, prefixArgs: Object.freeze([localEntry]) });
  }
  if (platform !== 'win32') return Object.freeze({ executable: 'genlayer', prefixArgs: [] });

  for (const rawDirectory of pathValue.split(windowsPath.delimiter)) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '');
    if (!directory) continue;
    const shim = windowsPath.join(directory, 'genlayer.cmd');
    if (!isFile(shim)) continue;
    const packageRoot = windowsPath.basename(directory).toLowerCase() === '.bin'
      ? windowsPath.join(windowsPath.dirname(directory), 'genlayer')
      : windowsPath.join(directory, 'node_modules', 'genlayer');
    const entry = windowsPath.normalize(windowsPath.join(packageRoot, 'dist', 'index.js'));
    if (isFile(entry)) {
      return Object.freeze({ executable: nodeExecutable, prefixArgs: Object.freeze([entry]) });
    }
  }

  throw new Error('Unable to resolve the Windows GenLayer CLI entry from PATH.');
}
