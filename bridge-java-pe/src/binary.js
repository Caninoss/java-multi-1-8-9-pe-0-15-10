'use strict';
// Binary helpers matching pocketmine\utils\BinaryStream (MCPE 0.15.x is mostly big-endian).

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.off = offset;
  }
  get remaining() { return this.buf.length - this.off; }
  feof() { return this.off >= this.buf.length; }
  need(n) {
    if (this.off + n > this.buf.length) throw new RangeError(`read past end (${this.off}+${n} > ${this.buf.length})`);
  }
  get(n) { this.need(n); const b = this.buf.subarray(this.off, this.off + n); this.off += n; return b; }
  rest() { const b = this.buf.subarray(this.off); this.off = this.buf.length; return b; }
  byte() { this.need(1); return this.buf[this.off++]; }
  bool() { return this.byte() !== 0; }
  short() { this.need(2); const v = this.buf.readUInt16BE(this.off); this.off += 2; return v; }
  signedShort() { this.need(2); const v = this.buf.readInt16BE(this.off); this.off += 2; return v; }
  lshort() { this.need(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  int() { this.need(4); const v = this.buf.readInt32BE(this.off); this.off += 4; return v; }
  lint() { this.need(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  long() { this.need(8); const v = this.buf.readBigInt64BE(this.off); this.off += 8; return Number(v); }
  float() { this.need(4); const v = this.buf.readFloatBE(this.off); this.off += 4; return v; }
  triad() { this.need(3); const v = this.buf.readUIntBE(this.off, 3); this.off += 3; return v; }
  ltriad() { this.need(3); const v = this.buf.readUIntLE(this.off, 3); this.off += 3; return v; }
  string() { const len = this.short(); return this.get(len).toString('utf8'); }
  // varints (used by Nukkit-Retro for a handful of 0.15 packets)
  uvarint() {
    let v = 0, shift = 0, b;
    do { b = this.byte(); v += (b & 0x7f) * 2 ** shift; shift += 7; } while ((b & 0x80) && shift < 35);
    return v;
  }
  varint() { const u = this.uvarint(); return (u % 2 === 1) ? -(u + 1) / 2 : u / 2; }
  uvarlong() {
    let v = 0n, shift = 0n, b;
    do { b = this.byte(); v |= BigInt(b & 0x7f) << shift; shift += 7n; } while ((b & 0x80) && shift < 70n);
    return v;
  }
  varlong() { const u = this.uvarlong(); return Number((u >> 1n) ^ -(u & 1n)); }
  lfloat() { this.need(4); const v = this.buf.readFloatLE(this.off); this.off += 4; return v; }
  blockCoords() { return { x: this.varint(), y: this.uvarint(), z: this.varint() }; }
  ustring() { const len = this.uvarint(); return this.get(len).toString('utf8'); }
  // modern (varint) item slot, as Nukkit-Retro writes inside CraftingDataPacket
  modernSlot() {
    const id = this.varint();
    if (id <= 0) return { id: 0, count: 0, damage: 0, nbt: null };
    const aux = this.varint();
    let damage = aux >> 8; if (damage === 0x7fff) damage = 0xffff;
    const count = aux & 0xff;
    const nbtLen = this.lshort();
    const nbt = nbtLen > 0 ? Buffer.from(this.get(nbtLen)) : null;
    const a = this.varint(); for (let i = 0; i < a; i++) this.ustring();
    const d = this.varint(); for (let i = 0; i < d; i++) this.ustring();
    return { id, count, damage, nbt };
  }
  uuid() { return this.get(16).toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5'); }
  // PE item slot (BinaryStream::getSlot)
  slot() {
    const id = this.signedShort();
    if (id <= 0) return { id: 0, count: 0, damage: 0, nbt: null };
    const count = this.byte();
    const damage = this.short();
    const nbtLen = this.lshort();
    const nbt = nbtLen > 0 ? Buffer.from(this.get(nbtLen)) : null;
    return { id, count, damage, nbt };
  }
}

class Writer {
  constructor(size = 256) {
    this.buf = Buffer.allocUnsafe(size);
    this.off = 0;
  }
  ensure(n) {
    if (this.off + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.off + n) size *= 2;
    const nb = Buffer.allocUnsafe(size);
    this.buf.copy(nb, 0, 0, this.off);
    this.buf = nb;
  }
  put(b) { this.ensure(b.length); b.copy ? b.copy(this.buf, this.off) : Buffer.from(b).copy(this.buf, this.off); this.off += b.length; return this; }
  byte(v) { this.ensure(1); this.buf[this.off++] = v & 0xff; return this; }
  bool(v) { return this.byte(v ? 1 : 0); }
  short(v) { this.ensure(2); this.buf.writeUInt16BE(v & 0xffff, this.off); this.off += 2; return this; }
  lshort(v) { this.ensure(2); this.buf.writeUInt16LE(v & 0xffff, this.off); this.off += 2; return this; }
  int(v) { this.ensure(4); this.buf.writeInt32BE(v | 0, this.off); this.off += 4; return this; }
  lint(v) { this.ensure(4); this.buf.writeInt32LE(v | 0, this.off); this.off += 4; return this; }
  long(v) { this.ensure(8); this.buf.writeBigInt64BE(BigInt(Math.trunc(Number(v))), this.off); this.off += 8; return this; }
  float(v) { this.ensure(4); this.buf.writeFloatBE(Number(v) || 0, this.off); this.off += 4; return this; }
  triad(v) { this.ensure(3); this.buf.writeUIntBE(v & 0xffffff, this.off, 3); this.off += 3; return this; }
  ltriad(v) { this.ensure(3); this.buf.writeUIntLE(v & 0xffffff, this.off, 3); this.off += 3; return this; }
  string(s) { const b = Buffer.from(String(s), 'utf8'); this.short(b.length); return this.put(b); }
  uvarint(v) { v = Math.max(0, Math.floor(v)); do { let b = v % 128; v = Math.floor(v / 128); if (v > 0) b |= 0x80; this.byte(b); } while (v > 0); return this; }
  varint(v) { v |= 0; return this.uvarint(v >= 0 ? v * 2 : -v * 2 - 1); }
  varlong(v) {
    let u = BigInt(Math.trunc(Number(v))); u = (u << 1n) ^ (u >> 63n); u = BigInt.asUintN(64, u);
    do { let b = Number(u & 0x7fn); u >>= 7n; if (u > 0n) b |= 0x80; this.byte(b); } while (u > 0n);
    return this;
  }
  blockCoords(x, y, z) { return this.varint(x).uvarint(y).varint(z); }
  uuid(u) { return this.put(Buffer.from(String(u).replace(/-/g, '').padStart(32, '0'), 'hex')); }
  slot(item) {
    if (!item || !item.id || item.count <= 0) return this.short(0);
    this.short(item.id);
    this.byte(item.count);
    this.short(item.damage == null ? 0xffff : item.damage);
    const nbt = item.nbt || Buffer.alloc(0);
    this.lshort(nbt.length);
    return this.put(nbt);
  }
  done() { return this.buf.subarray(0, this.off); }
}

module.exports = { Reader, Writer };
