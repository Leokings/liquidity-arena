import { createHistoryHealthHandler } from '../history/http.mjs';
import { createNeonHistoryRepository } from '../history/repository.mjs';

const repository = createNeonHistoryRepository();
const handler = createHistoryHealthHandler({ repository });

export default handler;
