import { createApp } from './server.js';
import { logger } from './lib/logger.js';

const port = Number.parseInt(process.env.PORT ?? '4000', 10);
const app = createApp();
app.listen(port, () => {
  logger.info({ port }, 'api listening');
});
