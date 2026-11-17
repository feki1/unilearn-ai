import { fileURLToPath } from 'node:url';
import CONFIG from './config.js';
import { createApp } from './app.js';

export async function startServer({
  port = CONFIG.port,
  host = CONFIG.host,
  dbPath = CONFIG.dbPath,
  dataDir = CONFIG.dataDir,
  seed = true
} = {}) {
  const instance = createApp({ dbPath, dataDir, seed });
  await new Promise((resolve, reject) => {
    instance.server.once('error', reject);
    instance.server.listen(port, host, () => {
      instance.server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = instance.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    ...instance,
    port: actualPort,
    baseUrl: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`
  };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  startServer()
    .then(({ baseUrl }) => {
      console.log(`UniLearn AI (Horizon State University) listening on ${baseUrl}`);
    })
    .catch((err) => {
      console.error('Failed to start UniLearn AI server:', err);
      process.exit(1);
    });
}

export default startServer;
