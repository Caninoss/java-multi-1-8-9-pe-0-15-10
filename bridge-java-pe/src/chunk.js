'use strict';
// MCPE 0.15 FullChunkData -> Java 1.8 map_chunk conversion.
const { BLOCK_LUT } = require('./mappings');
const nbtle = require('./nbtle');

const HEIGHT = 128;
const SECTIONS = 8;

class Column {
  constructor(x, z) {
    this.x = x; this.z = z;
    this.blocks = new Uint16Array(16 * 16 * HEIGHT); // java state, index (y<<8)|(z<<4)|x
    this.sky = new Uint8Array(16 * 16 * HEIGHT);     // one nibble value per byte (simpler to edit)
    this.light = new Uint8Array(16 * 16 * HEIGHT);
    this.biomes = new Uint8Array(256).fill(1);
    this.tiles = [];
  }
  get(x, y, z) { return (y < 0 || y >= HEIGHT) ? 0 : this.blocks[(y << 8) | (z << 4) | x]; }
  set(x, y, z, state) { if (y >= 0 && y < HEIGHT) this.blocks[(y << 8) | (z << 4) | x] = state; }

  // ORDER_COLUMNS (McRegion / LevelDB providers)
  static fromColumns(cx, cz, data) {
    const c = new Column(cx, cz);
    const ids = data.subarray(0, 32768);
    const meta = data.subarray(32768, 49152);
    const sky = data.subarray(49152, 65536);
    const bl = data.subarray(65536, 81920);
    let off = 81920;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      const base = (x << 11) | (z << 7);
      const nbase = (x << 10) | (z << 6);
      for (let y = 0; y < HEIGHT; y++) {
        const nb = nbase | (y >> 1);
        const shift = (y & 1) ? 4 : 0;
        const id = ids[base | y];
        const m = (meta[nb] >> shift) & 15;
        const j = (y << 8) | (z << 4) | x;
        c.blocks[j] = BLOCK_LUT[(id << 4) | m];
        c.sky[j] = (sky[nb] >> shift) & 15;
        c.light[j] = (bl[nb] >> shift) & 15;
      }
    }
    return c.tail(data, off);
  }

  // ORDER_LAYERED (Anvil provider): 8 sections of 16x16x16, YZX order, nibbles by x
  static fromLayered(cx, cz, data) {
    const c = new Column(cx, cz);
    const ids = data.subarray(0, 32768);
    const meta = data.subarray(32768, 49152);
    const sky = data.subarray(49152, 65536);
    const bl = data.subarray(65536, 81920);
    for (let s = 0; s < SECTIONS; s++) {
      const ib = s * 4096, nbBase = s * 2048;
      for (let i = 0; i < 4096; i++) {
        const nb = nbBase + (i >> 1);
        const shift = (i & 1) ? 4 : 0;
        const id = ids[ib + i];
        const m = (meta[nb] >> shift) & 15;
        const j = ib + i; // (y<<8)|(z<<4)|x with section offset == java layout
        c.blocks[j] = BLOCK_LUT[(id << 4) | m];
        c.sky[j] = (sky[nb] >> shift) & 15;
        c.light[j] = (bl[nb] >> shift) & 15;
      }
    }
    return c.tail(data, 81920);
  }

  // Some PE servers ship chunks with no computed sky light; Java 1.8 would render them pitch black.
  fixSkyLight() {
    for (let i = 0; i < this.sky.length; i++) if (this.sky[i] !== 0) return;
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
      let level = 15;
      for (let y = HEIGHT - 1; y >= 0; y--) {
        const j = (y << 8) | (z << 4) | x;
        const id = this.blocks[j] >> 4;
        if (id !== 0) level = (id === 18 || id === 161 || id === 8 || id === 9 || id === 20 || id === 102 || id === 31 || id === 37 || id === 38 || id === 175 || id === 106) ? Math.max(0, level - 2) : 0;
        this.sky[j] = level;
      }
    }
  }

  tail(data, off) {
    this.fixSkyLight();
    off += 256; // heightmap
    if (off + 1024 <= data.length) {
      for (let i = 0; i < 256; i++) {
        const biome = data[off + i * 4]; // (biomeId << 24) | rgb, big-endian
        // PE index is (z << 4) | x as well
        this.biomes[i] = biome;
      }
      off += 1024;
    }
    if (off + 4 <= data.length) {
      const extra = data.readInt32LE(off); off += 4;
      off += Math.max(0, extra) * 6;
    }
    if (off < data.length) {
      for (const t of nbtle.parseAll(data.subarray(off))) this.tiles.push(nbtle.simple(t));
    }
    return this;
  }

  // Java 1.8 chunk data: block shorts for each section, block light per section, sky light per section, biomes.
  toJava(skyLight = true) {
    let mask = 0;
    const present = [];
    for (let s = 0; s < SECTIONS; s++) {
      const base = s * 4096;
      for (let i = 0; i < 4096; i++) if (this.blocks[base + i] !== 0) { mask |= 1 << s; present.push(s); break; }
    }
    const n = present.length;
    const buf = Buffer.alloc(n * 8192 + n * 2048 + (skyLight ? n * 2048 : 0) + 256);
    let off = 0;
    for (const s of present) {
      const base = s * 4096;
      for (let i = 0; i < 4096; i++) { buf.writeUInt16LE(this.blocks[base + i], off); off += 2; }
    }
    for (const s of present) {
      const base = s * 4096;
      for (let i = 0; i < 4096; i += 2) buf[off++] = (this.light[base + i] & 15) | ((this.light[base + i + 1] & 15) << 4);
    }
    if (skyLight) {
      for (const s of present) {
        const base = s * 4096;
        for (let i = 0; i < 4096; i += 2) buf[off++] = (this.sky[base + i] & 15) | ((this.sky[base + i + 1] & 15) << 4);
      }
    }
    for (let i = 0; i < 256; i++) buf[off++] = this.biomes[i];
    return { x: this.x, z: this.z, groundUp: true, bitMap: mask, chunkData: buf };
  }
}

function decodeChunk(pk) {
  const data = Buffer.from(pk.data);
  if (data.length < 81920) throw new Error(`chunk ${pk.chunkX},${pk.chunkZ} too short (${data.length})`);
  return pk.order === 1 ? Column.fromLayered(pk.chunkX, pk.chunkZ, data) : Column.fromColumns(pk.chunkX, pk.chunkZ, data);
}

function emptyJavaChunk(x, z) {
  return { x, z, groundUp: true, bitMap: 0, chunkData: Buffer.alloc(0) };
}

module.exports = { Column, decodeChunk, emptyJavaChunk, HEIGHT };
