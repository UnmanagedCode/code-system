// THE BROKER'S TCP PORT, before authentication: the pre-auth caps, the
// `GET /agent.py` sniff, and the handshake. A connection that completes the
// handshake is handed to an AgentSession and never comes back here.
//
// The agent SPEAKS FIRST, which is what lets one port serve both: a first line
// that is an HTTP request line is answered as HTTP, anything else must be a
// `hello`.

import net from 'node:net';
import { AgentSession } from './session.mjs';
import {
  LABELS, LineDecoder, PROTOCOL, REFUSAL, decodeLine, encode, keyIdOf, mac, newNonce, newSessionId, verifyMac,
} from './protocol.mjs';

const WIRE = PROTOCOL.wire;
const REQUEST_LINE_RE = /^([A-Z]+) (\S+) HTTP\/1\.[01]\r?$/;
const GENERIC_AUTH_FAILURE = 'authentication failed — check the remote id and its secret on the card';

/**
 * @param {{broker:{lookupSecret(id:string):Promise<{secret:string}|{reason:string}>,
 *          recordRefusal(r:{remoteId:string, reason:string, peer:string}):void,
 *          adopt(s:AgentSession):void, agentBytes:Buffer}, tim:object, log:(m:string)=>void}} o
 */
export function createListener({ broker, tim, log }) {
  let pending = 0;
  return net.createServer((socket) => {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    if (pending >= PROTOCOL.maxPendingHandshakes) {
      socket.on('error', () => {});
      socket.end(encode({ t: 'refused', code: REFUSAL.busy, message: 'too many connections are mid-handshake' }));
      socket.destroy();
      return;
    }
    pending += 1;
    let counted = true;
    const release = () => { if (counted) { counted = false; pending -= 1; } };
    socket.on('close', release);
    socket.on('error', () => {});

    const decoder = new LineDecoder(PROTOCOL.maxPreauthLineBytes);
    const timer = setTimeout(() => {
      fail(REFUSAL.timeout, `the handshake did not complete within ${tim.handshakeTimeoutMs} ms`);
    }, tim.handshakeTimeoutMs);
    timer.unref?.();

    let state = 'first';
    let http = null;
    let hello = null;
    let nb = null;
    let busy = false;
    const queue = [];

    function fail(code, message) {
      clearTimeout(timer);
      state = 'done';
      if (!socket.destroyed) socket.end(encode({ t: 'refused', code, message }));
      setTimeout(() => socket.destroy(), 200).unref?.();
    }

    const onData = (chunk) => {
      let lines;
      try { lines = decoder.push(chunk); }
      catch (e) {
        if (http) { httpAnswer(431, 'text/plain', 'request header too large\n'); return; }
        fail(REFUSAL.badFrame, e.message); return;
      }
      queue.push(...lines);
      void drain();
    };
    socket.on('data', onData);

    async function drain() {
      if (busy) return;
      busy = true;
      try {
        while (queue.length && state !== 'done' && state !== 'session') {
          await step(queue.shift());
        }
      } finally { busy = false; }
    }

    function httpAnswer(status, type, body) {
      clearTimeout(timer);
      state = 'done';
      const reason = { 200: 'OK', 404: 'Not Found', 405: 'Method Not Allowed', 431: 'Request Header Fields Too Large' }[status];
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
      socket.end(Buffer.concat([
        Buffer.from(`HTTP/1.1 ${status} ${reason}\r\nContent-Type: ${type}\r\nContent-Length: ${bytes.length}\r\n`
          + 'Cache-Control: no-store\r\nConnection: close\r\n\r\n', 'latin1'),
        bytes,
      ]));
    }

    async function step(line) {
      if (state === 'first') {
        const m = REQUEST_LINE_RE.exec(line.toString('latin1'));
        if (m) {
          http = { method: m[1], path: m[2], headerBytes: 0 };
          decoder.cap = PROTOCOL.maxHttpHeaderBytes;
          state = 'headers';
          return;
        }
        state = 'hello';
      }
      if (state === 'headers') {
        http.headerBytes += line.length + 1;
        if (http.headerBytes > PROTOCOL.maxHttpHeaderBytes) { httpAnswer(431, 'text/plain', 'request header too large\n'); return; }
        if (line.length > 0 && !(line.length === 1 && line[0] === 13)) return;
        if (http.method !== 'GET') { httpAnswer(405, 'text/plain', 'only GET /agent.py is served here\n'); return; }
        if (http.path !== '/agent.py') { httpAnswer(404, 'text/plain', 'not found — this port serves GET /agent.py\n'); return; }
        log(`served agent.py to ${peer}`);
        httpAnswer(200, 'text/x-python; charset=utf-8', broker.agentBytes);
        return;
      }
      let f;
      try { f = decodeLine(line, WIRE); }
      catch (e) { fail(REFUSAL.badFrame, e.message); return; }

      if (state === 'hello') {
        if (f.t !== 'hello') { fail(REFUSAL.badFrame, `expected hello, got '${f.t}'`); return; }
        if (f.v !== PROTOCOL.version) {
          fail(REFUSAL.versionMismatch, `this listener speaks agent protocol ${PROTOCOL.version} and the agent speaks`
            + ` ${f.v} — fetch the agent again: curl -fsS http://<this address>/agent.py`);
          return;
        }
        hello = f;
        nb = newNonce();
        state = 'auth';
        // ALWAYS SENT, whether or not the remote exists: answering differently
        // here would tell a stranger which remote ids are real.
        socket.write(encode({ t: 'challenge', nonce: nb }));
        return;
      }
      if (state === 'auth') {
        if (f.t !== 'auth') { fail(REFUSAL.badFrame, `expected auth, got '${f.t}'`); return; }
        const remoteId = hello.remoteId;
        const na = hello.nonce;
        // RE-READ ON EVERY HANDSHAKE, never cached: a rotated secret takes
        // effect for the next agent that dials.
        socket.pause();
        const found = await broker.lookupSecret(remoteId);
        socket.resume();
        if (state === 'done') return;
        const ok = 'secret' in found && verifyMac(found.secret, [LABELS.agent, remoteId, nb, na], f.mac);
        if (!ok) {
          // ONE ANSWER ON THE WIRE for all three causes; the true one is kept
          // locally, where the card and the page can show it.
          broker.recordRefusal({ remoteId, reason: 'secret' in found ? 'wrong-secret' : found.reason, peer });
          fail(REFUSAL.authFailed, GENERIC_AUTH_FAILURE);
          return;
        }
        clearTimeout(timer);
        const sessionId = newSessionId();
        socket.write(encode({
          t: 'welcome', session: sessionId, mac: mac(found.secret, [LABELS.broker, remoteId, nb, na, sessionId]),
        }));
        state = 'session';
        release();
        socket.off('data', onData);
        const session = new AgentSession({
          socket, decoder, remoteId, sessionId, keyId: keyIdOf(found.secret), peer, tim, log,
          onEnd: s => broker.forget(s),
        });
        broker.adopt(session);
        session.feedLines(queue.splice(0));
      }
    }
  });
}
