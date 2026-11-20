// Talking TO the broker over its unix socket — the one way anything outside it
// learns what it knows. Used by the backend's supervisor, the agent kind's
// `reachability`, and the API's broker route. A socket that answers is the only
// evidence a broker is alive: a file it wrote would outlive a SIGKILL.

import { promises as fs } from 'node:fs';
import net from 'node:net';
import { agentErrorPath } from '../paths.mjs';
import { LineDecoder, PROTOCOL, encode } from './protocol.mjs';

export class BrokerDown extends Error {}

/**
 * One request, one answer. Rejects with BrokerDown when nothing listens on the
 * socket (absent, refused, or a stale file), and with a plain Error on a
 * timeout or an unreadable answer.
 * @returns {Promise<object>}
 */
export function queryBroker(socketPath, frame, { timeoutMs = 2000 } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const decoder = new LineDecoder(PROTOCOL.maxFrameBytes);
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err); else resolve(val);
    };
    const timer = setTimeout(() => done(new Error(`the agent listener did not answer within ${timeoutMs} ms`)), timeoutMs);
    timer.unref?.();
    sock.on('connect', () => sock.write(encode(frame)));
    sock.on('data', (chunk) => {
      let lines;
      try { lines = decoder.push(chunk); }
      catch (e) { done(e); return; }
      if (lines.length) {
        try { done(null, JSON.parse(lines[0].toString('utf8'))); }
        catch { done(new Error('the agent listener answered something that is not JSON')); }
      }
    });
    sock.on('error', (e) => {
      if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(e.code)) done(new BrokerDown('the agent listener is not running'));
      else done(e);
    });
    sock.on('close', () => done(new BrokerDown('the agent listener closed the connection without answering')));
  });
}

/** The startup failure a broker left behind, or null. */
export async function readBrokerError(dir) {
  try {
    const parsed = JSON.parse(await fs.readFile(agentErrorPath(dir), 'utf8'));
    if (parsed && typeof parsed.message === 'string') {
      return { at: typeof parsed.at === 'string' ? parsed.at : null, message: parsed.message };
    }
  } catch { /* absent or unreadable: no recorded failure */ }
  return null;
}

/**
 * Make the agent directory if absent (0700), and answer why it cannot be used,
 * or null. A directory that exists with the wrong owner or a group/other bit is
 * REFUSED, never repaired: someone else's directory, or one others can write,
 * is where a socket impersonating the broker would be planted.
 */
export async function ensureAgentDir(dir) {
  try { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); }
  catch (e) { return `cannot create the agent directory ${dir}: ${e.message}`; }
  let st;
  try { st = await fs.lstat(dir); }
  catch (e) { return `cannot inspect the agent directory ${dir}: ${e.message}`; }
  if (!st.isDirectory()) return `${dir} is not a directory`;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    return `the agent directory ${dir} is owned by uid ${st.uid}, not this user — refusing to use it`;
  }
  if ((st.mode & 0o077) !== 0) {
    return `the agent directory ${dir} has mode ${(st.mode & 0o777).toString(8)}; it must be 700 — refusing to use it`;
  }
  return null;
}
