const MAX_READABLE_CALL_BYTES = 16 * 1024;
const MAX_READABLE_CALL_DEPTH = 16;
const MAX_READABLE_CALL_NODES = 256;
const MAX_NUMBER_TOKEN_CHARS = 128;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactArgument(value, label) {
  if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  throw new Error(`${label} contains a non-canonical argument.`);
}

function exactDecodedCall(value, label) {
  if (!isPlainObject(value) || value.type !== 'call' || !isPlainObject(value.callData)) {
    throw new Error(`${label} is not an exact decoded contract call.`);
  }
  if (Object.keys(value).sort().join(',') !== 'callData,type'
    || Object.keys(value.callData).sort().join(',') !== 'args,method') {
    throw new Error(`${label} contains unknown decoded call fields.`);
  }
  const { method, args } = value.callData;
  if (typeof method !== 'string' || method.trim() === '' || !Array.isArray(args)) {
    throw new Error(`${label} is not an exact decoded contract call.`);
  }
  return Object.freeze({
    method,
    args: Object.freeze(args.map((argument, index) => exactArgument(argument, `${label} args[${index}]`))),
  });
}

class GenLayerReadableCallParser {
  constructor(source) {
    if (typeof source !== 'string' || source.trim() === '') {
      throw new Error('GenLayer calldata.readable is missing.');
    }
    if (source.length > MAX_READABLE_CALL_BYTES
      || new TextEncoder().encode(source).byteLength > MAX_READABLE_CALL_BYTES) {
      throw new Error('GenLayer calldata.readable exceeds its byte limit.');
    }
    this.source = source;
    this.index = 0;
    this.nodes = 0;
    this.depth = 0;
    // GenVM ABI calldata uses canonical integer tokens. Preserve the token
    // byte-for-byte instead of accepting exponent/decimal spellings that
    // merely coerce to the same JavaScript number.
    this.numberPattern = /-?(?:0|[1-9]\d*)/y;
  }

  countNode() {
    this.nodes += 1;
    if (this.nodes > MAX_READABLE_CALL_NODES) {
      throw new Error('GenLayer calldata.readable has too many values.');
    }
  }

  withDepth(parse) {
    this.depth += 1;
    if (this.depth > MAX_READABLE_CALL_DEPTH) {
      throw new Error('GenLayer calldata.readable is nested too deeply.');
    }
    try {
      return parse();
    } finally {
      this.depth -= 1;
    }
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
    this.numberPattern.lastIndex = this.index;
    const match = this.numberPattern.exec(this.source);
    if (!match) throw new Error(`expected a number at offset ${this.index}`);
    if (match[0].length > MAX_NUMBER_TOKEN_CHARS) {
      throw new Error('GenLayer calldata.readable contains an oversized number.');
    }
    this.index = this.numberPattern.lastIndex;
    return match[0];
  }

  parseArray() {
    return this.withDepth(() => {
      this.consume('[');
      const result = [];
      while (this.peek() !== ']') {
        result.push(this.parseValue());
        if (this.peek() === ',') this.consume(',');
        else if (this.peek() !== ']') throw new Error(`expected comma at offset ${this.index}`);
      }
      this.consume(']');
      return result;
    });
  }

  parseObject() {
    return this.withDepth(() => {
      this.consume('{');
      const result = Object.create(null);
      while (this.peek() !== '}') {
        const key = this.parseString();
        this.consume(':');
        const value = this.parseValue();
        if (Object.hasOwn(result, key)) throw new Error(`duplicate object key: ${key}`);
        result[key] = value;
        // GenVM commonly omits this separator. If present, accept exactly one.
        if (this.peek() === ',') this.consume(',');
        if (this.peek() !== '}' && this.peek() !== '"') {
          throw new Error(`expected an object member at offset ${this.index}`);
        }
      }
      this.consume('}');
      return result;
    });
  }

  parseValue() {
    this.countNode();
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

function readableDecodedCall(receipt) {
  if (receipt.data === undefined) return null;
  if (!isPlainObject(receipt.data)) throw new Error('GenLayer receipt data is malformed.');
  if (receipt.data.calldata === undefined) return null;
  if (!isPlainObject(receipt.data.calldata)) {
    throw new Error('GenLayer receipt data.calldata is malformed.');
  }
  const parsed = new GenLayerReadableCallParser(receipt.data.calldata.readable).parseDocument();
  if (!isPlainObject(parsed)) {
    throw new Error('GenLayer calldata.readable is not a call object.');
  }
  return exactDecodedCall({ type: 'call', callData: parsed }, 'GenLayer calldata.readable');
}

function nativeDecodedCall(receipt) {
  const present = ['txDataDecoded', 'tx_data_decoded'].filter((name) => Object.hasOwn(receipt, name));
  if (present.length > 1) throw new Error('GenLayer receipt has ambiguous decoded call fields.');
  if (present.length === 0) return null;
  return exactDecodedCall(receipt[present[0]], 'GenLayer decoded call');
}

function sameCall(left, right) {
  return left.method === right.method
    && left.args.length === right.args.length
    && left.args.every((argument, index) => argument === right.args[index]);
}

export function decodeGenLayerReceiptCall(receipt) {
  if (!isPlainObject(receipt)) throw new Error('GenLayer receipt is malformed.');
  const native = nativeDecodedCall(receipt);
  const readable = readableDecodedCall(receipt);
  if (native && readable && !sameCall(native, readable)) {
    throw new Error('GenLayer receipt reports conflicting decoded call evidence.');
  }
  const call = native || readable;
  if (!call) throw new Error('GenLayer receipt has no exact decoded contract call.');
  return call;
}
