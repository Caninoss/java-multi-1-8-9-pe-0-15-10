'use strict';
// Little-endian NBT helpers (MCPE 0.15 uses little-endian NBT for items and tiles).
const nbt = require('prismarine-nbt');

const little = nbt.protos.little;

// Parse every root compound in a buffer (chunk tile lists are concatenated roots).
function parseAll(buf) {
  const out = [];
  let off = 0;
  while (buf && off < buf.length) {
    try {
      const res = little.parsePacketBuffer('nbt', buf, off);
      const data = res.data, size = res.metadata && res.metadata.size;
      out.push(data);
      if (!size) break;
      off += size;
    } catch (e) { break; }
  }
  return out;
}

function parseOne(buf) {
  if (!buf || !buf.length) return null;
  try { return little.parsePacketBuffer('nbt', buf, 0).data; } catch (e) { return null; }
}

function write(tag) { return little.createPacketBuffer('nbt', tag); }

const varint = nbt.protos.littleVarint;
// Nukkit-Retro writes block-entity NBT in the "network" (varint) little-endian flavour
function writeNetwork(tag) { return varint.createPacketBuffer('nbt', tag); }
function parseOneAny(buf) {
  if (!buf || !buf.length) return null;
  for (const proto of [little, varint]) {
    try {
      const res = proto.parsePacketBuffer('nbt', buf, 0);
      if (res.metadata && res.metadata.size === buf.length) return res.data;
    } catch (e) { /* try next */ }
  }
  return parseOne(buf);
}

// simplify a compound to plain JS values
function simple(tag) { try { return nbt.simplify(tag); } catch (e) { return {}; } }

module.exports = { parseAll, parseOne, parseOneAny, write, writeNetwork, simple, comp: nbt.comp, string: nbt.string, int: nbt.int, short: nbt.short, list: nbt.list };
