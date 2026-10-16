// The HTTP app: headers, the API, the built UI, and the plain-text tail.
// server.mjs builds it and listens; tests build it over a fixture dist.

import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_DIST = path.join(REPO, 'frontend', 'dist');

// plugin-ui.md Part 2's minimum, plus `style-src 'unsafe-inline'` for Radix
// Dialog: its scroll lock injects a <style> element. Nothing of ours emits a
// style attribute or element from content (tests/frontend.test.mjs).
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self';"
  + " connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";

export const NOT_BUILT = 'UI not built — run npm install';

/**
 * @param {{api?: import('express').Router, distDir?: string, log?: (msg: string) => void}} [opts]
 */
export function createApp({ api = createApi(), distDir = DEFAULT_DIST, log = console.error } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // FIRST, outside the built check: the API, the 404, the 503 and the error
  // tail all carry the policy too.
  app.use((_req, res, next) => {
    res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  app.use('/api', api);

  const indexHtml = path.join(distDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    // `redirect: false`: a directory such as /assets is a 404 like any other
    // unknown path, not a 301 to /assets/.
    app.use(express.static(distDir, { redirect: false }));
  } else {
    // START ANYWAY: cc can start the plugin after a failed or skipped build and
    // says nothing, so the backend says it — readable, and not HTML.
    log(`UI not built: ${indexHtml} is missing — run npm install`);
    app.use((_req, res) => { res.status(503).type('text/plain').send(NOT_BUILT); });
  }

  // NO SPA FALLBACK: an unknown path is a 404, so the two host URLs 404
  // standalone and routes live in the query string. Express's own 404 and
  // error pages would replace our CSP, hence the explicit tail.
  app.use((_req, res) => { res.status(404).type('text/plain').send('Not found'); });
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    log(err instanceof Error ? (err.stack ?? err.message) : String(err));
    const status = Number(err?.status ?? err?.statusCode) || 500;
    res.status(status).type('text/plain').send(status === 500 ? 'Internal error' : String(err?.message ?? ''));
  });
  return app;
}
