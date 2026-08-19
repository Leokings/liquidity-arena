import { createPublicHistoryHandler } from '../history/http.mjs';
import { createNeonHistoryRepository } from '../history/repository.mjs';

const repository = createNeonHistoryRepository();
const handler = createPublicHistoryHandler({ repository });

export default handler;
