// ONE AUTHENTICATED AGENT, broker side: the stream multiplexer over its TCP
// connection, the keepalive, and the three ways a session ends (replaced by a
// newer one, dropped for a stale key, lost).
//
// The broker relays; it does not buffer. Every `out` and `in` is bounded by the
// per-stream credit the two END POINTS exchange (agent ⇄ bridge), and this
// module only rewrites the stream id on the way through.

import { BRIDGE_TAGS, BYE, BadFrame, LineDecoder, PROTOCOL, decodeLine, encode } from './protocol.mjs';

const WIRE = PROTOCOL.wire;

// Frames a stream link receives, with `s` removed.
const TO_BRIDGE = new Set(['started', 'failed', 'out', 'exit', 'ack']);

export class AgentSession {
  /**
   * @param {{socket:import('node:net').Socket, decoder:LineDecoder, remoteId:string,
   *          sessionId:string, keyId:string, peer:string, tim:object,
   *          log:(m:string)=>void, onEnd:(s:AgentSession)=>void}} o
   */
  constructor({ socket, decoder, remoteId, sessionId, keyId, peer, tim, log, onEnd }) {
    this.socket = socket;
    this.remoteId = remoteId;
    this.sessionId = sessionId;
    this.keyId = keyId;
    this.peer = peer;
    this.since = new Date().toISOString();
    this.info = null;
    this.ended = false;
    this.streams = new Map();
    this.#decoder = decoder;
    this.#decoder.cap = PROTOCOL.maxFrameBytes;
    this.#tim = tim;
    this.#log = log;
    this.#onEnd = onEnd;
    this.#lastRx = Date.now();
    socket.setKeepAlive(true);
    socket.on('data', chunk => this.#onData(chunk));
    socket.on('error', () => {});
    socket.on('close', () => this.end('lost', 'the connection closed'));
    this.#timer = setInterval(() => this.#keepalive(), tim.pingIntervalMs);
    this.#timer.unref?.();
  }

  #decoder;
  #tim;
  #log;
  #onEnd;
  #lastRx;
  #timer;
  #nextS = 1;

  #keepalive() {
    if (Date.now() - this.#lastRx > this.#tim.keepaliveTimeoutMs) {
      this.end(BYE.keepalive, `no frame from the agent for ${this.#tim.keepaliveTimeoutMs} ms`);
      return;
    }
    this.send({ t: 'ping' });
  }

  send(frame) {
    if (this.ended) return;
    this.socket.write(encode(frame));
  }

  /** Lines the listener already split off the socket after the handshake. */
  feedLines(lines) {
    for (const line of lines) {
      if (this.ended) return;
      this.#onLine(line);
    }
  }

  #onData(chunk) {
    this.#lastRx = Date.now();
    let lines;
    try { lines = this.#decoder.push(chunk); }
    catch (e) { this.#bad(e); return; }
    this.feedLines(lines);
  }

  #bad(e) {
    this.end(BYE.shutdown, `bad frame from the agent: ${e.message}`);
  }

  #onLine(line) {
    let f;
    try { f = decodeLine(line, WIRE); }
    catch (e) { this.#bad(e); return; }
    switch (f.t) {
      case 'ping': this.send({ t: 'pong' }); return;
      case 'pong': return;
      case 'info':
        if (this.info === null) {
          this.info = { host: f.host, python: f.python, pid: f.pid, agentVersion: f.agentVersion };
        }
        return;
      case 'bye': this.end('lost', `the agent ended the session (${f.code}: ${f.message})`, { quiet: true }); return;
      default:
        if (TO_BRIDGE.has(f.t)) { this.#toBridge(f); return; }
        this.#bad(new BadFrame(`the agent sent '${f.t}', which an agent never sends`));
    }
  }

  #toBridge(f) {
    const link = this.streams.get(f.s);
    if (!link) return;
    const { s, ...rest } = f;
    if (f.t === 'exit' || f.t === 'failed') this.streams.delete(s);
    link.deliver(rest);
  }

  get full() { return this.streams.size >= PROTOCOL.maxStreamsPerSession; }

  /**
   * Open one far-side command for a bridge link. The link gets every frame for
   * its stream (without `s`) through `deliver`, and `lost(message)` if the
   * session ends first.
   * @returns {number} the stream id
   */
  openStream(link, { argv, cwd, env, stdin, pty }) {
    const s = this.#nextS++;
    this.streams.set(s, link);
    this.send({ t: 'open', s, argv, cwd, env, stdin, ...(pty ? { pty } : {}) });
    return s;
  }

  /** A frame from a bridge (in/eof/ack/resize), for stream `s`. */
  fromBridge(s, frame) {
    if (!this.streams.has(s)) return;
    this.send({ ...frame, s });
  }

  /** The bridge went away: tell the agent, which closes stdin and kills nothing. */
  closeStream(s) {
    if (!this.streams.delete(s)) return;
    this.send({ t: 'close', s });
  }

  /**
   * End the session. `code` is a bye code (`replaced`, `stale-key`,
   * `shutdown`, `keepalive`) or `lost` for a connection that is already gone.
   * Every attached bridge is told the agent is gone.
   */
  end(code, message, { quiet = false } = {}) {
    if (this.ended) return;
    if (code !== 'lost' && !quiet) {
      try { this.socket.write(encode({ t: 'bye', code, message })); } catch { /* gone */ }
    }
    this.ended = true;
    clearInterval(this.#timer);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
    this.#log(`session ${this.sessionId} for '${this.remoteId}' ended (${code}): ${message}`);
    const why = code === BYE.staleKey
      ? `the secret of remote '${this.remoteId}' changed, so its agent was disconnected`
      : `the agent for remote '${this.remoteId}' disconnected while the command ran (${message})`
        + ' — the agent ends its commands when that happens';
    for (const link of this.streams.values()) link.lost(code === BYE.staleKey ? BRIDGE_TAGS.staleKey : BRIDGE_TAGS.lost, why);
    this.streams.clear();
    this.#onEnd(this);
  }
}
