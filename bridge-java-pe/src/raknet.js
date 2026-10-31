'use strict';
// Minimal RakNet client compatible with RakLib 0.8.x (the RakNet stack used by PocketMine/Genisys for MCPE 0.15.x).
const dgram = require('dgram');
const dns = require('dns');
const { EventEmitter } = require('events');
const { Reader, Writer } = require('./binary');

const MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');

const ID = {
  CONNECTED_PING: 0x00,
  UNCONNECTED_PING: 0x01,
  CONNECTED_PONG: 0x03,
  OPEN_CONNECTION_REQUEST_1: 0x05,
  OPEN_CONNECTION_REPLY_1: 0x06,
  OPEN_CONNECTION_REQUEST_2: 0x07,
  OPEN_CONNECTION_REPLY_2: 0x08,
  CONNECTION_REQUEST: 0x09,
  CONNECTION_REQUEST_ACCEPTED: 0x10,
  NEW_INCOMING_CONNECTION: 0x13,
  DISCONNECTION_NOTIFICATION: 0x15,
  INCOMPATIBLE_PROTOCOL: 0x19,
  UNCONNECTED_PONG: 0x1c,
  NACK: 0xa0,
  ACK: 0xc0
};

const UNRELIABLE = 0, RELIABLE = 2, RELIABLE_ORDERED = 3;

function isReliable(r) { return r === 2 || r === 3 || r === 4 || r === 6 || r === 7; }
function isOrdered(r) { return r === 1 || r === 3 || r === 4 || r === 7; } // sequenced counts as ordered on the wire

function writeAddress(w, ip, port) {
  w.byte(4);
  for (const part of ip.split('.')) w.byte(~parseInt(part, 10) & 0xff);
  w.short(port);
}

function encodeFrame(f) {
  const w = new Writer(f.buffer.length + 24);
  w.byte((f.reliability << 5) | (f.split ? 0x10 : 0));
  w.short(f.buffer.length << 3);
  if (isReliable(f.reliability)) w.ltriad(f.messageIndex);
  if (isOrdered(f.reliability)) { w.ltriad(f.orderIndex); w.byte(f.orderChannel || 0); }
  if (f.split) { w.int(f.splitCount); w.short(f.splitId); w.int(f.splitIndex); }
  w.put(f.buffer);
  return w.done();
}

function frameSize(f) {
  return 3 + f.buffer.length + (isReliable(f.reliability) ? 3 : 0) + (isOrdered(f.reliability) ? 4 : 0) + (f.split ? 10 : 0);
}

function decodeFrames(buf) {
  const r = new Reader(buf, 4); // id + seq
  const out = [];
  while (r.remaining > 0) {
    const flags = r.byte();
    const reliability = (flags & 0xe0) >> 5;
    const split = (flags & 0x10) !== 0;
    const len = Math.ceil(r.short() / 8);
    const f = { reliability, split };
    if (isReliable(reliability)) f.messageIndex = r.ltriad();
    if (isOrdered(reliability)) { f.orderIndex = r.ltriad(); f.orderChannel = r.byte(); }
    if (split) { f.splitCount = r.int(); f.splitId = r.short(); f.splitIndex = r.int(); }
    if (len === 0) break;
    f.buffer = Buffer.from(r.get(len));
    out.push(f);
  }
  return out;
}

function encodeAck(id, seqs) {
  seqs = [...new Set(seqs)].sort((a, b) => a - b);
  const body = new Writer(64);
  let records = 0;
  let i = 0;
  while (i < seqs.length) {
    let start = seqs[i], end = start;
    while (i + 1 < seqs.length && seqs[i + 1] === end + 1) { end = seqs[++i]; }
    i++;
    if (start === end) { body.byte(1); body.ltriad(start); } else { body.byte(0); body.ltriad(start); body.ltriad(end); }
    records++;
  }
  const w = new Writer(body.off + 3);
  w.byte(id); w.short(records); w.put(body.done());
  return w.done();
}

function decodeAck(buf) {
  const r = new Reader(buf, 1);
  const count = r.short();
  const seqs = [];
  for (let i = 0; i < count && !r.feof(); i++) {
    if (r.byte() === 0) {
      const start = r.ltriad();
      let end = r.ltriad();
      if (end - start > 4096) end = start + 4096;
      for (let s = start; s <= end; s++) seqs.push(s);
    } else seqs.push(r.ltriad());
  }
  return seqs;
}

class RakNetClient extends EventEmitter {
  constructor({ host, port, mtu = 1400, protocol = 7, log = () => {} }) {
    super();
    this.host = host;
    this.port = port;
    this.mtu = mtu;
    this.protocol = protocol;
    this.log = log;
    this.clientId = BigInt.asIntN(64, BigInt(Math.floor(Math.random() * 2 ** 48)) * 65536n + BigInt(Math.floor(Math.random() * 65536)));
    this.state = 'offline';

    this.sendSeq = 0;
    this.messageIndex = 0;
    this.orderIndex = new Array(32).fill(0);
    this.splitId = 0;
    this.queue = [];          // frames waiting to be put in a datagram
    this.recovery = new Map(); // seq -> {frames, time}

    this.ackQueue = new Set();
    this.nackQueue = new Set();
    this.lastSeq = -1;
    this.received = new Set();

    this.reliableSeen = new Set();
    this.reliableLow = 0;
    this.splits = new Map();
    this.orderExpect = new Array(32).fill(0);
    this.orderHeap = Array.from({ length: 32 }, () => new Map());

    this.lastRecv = Date.now();
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      dns.lookup(this.host, { family: 4 }, (err, address) => {
        if (err) return reject(err);
        this.address = address;
        this.socket = dgram.createSocket('udp4');
        this.socket.on('message', (msg) => { try { this.onMessage(msg); } catch (e) { this.log('raknet error: ' + e.stack); } });
        this.socket.on('error', (e) => this.close('socket error: ' + e.message));
        this.socket.bind(0, () => {
          this.state = 'connecting1';
          let tries = 0;
          let mtu = this.mtu;
          const attempt = () => {
            if (this.state !== 'connecting1') return;
            if (tries++ >= 12) { reject(new Error('PE server did not answer (Open Connection Request 1)')); this.close('timeout'); return; }
            if (tries > 4) mtu = 576; // fall back to a safe MTU
            this.sendOCR1(mtu);
            this.ocrTimer = setTimeout(attempt, 1000);
          };
          this.once('connected', () => resolve());
          this.once('close', (reason) => { if (this.state !== 'connected') reject(new Error(reason)); });
          attempt();
          this.tickTimer = setInterval(() => this.tick(), 20);
        });
      });
    });
  }

  raw(buf) { if (!this.closed) this.socket.send(buf, this.port, this.address); }

  sendOCR1(mtu) {
    const w = new Writer(mtu);
    w.byte(ID.OPEN_CONNECTION_REQUEST_1); w.put(MAGIC); w.byte(this.protocol);
    w.put(Buffer.alloc(Math.max(0, mtu - 46)));
    this.raw(w.done());
  }

  onMessage(msg) {
    this.lastRecv = Date.now();
    const id = msg[0];
    if (id >= 0x80 && id <= 0x8f) return this.onDatagram(msg);
    if (id === ID.ACK) { for (const s of decodeAck(msg)) this.recovery.delete(s); return; }
    if (id === ID.NACK) {
      for (const s of decodeAck(msg)) {
        const d = this.recovery.get(s);
        if (d) { this.recovery.delete(s); for (const f of d.frames) this.queue.unshift(f); }
      }
      return;
    }
    const r = new Reader(msg, 1);
    if (id === ID.OPEN_CONNECTION_REPLY_1 && this.state === 'connecting1') {
      r.get(16); r.get(8); r.byte();
      this.mtu = Math.min(r.short(), 1492);
      clearTimeout(this.ocrTimer);
      this.state = 'connecting2';
      const w = new Writer(64);
      w.byte(ID.OPEN_CONNECTION_REQUEST_2); w.put(MAGIC);
      writeAddress(w, this.address, this.port);
      w.short(this.mtu);
      w.put((() => { const b = Buffer.alloc(8); b.writeBigInt64BE(this.clientId); return b; })());
      const send2 = () => { if (this.state === 'connecting2') { this.raw(w.done()); this.ocrTimer = setTimeout(send2, 1000); } };
      send2();
    } else if (id === ID.OPEN_CONNECTION_REPLY_2 && this.state === 'connecting2') {
      clearTimeout(this.ocrTimer);
      this.state = 'connecting3';
      const w = new Writer(32);
      w.byte(ID.CONNECTION_REQUEST);
      w.put((() => { const b = Buffer.alloc(8); b.writeBigInt64BE(this.clientId); return b; })());
      w.long(Date.now() & 0x7fffffff);
      w.byte(0);
      this.sendFrame(w.done(), RELIABLE, true);
    } else if (id === ID.INCOMPATIBLE_PROTOCOL) {
      this.close('incompatible RakNet protocol');
    }
  }

  onDatagram(msg) {
    const seq = msg.readUIntLE(1, 3);
    if (this.received.has(seq)) { this.ackQueue.add(seq); return; }
    this.received.add(seq);
    if (this.received.size > 4096) { // trim
      const lowest = seq - 2048;
      for (const s of this.received) if (s < lowest) this.received.delete(s);
    }
    this.ackQueue.add(seq);
    this.nackQueue.delete(seq);
    if (seq > this.lastSeq + 1) for (let s = this.lastSeq + 1; s < seq; s++) if (!this.received.has(s)) this.nackQueue.add(s);
    if (seq > this.lastSeq) this.lastSeq = seq;
    for (const f of decodeFrames(msg)) this.onFrame(f);
  }

  onFrame(f) {
    if (isReliable(f.reliability)) {
      if (f.messageIndex < this.reliableLow || this.reliableSeen.has(f.messageIndex)) return;
      this.reliableSeen.add(f.messageIndex);
      while (this.reliableSeen.has(this.reliableLow)) { this.reliableSeen.delete(this.reliableLow); this.reliableLow++; }
    }
    if (f.split) {
      let s = this.splits.get(f.splitId);
      if (!s) { s = { count: f.splitCount, parts: new Map(), first: f }; this.splits.set(f.splitId, s); }
      s.parts.set(f.splitIndex, f.buffer);
      if (s.parts.size < s.count) return;
      this.splits.delete(f.splitId);
      const parts = [];
      for (let i = 0; i < s.count; i++) parts.push(s.parts.get(i));
      f = { reliability: f.reliability, orderIndex: s.first.orderIndex, orderChannel: s.first.orderChannel, buffer: Buffer.concat(parts) };
    }
    if (f.reliability === 3 || f.reliability === 7) {
      const ch = f.orderChannel || 0;
      if (f.orderIndex < this.orderExpect[ch]) return;
      if (f.orderIndex > this.orderExpect[ch]) { this.orderHeap[ch].set(f.orderIndex, f.buffer); return; }
      this.handlePacket(f.buffer);
      this.orderExpect[ch]++;
      const heap = this.orderHeap[ch];
      while (heap.has(this.orderExpect[ch])) {
        const b = heap.get(this.orderExpect[ch]);
        heap.delete(this.orderExpect[ch]);
        this.orderExpect[ch]++;
        this.handlePacket(b);
      }
      return;
    }
    this.handlePacket(f.buffer);
  }

  handlePacket(buf) {
    const id = buf[0];
    if (id === ID.CONNECTION_REQUEST_ACCEPTED && this.state === 'connecting3') {
      const r = new Reader(buf, 1);
      // client address, system index short, 10 internal addresses, ping time, pong time
      let sendPong = 0;
      try { r.get(7); r.short(); for (let i = 0; i < 10; i++) r.get(7); r.long(); sendPong = r.long(); } catch (e) { /* tolerate */ }
      const w = new Writer(128);
      w.byte(ID.NEW_INCOMING_CONNECTION);
      writeAddress(w, this.address, this.port); // RakLib checks this port against its own
      for (let i = 0; i < 10; i++) writeAddress(w, i === 0 ? '127.0.0.1' : '0.0.0.0', 0);
      w.long(sendPong); w.long(Date.now() & 0x7fffffff);
      this.sendFrame(w.done(), RELIABLE, true);
      this.state = 'connected';
      this.pingTimer = setInterval(() => {
        const p = new Writer(9); p.byte(ID.CONNECTED_PING); p.long(Date.now() & 0x7fffffff);
        this.sendFrame(p.done(), UNRELIABLE, true);
      }, 2000);
      this.emit('connected');
      return;
    }
    if (id === ID.CONNECTED_PING) {
      const w = new Writer(17); w.byte(ID.CONNECTED_PONG); w.put(buf.subarray(1, 9)); w.long(Date.now() & 0x7fffffff);
      this.sendFrame(w.done(), UNRELIABLE);
      return;
    }
    if (id === ID.CONNECTED_PONG) return;
    if (id === ID.DISCONNECTION_NOTIFICATION) {
      // The server's Disconnect (kick) packet is ordered and may still be waiting behind a lost datagram;
      // hand over everything we have before closing so the kick reason isn't lost.
      for (let ch = 0; ch < this.orderHeap.length; ch++) {
        const heap = this.orderHeap[ch];
        for (const k of [...heap.keys()].sort((a, b) => a - b)) { const b = heap.get(k); heap.delete(k); this.handlePacket(b); }
      }
      this.close('server closed the connection');
      return;
    }
    if (id === 0xfe || id === 0x8e) { this.emit('packet', buf.subarray(1)); return; } // 0x8e = MCPE 0.14 wrapper
  }

  // Send a game packet (already includes PE packet id); 0xFE prefix added here.
  sendGame(payload, immediate = false) {
    this.sendFrame(Buffer.concat([Buffer.from([this.gamePrefix || 0xfe]), payload]), RELIABLE_ORDERED, immediate);
  }

  sendFrame(buffer, reliability, immediate = false) {
    const maxPayload = this.mtu - 60;
    const base = { reliability, orderChannel: 0 };
    if (isReliable(reliability)) base.messageIndex = this.messageIndex++;
    if (reliability === RELIABLE_ORDERED) base.orderIndex = this.orderIndex[0]++;
    if (buffer.length > maxPayload) {
      const count = Math.ceil(buffer.length / maxPayload);
      const splitId = this.splitId++ & 0xffff;
      for (let i = 0; i < count; i++) {
        const f = Object.assign({}, base, {
          buffer: buffer.subarray(i * maxPayload, (i + 1) * maxPayload),
          split: true, splitCount: count, splitId, splitIndex: i
        });
        if (i > 0) f.messageIndex = this.messageIndex++;
        this.queue.push(f);
      }
    } else {
      this.queue.push(Object.assign(base, { buffer }));
    }
    if (immediate) this.flush();
  }

  flush() {
    while (this.queue.length) {
      const frames = [];
      let size = 4;
      while (this.queue.length && (frames.length === 0 || size + frameSize(this.queue[0]) <= this.mtu - 28)) {
        const f = this.queue.shift();
        size += frameSize(f);
        frames.push(f);
      }
      const seq = this.sendSeq++ & 0xffffff;
      const parts = [Buffer.from([0x84, seq & 0xff, (seq >> 8) & 0xff, (seq >> 16) & 0xff])];
      for (const f of frames) parts.push(encodeFrame(f));
      this.raw(Buffer.concat(parts));
      const reliableFrames = frames.filter((f) => isReliable(f.reliability));
      if (reliableFrames.length) this.recovery.set(seq, { frames: reliableFrames, time: Date.now() });
    }
  }

  tick() {
    if (this.closed) return;
    if (this.ackQueue.size) { this.raw(encodeAck(ID.ACK, [...this.ackQueue])); this.ackQueue.clear(); }
    if (this.nackQueue.size) { this.raw(encodeAck(ID.NACK, [...this.nackQueue])); this.nackQueue.clear(); }
    const now = Date.now();
    for (const [seq, d] of this.recovery) {
      if (now - d.time > 1500) { this.recovery.delete(seq); for (const f of d.frames) this.queue.push(f); }
    }
    this.flush();
    if (this.state === 'connected' && now - this.lastRecv > 20000) this.close('timed out');
  }

  close(reason = 'closed') {
    if (this.closed) return;
    if (this.state === 'connected') {
      try { this.sendFrame(Buffer.from([ID.DISCONNECTION_NOTIFICATION]), RELIABLE, true); } catch (e) { /* ignore */ }
    }
    this.closed = true;
    this.state = 'closed';
    clearTimeout(this.ocrTimer);
    clearInterval(this.tickTimer);
    clearInterval(this.pingTimer);
    setTimeout(() => { try { this.socket.close(); } catch (e) { /* ignore */ } }, 50);
    this.emit('close', reason);
  }
}

// Unconnected ping -> "MCPE;motd;protocol;version;online;max" (RakLib server name)
function queryStatus(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (v) => { if (done) return; done = true; clearTimeout(t); try { sock.close(); } catch (e) { /* ignore */ } resolve(v); };
    const t = setTimeout(() => finish(null), timeout);
    sock.on('error', () => finish(null));
    sock.on('message', (msg) => {
      if (msg[0] !== ID.UNCONNECTED_PONG) return;
      try {
        const r = new Reader(msg, 1); r.long(); r.long(); r.get(16);
        const parts = r.string().split(';');
        finish({ motd: parts[1] || '', protocol: +parts[2] || 0, version: parts[3] || '', online: +parts[4] || 0, max: +parts[5] || 0 });
      } catch (e) { finish(null); }
    });
    const w = new Writer(25); w.byte(ID.UNCONNECTED_PING); w.long(Date.now() & 0x7fffffff); w.put(MAGIC);
    dns.lookup(host, { family: 4 }, (err, address) => { if (err) return finish(null); sock.send(w.done(), port, address); });
  });
}

module.exports = { RakNetClient, MAGIC, queryStatus };
