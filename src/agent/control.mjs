// THE BROKER'S UNIX SOCKET: how a bridge opens a stream and how everything else
// asks the broker what it knows. The first frame chooses the mode — `open`
// turns the connection into ONE STREAM for the rest of its life; `status`,
// `ping`, `stop` and `refusals` are one request and one answer.

import net from 'node:net';
import { BRIDGE_TAGS, LineDecoder, PROTOCOL, decodeLine, encode } from './protocol.mjs';

const CONTROL = PROTOCOL.control;
const STREAM_IN = new Set(['in', 'eof', 'ack', 'resize']);

/**
 * @param {{broker:{ping():object, status(id:string):object, refusals():object[],
 *          stop():void, sessionFor(id:string):import('./session.mjs').AgentSession|undefined,
 *          refusalNote(id:string):string}, log:(m:string)=>void}} o
 */
export function createControlServer({ broker, log }) {
  return net.createServer((conn) => {
    const decoder = new LineDecoder(PROTOCOL.maxFrameBytes);
    let stream = null;
    conn.on('error', () => {});
    const reply = (frame) => { conn.end(encode(frame)); };

    conn.on('data', (chunk) => {
      let lines;
      try { lines = decoder.push(chunk); }
      catch (e) { reply({ t: 'error', message: e.message }); conn.destroy(); return; }
      for (const line of lines) {
        let f;
        try { f = decodeLine(line, CONTROL); }
        catch (e) {
          if (stream) stream.abort(`bad frame from the bridge: ${e.message}`);
          else reply({ t: 'error', message: e.message });
          return;
        }
        if (stream) {
          if (!STREAM_IN.has(f.t)) { stream.abort(`'${f.t}' is not a stream frame`); return; }
          stream.fromBridge(f);
          continue;
        }
        switch (f.t) {
          case 'ping': reply({ t: 'pong', ...broker.ping() }); return;
          case 'status': reply({ t: 'status', ...broker.status(f.remoteId) }); return;
          case 'refusals': reply({ t: 'refusals', items: broker.refusals() }); return;
          case 'stop': reply({ t: 'stopping' }); broker.stop(); return;
          case 'open': stream = openStream(conn, f, broker, log); if (!stream) return; continue;
          default: reply({ t: 'error', message: `'${f.t}' cannot open a control connection` }); return;
        }
      }
    });
  });
}

// One bridge ⇄ one far-side command. Returns null when the open was refused
// (the refusal has been written and the connection ended).
function openStream(conn, f, broker, log) {
  const session = broker.sessionFor(f.remoteId);
  const refuse = (tag, message) => { conn.end(encode({ t: 'refused', tag, message })); return null; };
  if (!session) {
    return refuse(BRIDGE_TAGS.notConnected,
      `no agent is connected for remote '${f.remoteId}'${broker.refusalNote(f.remoteId)}`);
  }
  // The key id the bridge carries is derived from the CURRENT config, so a
  // session still authenticated with a previous secret is never used.
  if (session.keyId !== f.keyId) {
    return refuse(BRIDGE_TAGS.staleKey,
      `the agent connected for remote '${f.remoteId}' authenticated with a previous secret`
      + ' — restart it with the current one');
  }
  if (session.full) {
    return refuse(BRIDGE_TAGS.tooManyStreams,
      `the agent for remote '${f.remoteId}' already runs ${PROTOCOL.maxStreamsPerSession} commands`
      + ' at once, which is the most one agent session carries');
  }
  let s = null;
  let finished = false;
  const link = {
    deliver(frame) {
      if (finished) return;
      if (frame.t === 'exit' || frame.t === 'failed') {
        finished = true;
        conn.end(encode(frame));
      } else {
        conn.write(encode(frame));
      }
    },
    lost(tag, message) {
      if (finished) return;
      finished = true;
      conn.end(encode({ t: 'lost', tag, message }));
    },
  };
  s = session.openStream(link, { argv: f.argv, cwd: f.cwd, env: f.env, stdin: f.stdin, pty: f.pty });
  conn.on('close', () => {
    if (!finished) {
      finished = true;
      session.closeStream(s);
    }
  });
  return {
    fromBridge(frame) { if (!finished) session.fromBridge(s, frame); },
    abort(message) {
      log(`stream ${s} for '${f.remoteId}': ${message}`);
      if (!finished) { finished = true; session.closeStream(s); }
      conn.destroy();
    },
  };
}
