// Wiring only: build the app, honour $PORT, mount the API and the frontend,
// then migrate → listen → register. Feature logic lives in its own module.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './src/api.mjs';
import { migrate } from './src/migrate.mjs';
import { runRegistration } from './src/registration.mjs';
import { storeRoot } from './src/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// $PORT is conductor-allocated; defaulting our own keeps the plugin
// standalone-runnable, which is a compliance requirement.
const PORT = Number(process.env.PORT) || 4310;

const app = express();
app.use('/api', createApi());
// Relative asset URLs only, so the frontend is reachable under
// X-Forwarded-Prefix without knowing its own mount point.
app.use(express.static(path.join(HERE, 'frontend')));

// The migration runs BEFORE anything serves, so no request ever sees a record
// the readers do not understand.
await migrate({ log: msg => console.log(msg) });

const server = app.listen(PORT, () => {
  console.log(`code-system backend on :${PORT} (store: ${storeRoot()})`);
  // AFTER listen and never blocking startup: a conductor that cannot be reached
  // must not stop the plugin from serving its own UI.
  void runRegistration({ log: msg => console.log(msg) });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
