export class HistoryError extends Error {
  constructor(code, message, { statusCode = 400, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'HistoryError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function historyError(code, message, options) {
  throw new HistoryError(code, message, options);
}

export function publicHistoryError(error) {
  if (error instanceof HistoryError) {
    return Object.freeze({
      statusCode: error.statusCode,
      body: Object.freeze({ error: error.message, code: error.code }),
    });
  }
  return Object.freeze({
    statusCode: 500,
    body: Object.freeze({ error: 'History operation failed.', code: 'HISTORY_INTERNAL' }),
  });
}
