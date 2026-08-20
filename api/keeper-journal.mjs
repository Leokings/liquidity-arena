import { createKeeperJournalHandler } from '../keeper-journal/http.mjs';
import { createNeonKeeperJournalRepository } from '../keeper-journal/repository.mjs';
import { createKeeperJournalService } from '../keeper-journal/service.mjs';
import { vercelClientKey } from '../server/vercel-runtime.mjs';

const repository = createNeonKeeperJournalRepository();
const service = createKeeperJournalService({ repository });

export default createKeeperJournalHandler({
  service,
  environment: process.env,
  clientKey: vercelClientKey,
});
