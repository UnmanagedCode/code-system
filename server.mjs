// Wiring only: migrate → build the app → listen on loopback → register.
// Feature logic lives in its own module; the HTTP app is src/http.mjs.

import { createApp } from './src/http.mjs';
import { migrate } from './src/migrate.mjs';
import { runRegistration } from './src/registration.mjs';
import { storeRoot } from './src/paths.mjs';

// $PORT is conductor-allocated; defaulting our own keeps the plugin
// standalone-runnable, which is a compliance requirement.
const PORT = Number(process.env.PORT) || 4310;

// The migration runs BEFORE anything serves, so no request ever sees a record
// the readers do not understand.
await migrate({ log: msg => console.log(msg) });

const app = createApp();
// LOOPBACK ONLY: the API has no authentication, and cc's proxy reaches the
// backend over loopback.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`code-system backend on 127.0.0.1:${PORT} (store: ${storeRoot()})`);
  // AFTER listen and never blocking startup: a conductor that cannot be reached
  // must not stop the plugin from serving its own UI.
  void runRegistration({ log: msg => console.log(msg) });
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { server.close(() => process.exit(0)); });
}
