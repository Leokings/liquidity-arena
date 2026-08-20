export class KeeperJournalError extends Error {
  constructor(code, message, { statusCode = 500, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'KeeperJournalError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function keeperJournalError(code, message, options) {
  throw new KeeperJournalError(code, message, options);
}

export function publicKeeperJournalError(error) {
  if (error instanceof KeeperJournalError) {
    return Object.freeze({
      statusCode: error.statusCode,
      body: Object.freeze({ error: error.message, code: error.code }),
    });
  }
  return Object.freeze({
    statusCode: 500,
    body: Object.freeze({
      error: 'Keeper transaction journal operation failed.',
      code: 'KEEPER_JOURNAL_INTERNAL',
    }),
  });
}
