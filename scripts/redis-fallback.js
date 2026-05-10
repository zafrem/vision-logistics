#!/usr/bin/env node
/**
 * In-process fallback Redis server with proper RESP2 protocol support.
 *
 * Implements every command the Vision-Logistics application uses:
 *   PING, SELECT, EXPIRE, HSET, HGETALL,
 *   ZINCRBY, ZADD, ZRANGE (+WITHSCORES), ZREM,
 *   KEYS, LPUSH, LTRIM, LRANGE, XADD,
 *   PUBLISH, MULTI, EXEC
 *
 * Run standalone:
 *   REDIS_FALLBACK_PORT=6380 node scripts/redis-fallback.js
 */

import { createServer } from 'net';

const PORT = parseInt(process.env.REDIS_FALLBACK_PORT) || 6380;

// ── In-memory store ─────────────────────────────────────────────────────────

const hashes   = new Map(); // key → Map<field, value>
const sortedSets = new Map(); // key → Map<member, score>
const lists    = new Map(); // key → string[]
const streams  = new Map(); // key → [{id, fields}]

// ── RESP2 encoding helpers ───────────────────────────────────────────────────

function ok()        { return '+OK\r\n'; }
function pong()      { return '+PONG\r\n'; }
function queued()    { return '+QUEUED\r\n'; }
function integer(n)  { return `:${n}\r\n`; }
function bulkStr(s)  {
  if (s === null || s === undefined) return '$-1\r\n';
  const str = String(s);
  return `$${str.length}\r\n${str}\r\n`;
}
function array(items) {
  if (!items || items.length === 0) return '*0\r\n';
  return `*${items.length}\r\n` + items.map(bulkStr).join('');
}
function nullArray() { return '*-1\r\n'; }

// ── RESP2 parser ─────────────────────────────────────────────────────────────
//
// The Node.js redis v4 client sends commands as RESP2 multi-bulk arrays:
//   *N\r\n$L1\r\narg1\r\n$L2\r\narg2\r\n...
//
// A single TCP packet may contain multiple pipelined commands.
// A command may arrive split across multiple packets.

class RESPParser {
  constructor() {
    this.buf = '';
  }

  feed(chunk) {
    this.buf += chunk.toString('binary'); // binary preserves byte values
    return this.parse();
  }

  parse() {
    const cmds = [];
    while (this.buf.startsWith('*')) {
      const cmd = this.readArray();
      if (cmd === null) break; // incomplete — wait for more data
      cmds.push(cmd);
    }
    // Discard any leading garbage (inline commands, empty lines)
    if (!this.buf.startsWith('*') && this.buf.length > 0) {
      const next = this.buf.indexOf('*');
      this.buf = next === -1 ? '' : this.buf.slice(next);
    }
    return cmds;
  }

  readArray() {
    const eol = this.buf.indexOf('\r\n');
    if (eol === -1) return null;
    const count = parseInt(this.buf.slice(1, eol));
    let pos = eol + 2;
    const args = [];
    for (let i = 0; i < count; i++) {
      if (pos >= this.buf.length) return null;
      if (this.buf[pos] !== '$') return null;
      const lenEnd = this.buf.indexOf('\r\n', pos);
      if (lenEnd === -1) return null;
      const len = parseInt(this.buf.slice(pos + 1, lenEnd));
      pos = lenEnd + 2;
      if (pos + len + 2 > this.buf.length) return null;
      args.push(this.buf.slice(pos, pos + len));
      pos += len + 2;
    }
    this.buf = this.buf.slice(pos);
    return args;
  }
}

// ── Pattern matching for KEYS ────────────────────────────────────────────────

function globToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// ── Command handlers ─────────────────────────────────────────────────────────

function handleCommand(args) {
  const cmd = args[0].toUpperCase();

  switch (cmd) {
    case 'PING':
      return args[1] ? bulkStr(args[1]) : pong();

    case 'SELECT':
      return ok(); // single-database — silently accept any DB number

    case 'EXPIRE':
      return integer(1); // we don't evict, just acknowledge

    // ── Hash commands ──────────────────────────────────────────────────────

    case 'HSET': {
      const key = args[1];
      if (!hashes.has(key)) hashes.set(key, new Map());
      const h = hashes.get(key);
      let added = 0;
      for (let i = 2; i + 1 < args.length; i += 2) {
        if (!h.has(args[i])) added++;
        h.set(args[i], args[i + 1]);
      }
      return integer(added);
    }

    case 'HGETALL': {
      const h = hashes.get(args[1]);
      if (!h || h.size === 0) return array([]);
      const flat = [];
      for (const [f, v] of h) { flat.push(f); flat.push(v); }
      return array(flat);
    }

    // ── Sorted-set commands ────────────────────────────────────────────────

    case 'ZADD': {
      const key = args[1];
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      const zs = sortedSets.get(key);
      // args: key score member  (skip optional flags like NX/XX/GT/LT)
      let added = 0;
      let i = 2;
      while (i < args.length) {
        const maybeFlag = args[i].toUpperCase();
        if (['NX','XX','GT','LT','CH','INCR'].includes(maybeFlag)) { i++; continue; }
        const score = parseFloat(args[i]);
        const member = args[i + 1];
        if (!isNaN(score) && member !== undefined) {
          if (!zs.has(member)) added++;
          zs.set(member, score);
          i += 2;
        } else {
          i++;
        }
      }
      return integer(added);
    }

    case 'ZINCRBY': {
      const key = args[1];
      const increment = parseFloat(args[2]);
      const member = args[3];
      if (!sortedSets.has(key)) sortedSets.set(key, new Map());
      const zs = sortedSets.get(key);
      const prev = zs.get(member) ?? 0;
      const next = prev + increment;
      zs.set(member, next);
      return bulkStr(String(next));
    }

    case 'ZRANGE': {
      const key = args[1];
      const withScores = args.some(a => a.toUpperCase() === 'WITHSCORES');
      const zs = sortedSets.get(key);
      if (!zs) return array([]);

      // Sort by score ascending
      const sorted = [...zs.entries()].sort((a, b) => a[1] - b[1]);

      let start = parseInt(args[2]);
      let stop  = parseInt(args[3]);
      const len = sorted.length;
      if (start < 0) start = Math.max(0, len + start);
      if (stop  < 0) stop  = len + stop;
      stop = Math.min(stop, len - 1);

      const slice = sorted.slice(start, stop + 1);
      if (!withScores) return array(slice.map(([m]) => m));
      const flat = [];
      for (const [m, s] of slice) { flat.push(m); flat.push(String(s)); }
      return array(flat);
    }

    case 'ZRANGEBYSCORE': {
      const key = args[1];
      const withScores = args.some(a => a.toUpperCase() === 'WITHSCORES');
      const zs = sortedSets.get(key);
      if (!zs) return array([]);
      const minVal = args[2] === '-inf' ? -Infinity : parseFloat(args[2]);
      const maxVal = args[3] === '+inf' ?  Infinity : parseFloat(args[3]);
      const sorted = [...zs.entries()]
        .sort((a, b) => a[1] - b[1])
        .filter(([, s]) => s >= minVal && s <= maxVal);
      if (!withScores) return array(sorted.map(([m]) => m));
      const flat = [];
      for (const [m, s] of sorted) { flat.push(m); flat.push(String(s)); }
      return array(flat);
    }

    case 'ZREM': {
      const key = args[1];
      const zs = sortedSets.get(key);
      if (!zs) return integer(0);
      let removed = 0;
      for (let i = 2; i < args.length; i++) {
        if (zs.delete(args[i])) removed++;
      }
      return integer(removed);
    }

    // ── List commands ──────────────────────────────────────────────────────

    case 'LPUSH': {
      const key = args[1];
      if (!lists.has(key)) lists.set(key, []);
      const l = lists.get(key);
      for (let i = 2; i < args.length; i++) l.unshift(args[i]);
      return integer(l.length);
    }

    case 'LTRIM': {
      const key = args[1];
      if (!lists.has(key)) return ok();
      const l = lists.get(key);
      let start = parseInt(args[2]);
      let stop  = parseInt(args[3]);
      const len = l.length;
      if (start < 0) start = Math.max(0, len + start);
      if (stop  < 0) stop  = len + stop;
      lists.set(key, l.slice(start, stop + 1));
      return ok();
    }

    case 'LRANGE': {
      const key = args[1];
      const l = lists.get(key) ?? [];
      let start = parseInt(args[2]);
      let stop  = parseInt(args[3]);
      const len = l.length;
      if (start < 0) start = Math.max(0, len + start);
      if (stop  < 0) stop  = len + stop;
      return array(l.slice(start, stop + 1));
    }

    // ── Stream commands ────────────────────────────────────────────────────

    case 'XADD': {
      const key = args[1];
      // args[2] is the id ('*' for auto)
      if (!streams.has(key)) streams.set(key, []);
      const s = streams.get(key);
      const id = `${Date.now()}-${s.length}`;
      const fields = new Map();
      for (let i = 3; i + 1 < args.length; i += 2) fields.set(args[i], args[i + 1]);
      s.push({ id, fields });
      return bulkStr(id);
    }

    // ── Pub/Sub (no real subscribers in the fallback — just acknowledge) ──

    case 'PUBLISH':
      return integer(0);

    // ── Key commands ───────────────────────────────────────────────────────

    case 'KEYS': {
      const pattern = args[1] ?? '*';
      const re = globToRegex(pattern);
      const keys = [
        ...hashes.keys(),
        ...sortedSets.keys(),
        ...lists.keys(),
        ...streams.keys(),
      ].filter((k, i, a) => a.indexOf(k) === i && re.test(k)); // unique
      return array(keys);
    }

    case 'DEL': {
      let count = 0;
      for (let i = 1; i < args.length; i++) {
        const k = args[i];
        if (hashes.delete(k) || sortedSets.delete(k) || lists.delete(k) || streams.delete(k)) count++;
      }
      return integer(count);
    }

    // ── Transaction commands ───────────────────────────────────────────────
    // Handled at the connection level; these are placeholders.
    case 'MULTI':
      return ok();

    case 'EXEC':
      return nullArray(); // connection handler overrides this

    case 'DISCARD':
      return ok();

    default:
      return ok();
  }
}

// ── Connection handler ───────────────────────────────────────────────────────

const server = createServer((socket) => {
  const parser = new RESPParser();
  let inMulti = false;
  let queue = [];

  socket.on('data', (chunk) => {
    const cmds = parser.feed(chunk);
    for (const args of cmds) {
      const cmd = args[0].toUpperCase();

      if (cmd === 'MULTI') {
        inMulti = true;
        queue = [];
        socket.write(ok());
        continue;
      }

      if (cmd === 'EXEC') {
        const responses = queue.map(a => handleCommand(a));
        // EXEC returns an array of results
        let reply = `*${responses.length}\r\n`;
        reply += responses.join('');
        socket.write(reply);
        inMulti = false;
        queue = [];
        continue;
      }

      if (cmd === 'DISCARD') {
        inMulti = false;
        queue = [];
        socket.write(ok());
        continue;
      }

      if (inMulti) {
        queue.push(args);
        socket.write(queued());
        continue;
      }

      socket.write(handleCommand(args));
    }
  });

  socket.on('error', () => socket.destroy());
});

server.listen(PORT, () => {
  console.log(`Fallback Redis server listening on port ${PORT}`);
});

server.on('error', (err) => {
  console.error(`Fallback Redis error: ${err.message}`);
  process.exit(1);
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
