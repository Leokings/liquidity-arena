import { createBradburyHistoryChain } from '../history/chain.mjs';
import { loadHistoryChainConfiguration } from '../history/config.mjs';
import { createHistorySyncHandler } from '../history/http.mjs';
import { createNeonHistoryRepository } from '../history/repository.mjs';
import { createHistorySyncService } from '../history/sync-service.mjs';
import { vercelClientKey } from '../server/vercel-runtime.mjs';

const repository = createNeonHistoryRepository();
let service;

const handler = createHistorySyncHandler({
  environment: process.env,
  clientKey: vercelClientKey,
  service: Object.freeze({
    async sync(input) {
      service ||= createHistorySyncService({
        repository,
        chain: createBradburyHistoryChain({
          configuration: loadHistoryChainConfiguration(process.env),
        }),
      });
      return service.sync(input);
    },
  }),
});

export default handler;
