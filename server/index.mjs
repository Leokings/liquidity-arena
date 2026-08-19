import process from 'node:process';

import { loadServerConfig, startProductionServer } from './app.mjs';

async function main() {
  const config = loadServerConfig();
  const runtime = await startProductionServer({ config });
  const address = runtime.server.address();
  const listeningPort = typeof address === 'object' && address ? address.port : config.port;
  console.log(`Liquidity Arena listening on http://${config.host}:${listeningPort}`);

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    try {
      await runtime.close();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  };

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
