'use strict';
// MCPE 0.15.10 (protocol 84) packet codec, written against Genisys/PocketMine "Kyrios" (API 2.0.0) sources.
const zlib = require('zlib');
const { Reader, Writer } = require('./binary');

const P = {
  LOGIN: 0x01, PLAY_STATUS: 0x02, SERVER_TO_CLIENT_HANDSHAKE: 0x03, CLIENT_TO_SERVER_HANDSHAKE: 0x04,
  DISCONNECT: 0x05, BATCH: 0x06, TEXT: 0x07, SET_TIME: 0x08, START_GAME: 0x09, ADD_PLAYER: 0x0a,
  ADD_ENTITY: 0x0b, REMOVE_ENTITY: 0x0c, ADD_ITEM_ENTITY: 0x0d, TAKE_ITEM_ENTITY: 0x0e, MOVE_ENTITY: 0x0f,
  MOVE_PLAYER: 0x10, RIDER_JUMP: 0x11, REMOVE_BLOCK: 0x12, UPDATE_BLOCK: 0x13, ADD_PAINTING: 0x14,
  EXPLODE: 0x15, LEVEL_EVENT: 0x16, BLOCK_EVENT: 0x17, ENTITY_EVENT: 0x18, MOB_EFFECT: 0x19,
  UPDATE_ATTRIBUTES: 0x1a, MOB_EQUIPMENT: 0x1b, MOB_ARMOR_EQUIPMENT: 0x1c, INTERACT: 0x1e, USE_ITEM: 0x1f,
  PLAYER_ACTION: 0x20, HURT_ARMOR: 0x21, SET_ENTITY_DATA: 0x22, SET_ENTITY_MOTION: 0x23, SET_ENTITY_LINK: 0x24,
  SET_HEALTH: 0x25, SET_SPAWN_POSITION: 0x26, ANIMATE: 0x27, RESPAWN: 0x28, DROP_ITEM: 0x29,
  CONTAINER_OPEN: 0x2a, CONTAINER_CLOSE: 0x2b, CONTAINER_SET_SLOT: 0x2c, CONTAINER_SET_DATA: 0x2d,
  CONTAINER_SET_CONTENT: 0x2e, CRAFTING_DATA: 0x2f, CRAFTING_EVENT: 0x30, ADVENTURE_SETTINGS: 0x31,
  BLOCK_ENTITY_DATA: 0x32, PLAYER_INPUT: 0x33, FULL_CHUNK_DATA: 0x34, SET_DIFFICULTY: 0x35,
  CHANGE_DIMENSION: 0x36, SET_PLAYER_GAMETYPE: 0x37, PLAYER_LIST: 0x38, TELEMETRY_EVENT: 0x39,
  SPAWN_EXPERIENCE_ORB: 0x3a, CLIENTBOUND_MAP_ITEM_DATA: 0x3b, MAP_INFO_REQUEST: 0x3c,
  REQUEST_CHUNK_RADIUS: 0x3d, CHUNK_RADIUS_UPDATED: 0x3e, ITEM_FRAME_DROP_ITEM: 0x3f,
  REPLACE_SELECTED_ITEM: 0x40, ADD_ITEM: 0x41
};
const NAMES = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]));

const PlayerAction = {
  START_BREAK: 0, ABORT_BREAK: 1, STOP_BREAK: 2, RELEASE_ITEM: 5, STOP_SLEEPING: 6, SPAWN_SAME_DIMENSION: 7,
  JUMP: 8, START_SPRINT: 9, STOP_SPRINT: 10, START_SNEAK: 11, STOP_SNEAK: 12, SPAWN_OVERWORLD: 13, SPAWN_NETHER: 14
};

// ---- metadata (Binary::readMetadata) ----
function readMetadata(r) {
  const meta = {};
  while (!r.feof()) {
    const b = r.byte();
    if (b === 0x7f) break;
    const key = b & 0x1f, type = b >> 5;
    let value;
    switch (type) {
      case 0: value = r.byte(); break;
      case 1: value = r.buf.readInt16LE(r.off); r.off += 2; break;
      case 2: value = r.lint(); break;
      case 3: value = r.buf.readFloatLE(r.off); r.off += 4; break;
      case 4: { const len = r.lshort(); value = r.get(len).toString('utf8'); break; }
      case 5: { const id = r.buf.readInt16LE(r.off); r.off += 2; const count = r.byte(); const damage = r.lshort(); value = { id, count, damage }; break; }
      case 6: value = [r.lint(), r.lint(), r.lint()]; break;
      case 7: value = Number(r.buf.readBigInt64LE(r.off)); r.off += 8; break;
      default: return meta;
    }
    meta[key] = { type, value };
  }
  return meta;
}

function writeMetadata(w, meta) {
  for (const [k, { type, value }] of Object.entries(meta)) {
    w.byte((type << 5) | (k & 0x1f));
    switch (type) {
      case 0: w.byte(value); break;
      case 1: w.ensure(2); w.buf.writeInt16LE(value, w.off); w.off += 2; break;
      case 2: w.lint(value); break;
      case 3: w.ensure(4); w.buf.writeFloatLE(value, w.off); w.off += 4; break;
      case 4: { const b = Buffer.from(value); w.lshort(b.length); w.put(b); break; }
      case 7: w.ensure(8); w.buf.writeBigInt64LE(BigInt(value), w.off); w.off += 8; break;
      default: break;
    }
  }
  w.byte(0x7f);
}

// ---- decoders (server -> client) ----
const decoders = {
  [P.PLAY_STATUS]: (r) => ({ status: r.int() }),
  [P.DISCONNECT]: (r) => ({ message: r.string() }),
  [P.BATCH]: (r) => ({ payload: r.get(r.int()) }),
  [P.TEXT]: (r) => {
    const p = { type: r.byte(), source: '', message: '', parameters: [] };
    switch (p.type) {
      case 1: case 3: p.source = r.string(); p.message = r.string(); break;
      case 0: case 4: case 5: p.message = r.string(); break;
      case 2: p.message = r.string(); { const n = r.byte(); for (let i = 0; i < n; i++) p.parameters.push(r.string()); } break;
      default: p.message = r.feof() ? '' : r.string();
    }
    return p;
  },
  [P.SET_TIME]: (r) => ({ time: r.int(), started: r.byte() !== 0 }),
  [P.START_GAME]: (r) => ({
    seed: r.int(), dimension: r.byte(), generator: r.int(), gamemode: r.int(), eid: r.long(),
    spawnX: r.int(), spawnY: r.int(), spawnZ: r.int(), x: r.float(), y: r.float(), z: r.float()
  }),
  [P.ADD_PLAYER]: (r) => ({
    uuid: r.uuid(), username: r.string(), eid: r.long(), x: r.float(), y: r.float(), z: r.float(),
    speedX: r.float(), speedY: r.float(), speedZ: r.float(), yaw: r.float(), headYaw: r.float(), pitch: r.float(),
    item: r.slot(), metadata: readMetadata(r)
  }),
  [P.ADD_ENTITY]: (r) => {
    const p = {
      eid: r.long(), type: r.int(), x: r.float(), y: r.float(), z: r.float(),
      speedX: r.float(), speedY: r.float(), speedZ: r.float(), yaw: r.float() / 0.71111, pitch: r.float() / 0.71111,
      modifiers: r.int()
    };
    p.metadata = readMetadata(r);
    p.links = [];
    try { const n = r.short(); for (let i = 0; i < n; i++) p.links.push([r.long(), r.long(), r.byte()]); } catch (e) { /* optional */ }
    return p;
  },
  [P.REMOVE_ENTITY]: (r) => ({ eid: r.long() }),
  [P.ADD_ITEM_ENTITY]: (r) => ({ eid: r.long(), item: r.slot(), x: r.float(), y: r.float(), z: r.float(), speedX: r.float(), speedY: r.float(), speedZ: r.float() }),
  [P.TAKE_ITEM_ENTITY]: (r) => ({ target: r.long(), eid: r.long() }),
  [P.MOVE_ENTITY]: (r) => {
    // 0.14 (PocketMine) layout: int count, then per entity long eid + xyz + yaw/headYaw/pitch as floats
    const len = r.remaining;
    if (len >= 36 && (len - 4) % 32 === 0 && r.buf.readInt32BE(r.off) === (len - 4) / 32) {
      const n = r.int(), moves = [];
      for (let i = 0; i < n; i++) {
        const eid = r.long(), x = r.float(), y = r.float(), z = r.float();
        const yaw = r.float(), headYaw = r.float(), pitch = r.float();
        moves.push({ eid, x, y, z, yaw, headYaw, pitch });
      }
      return { moves };
    }
    const moves = [];
    while (r.remaining >= 23) {
      const eid = r.long(), x = r.float(), y = r.float(), z = r.float();
      const pitch = r.byte() * 360 / 256, yaw = r.byte() * 360 / 256, headYaw = r.byte() * 360 / 256;
      moves.push({ eid, x, y, z, pitch, yaw, headYaw });
    }
    return { moves };
  },
  [P.MOVE_PLAYER]: (r) => ({
    eid: r.long(), x: r.float(), y: r.float(), z: r.float(), yaw: r.float(), bodyYaw: r.float(), pitch: r.float(),
    mode: r.byte(), onGround: r.byte() > 0
  }),
  [P.UPDATE_BLOCK]: (r) => {
    const p = { records: [] };
    // Genisys sends one record per packet, but some forks batch several; read until end.
    while (r.remaining >= 11) {
      const x = r.int(), z = r.int(), y = r.byte(), id = r.byte(), fm = r.byte();
      p.records.push({ x, y, z, id, meta: fm & 0x0f, flags: fm >> 4 });
    }
    return p;
  },
  [P.ADD_PAINTING]: (r) => ({ eid: r.long(), x: r.int(), y: r.int(), z: r.int(), direction: r.int(), title: r.string() }),
  [P.EXPLODE]: (r) => {
    const p = { x: r.float(), y: r.float(), z: r.float(), radius: r.float(), records: [] };
    const n = r.int();
    for (let i = 0; i < n; i++) p.records.push([r.buf.readInt8(r.off++), r.buf.readInt8(r.off++), r.buf.readInt8(r.off++)]);
    return p;
  },
  [P.LEVEL_EVENT]: (r) => ({ evid: r.buf.readInt16BE((r.off += 2) - 2), x: r.float(), y: r.float(), z: r.float(), data: r.int() }),
  [P.BLOCK_EVENT]: (r) => ({ x: r.int(), y: r.int(), z: r.int(), case1: r.int(), case2: r.int() }),
  [P.ENTITY_EVENT]: (r) => ({ eid: r.long(), event: r.byte() }),
  [P.MOB_EFFECT]: (r) => ({ eid: r.long(), eventId: r.byte(), effectId: r.byte(), amplifier: r.byte(), particles: r.byte() !== 0, duration: r.int() }),
  [P.UPDATE_ATTRIBUTES]: (r) => {
    const p = { eid: r.long(), entries: [] };
    const n = r.short();
    for (let i = 0; i < n; i++) p.entries.push({ min: r.float(), max: r.float(), value: r.float(), name: r.string() });
    return p;
  },
  [P.MOB_EQUIPMENT]: (r) => ({ eid: r.long(), item: r.slot(), slot: r.byte(), selectedSlot: r.byte() }),
  [P.MOB_ARMOR_EQUIPMENT]: (r) => ({ eid: r.long(), slots: [r.slot(), r.slot(), r.slot(), r.slot()] }),
  [P.INTERACT]: (r) => ({ action: r.byte(), target: r.long() }),
  [P.HURT_ARMOR]: (r) => ({ health: r.byte() }),
  [P.SET_ENTITY_DATA]: (r) => ({ eid: r.long(), metadata: readMetadata(r) }),
  [P.SET_ENTITY_MOTION]: (r) => {
    const entities = [];
    // 0.14 layout has an int count first (4 + 20n bytes); 0.15 is just 20n
    const len = r.remaining;
    if (len >= 24 && (len - 4) % 20 === 0 && r.buf.readInt32BE(r.off) === (len - 4) / 20) r.int();
    while (r.remaining >= 20) entities.push({ eid: r.long(), x: r.float(), y: r.float(), z: r.float() });
    return { entities };
  },
  [P.SET_ENTITY_LINK]: (r) => ({ from: r.long(), to: r.long(), type: r.byte() }),
  [P.SET_HEALTH]: (r) => ({ health: r.int() }),
  [P.SET_SPAWN_POSITION]: (r) => ({ x: r.int(), y: r.int(), z: r.int() }),
  [P.ANIMATE]: (r) => ({ action: r.byte(), eid: r.long() }),
  [P.RESPAWN]: (r) => ({ x: r.float(), y: r.float(), z: r.float() }),
  [P.CONTAINER_OPEN]: (r) => ({ windowId: r.byte(), type: r.byte(), slots: r.short(), x: r.int(), y: r.int(), z: r.int(), entityId: r.remaining >= 8 ? r.long() : -1 }),
  [P.CONTAINER_CLOSE]: (r) => ({ windowId: r.byte() }),
  [P.CONTAINER_SET_SLOT]: (r) => ({ windowId: r.byte(), slot: r.short(), hotbarSlot: r.short(), item: r.slot() }),
  [P.CONTAINER_SET_DATA]: (r) => ({ windowId: r.byte(), property: r.short(), value: r.signedShort() }),
  [P.CONTAINER_SET_CONTENT]: (r) => {
    const p = { windowId: r.byte(), slots: [], hotbar: [] };
    const n = r.short();
    for (let i = 0; i < n && !r.feof(); i++) p.slots.push(r.slot());
    if (!r.feof()) { const h = r.short(); for (let i = 0; i < h && !r.feof(); i++) p.hotbar.push(r.int()); }
    return p;
  },
  [P.CRAFTING_DATA]: (r) => {
    const entries = [];
    const n = r.int();
    for (let i = 0; i < n; i++) {
      const type = r.int();
      const len = r.int();
      if (type < 0) { r.get(Math.max(0, len)); continue; }
      const er = new Reader(r.get(len));
      try {
        if (type === 0) {
          const cnt = er.int(); const input = [];
          for (let k = 0; k < cnt; k++) input.push(er.slot());
          er.int(); const output = er.slot(); const uuid = er.uuid();
          entries.push({ type: 'shapeless', input, output, uuid });
        } else if (type === 1) {
          const width = er.int(), height = er.int(); const cells = [];
          for (let k = 0; k < width * height; k++) cells.push(er.slot());
          er.int(); const output = er.slot(); const uuid = er.uuid();
          entries.push({ type: 'shaped', width, height, cells, output, uuid });
        }
      } catch (e) { /* skip malformed entry */ }
    }
    return { entries };
  },
  [P.ADVENTURE_SETTINGS]: (r) => ({ flags: r.int(), userPermission: r.remaining >= 4 ? r.int() : 0 }),
  [P.BLOCK_ENTITY_DATA]: (r) => ({ x: r.int(), y: r.int(), z: r.int(), nbt: Buffer.from(r.rest()) }),
  [P.FULL_CHUNK_DATA]: (r) => ({ chunkX: r.int(), chunkZ: r.int(), order: r.byte(), data: r.get(r.int()) }),
  [P.SET_DIFFICULTY]: (r) => ({ difficulty: r.int() }),
  [P.CHANGE_DIMENSION]: (r) => ({ dimension: r.byte(), x: r.float(), y: r.float(), z: r.float() }),
  [P.SET_PLAYER_GAMETYPE]: (r) => ({ gamemode: r.int() }),
  [P.PLAYER_LIST]: (r) => {
    const p = { type: r.byte(), entries: [] };
    const n = r.int();
    for (let i = 0; i < n; i++) {
      if (p.type === 0) {
        const uuid = r.uuid(), eid = r.long(), name = r.string(), skinId = r.string(); r.string();
        p.entries.push({ uuid, eid, name, skinId });
      } else p.entries.push({ uuid: r.uuid() });
    }
    return p;
  },
  [P.SPAWN_EXPERIENCE_ORB]: (r) => ({ eid: r.long(), x: r.float(), y: r.float(), z: r.float(), count: r.remaining >= 4 ? r.int() : 1 }),
  [P.CHUNK_RADIUS_UPDATED]: (r) => ({ radius: r.int() })
};

// Nukkit-Retro writes some protocol-84 packets with its newer (varint) layouts.
const nukkitDecoders = {
  [P.TAKE_ITEM_ENTITY]: (r) => ({ target: r.varlong(), eid: r.varlong() }),
  [P.EXPLODE]: (r) => {
    const p = { x: r.lfloat(), y: r.lfloat(), z: r.lfloat(), radius: r.lfloat(), records: [] };
    const n = r.uvarint();
    for (let i = 0; i < n; i++) { const c = r.blockCoords(); p.records.push([c.x, c.y, c.z]); }
    return p;
  },
  [P.ADD_PAINTING]: (r) => { r.varlong(); const eid = r.varlong(); const c = r.blockCoords(); return { eid, x: c.x, y: c.y, z: c.z, direction: r.varint(), title: r.string() }; },
  [P.SPAWN_EXPERIENCE_ORB]: (r) => ({ eid: -Math.floor(Math.random() * 1e9) - 1, x: r.lfloat(), y: r.lfloat(), z: r.lfloat(), count: r.uvarint() }),
  [P.BLOCK_ENTITY_DATA]: (r) => { const c = r.blockCoords(); return { x: c.x, y: c.y, z: c.z, nbt: Buffer.from(r.rest()) }; },
  [P.CRAFTING_DATA]: (r) => {
    const entries = [];
    const n = r.uvarint();
    for (let i = 0; i < n; i++) {
      const type = r.varint();
      if (type === 0) {
        const cnt = r.uvarint(); const input = [];
        for (let k = 0; k < cnt; k++) input.push(r.modernSlot());
        r.uvarint(); const output = r.modernSlot(); const uuid = r.uuid();
        entries.push({ type: 'shapeless', input, output, uuid });
      } else if (type === 1) {
        const width = r.varint(), height = r.varint(); const cells = [];
        for (let k = 0; k < width * height; k++) cells.push(r.modernSlot());
        r.uvarint(); const output = r.modernSlot(); const uuid = r.uuid();
        // Nukkit writes [x][y] correctly; store row-major so the matcher can use it directly
        entries.push({ type: 'shaped', width, height, cells, output, uuid, nukkit: true });
      } else if (type === 2) { r.varint(); r.modernSlot(); }
      else if (type === 3) { r.varint(); r.varint(); r.modernSlot(); }
      else if (type === 4) { const c = r.byte(); for (let k = 0; k < c; k++) { r.uvarint(); const e = r.uvarint(); for (let j = 0; j < e; j++) { r.uvarint(); r.uvarint(); } r.ustring(); } }
      else if (type === -1) continue;
      else break;
    }
    return { entries };
  }
};

// ---- MCPE 0.14.x (protocol 60/70): different packet ids and a few older layouts ----
const LEGACY_014 = {
  0x8f: P.LOGIN, 0x90: P.PLAY_STATUS, 0x91: P.DISCONNECT, 0x92: P.BATCH, 0x93: P.TEXT, 0x94: P.SET_TIME,
  0x95: P.START_GAME, 0x96: P.ADD_PLAYER, 0x97: 0xf7 /* REMOVE_PLAYER */, 0x98: P.ADD_ENTITY, 0x99: P.REMOVE_ENTITY,
  0x9a: P.ADD_ITEM_ENTITY, 0x9b: P.TAKE_ITEM_ENTITY, 0x9c: P.MOVE_ENTITY, 0x9d: P.MOVE_PLAYER, 0x9e: P.REMOVE_BLOCK,
  0x9f: P.UPDATE_BLOCK, 0xa0: P.ADD_PAINTING, 0xa1: P.EXPLODE, 0xa2: P.LEVEL_EVENT, 0xa3: P.BLOCK_EVENT,
  0xa4: P.ENTITY_EVENT, 0xa5: P.MOB_EFFECT, 0xa6: P.UPDATE_ATTRIBUTES, 0xa7: P.MOB_EQUIPMENT, 0xa8: P.MOB_ARMOR_EQUIPMENT,
  0xa9: P.INTERACT, 0xaa: P.USE_ITEM, 0xab: P.PLAYER_ACTION, 0xac: P.HURT_ARMOR, 0xad: P.SET_ENTITY_DATA,
  0xae: P.SET_ENTITY_MOTION, 0xaf: P.SET_ENTITY_LINK, 0xb0: P.SET_HEALTH, 0xb1: P.SET_SPAWN_POSITION, 0xb2: P.ANIMATE,
  0xb3: P.RESPAWN, 0xb4: P.DROP_ITEM, 0xb5: P.CONTAINER_OPEN, 0xb6: P.CONTAINER_CLOSE, 0xb7: P.CONTAINER_SET_SLOT,
  0xb8: P.CONTAINER_SET_DATA, 0xb9: P.CONTAINER_SET_CONTENT, 0xba: P.CRAFTING_DATA, 0xbb: P.CRAFTING_EVENT,
  0xbc: P.ADVENTURE_SETTINGS, 0xbd: P.BLOCK_ENTITY_DATA, 0xbe: P.PLAYER_INPUT, 0xbf: P.FULL_CHUNK_DATA,
  0xc0: P.SET_DIFFICULTY, 0xc1: P.CHANGE_DIMENSION, 0xc2: P.SET_PLAYER_GAMETYPE, 0xc3: P.PLAYER_LIST,
  0xc5: P.SPAWN_EXPERIENCE_ORB, 0xc6: P.CLIENTBOUND_MAP_ITEM_DATA, 0xc7: P.MAP_INFO_REQUEST,
  0xc8: P.REQUEST_CHUNK_RADIUS, 0xc9: P.CHUNK_RADIUS_UPDATED, 0xca: P.ITEM_FRAME_DROP_ITEM, 0xcb: P.REPLACE_SELECTED_ITEM
};
const TO_014 = Object.fromEntries(Object.entries(LEGACY_014).map(([a, b]) => [b, Number(a)]));
P.REMOVE_PLAYER = 0xf7; NAMES[0xf7] = 'REMOVE_PLAYER';

// 0.14 packet buffer (optionally with its own 0x8e prefix) -> same packet with the 0.15 id
function fromLegacy(buf) {
  if (buf[0] === 0x8e && buf.length > 1) buf = buf.subarray(1);
  const id = LEGACY_014[buf[0]];
  if (id === undefined) return null;
  const out = Buffer.from(buf); out[0] = id; return out;
}
function toLegacy(buf) {
  const id = TO_014[buf[0]];
  if (id === undefined) return null;
  const out = Buffer.from(buf); out[0] = id; return out;
}

const legacyDecoders = {
  [P.UPDATE_BLOCK]: (r) => {
    const p = { records: [] };
    const n = r.int();
    for (let i = 0; i < n && r.remaining >= 11; i++) {
      const x = r.int(), z = r.int(), y = r.byte(), id = r.byte(), fm = r.byte();
      p.records.push({ x, y, z, id, meta: fm & 0x0f, flags: fm >> 4 });
    }
    return p;
  },
  [P.ADD_ENTITY]: (r) => {
    const p = {
      eid: r.long(), type: r.int(), x: r.float(), y: r.float(), z: r.float(),
      speedX: r.float(), speedY: r.float(), speedZ: r.float(), yaw: r.float(), pitch: r.float(), modifiers: 0
    };
    p.metadata = readMetadata(r);
    p.links = [];
    try { const n = r.short(); for (let i = 0; i < n; i++) p.links.push([r.long(), r.long(), r.byte()]); } catch (e) { /* optional */ }
    return p;
  },
  [P.REMOVE_PLAYER]: (r) => ({ eid: r.long(), uuid: r.feof() ? null : r.uuid() })
};

function decode(buf, flavor = 'genisys', legacy = false) {
  const id = buf[0];
  const r = new Reader(buf, 1);
  const fn = (legacy && legacyDecoders[id]) || (flavor === 'nukkit' && nukkitDecoders[id]) || decoders[id];
  if (!fn) return { id, name: NAMES[id] || ('0x' + id.toString(16)), unknown: true };
  const p = fn(r);
  p.id = id; p.name = NAMES[id];
  return p;
}

// Expand a BatchPacket payload into individual packet buffers.
function unbatch(payload) {
  const data = zlib.inflateSync(payload);
  const out = [];
  let off = 0;
  while (off + 4 <= data.length) {
    const len = data.readInt32BE(off); off += 4;
    if (len <= 0 || off + len > data.length) break;
    out.push(data.subarray(off, off + len));
    off += len;
  }
  return out;
}

// ---- encoders (client -> server) ----
function pk(id) { const w = new Writer(64); w.byte(id); return w; }

const enc = {
  // 0.14.x login: plain fields, no JWTs
  loginLegacy({ protocol, username, uuid, clientId, serverAddress, skin, skinId }) {
    const w = pk(P.LOGIN);
    w.string(username); w.int(protocol); w.int(protocol); w.long(clientId); w.uuid(uuid);
    w.string(serverAddress); w.string(String(Math.floor(Math.random() * 1e12))); w.string(skinId);
    w.short(skin.length); w.put(skin);
    return w.done();
  },
  login({ protocol, username, uuid, clientId, serverAddress, skin, skinId }) {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    const header = b64({ alg: 'ES384', x5u: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE' });
    const now = Math.floor(Date.now() / 1000);
    // 96-byte dummy ES384 signature: keeps Genisys' DER conversion in range; verification simply fails (offline mode).
    const sig = Buffer.alloc(96, 0x11).toString('base64');
    const identity = `${header}.${b64({ extraData: { displayName: username, identity: uuid }, identityPublicKey: 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE', nbf: now - 60, exp: now + 86400 })}.${sig}`;
    const skinTok = `${header}.${b64({ ClientRandomId: clientId, ServerAddress: serverAddress, SkinData: skin.toString('base64'), SkinId: skinId })}.${sig}`;
    const chain = Buffer.from(JSON.stringify({ chain: [identity] }));
    const skinBuf = Buffer.from(skinTok);
    const inner = new Writer(chain.length + skinBuf.length + 16);
    inner.lint(chain.length); inner.put(chain); inner.lint(skinBuf.length); inner.put(skinBuf);
    const compressed = zlib.deflateSync(inner.done(), { level: 7 });
    const w = pk(P.LOGIN); w.int(protocol); w.int(compressed.length); w.put(compressed);
    return w.done();
  },
  text({ type = 1, source = '', message }) {
    const w = pk(P.TEXT); w.byte(type);
    if (type === 1 || type === 3) { w.string(source); w.string(message); } else w.string(message);
    return w.done();
  },
  movePlayer({ eid = 0, x, y, z, yaw, bodyYaw, pitch, mode = 0, onGround }) {
    const w = pk(P.MOVE_PLAYER); w.long(eid); w.float(x); w.float(y); w.float(z); w.float(yaw); w.float(bodyYaw ?? yaw); w.float(pitch); w.byte(mode); w.byte(onGround ? 1 : 0);
    return w.done();
  },
  removeBlock({ eid = 0, x, y, z, flavor }) {
    const w = pk(P.REMOVE_BLOCK);
    if (flavor === 'nukkit') { w.int(x); w.int(y); w.int(z); } else { w.long(eid); w.int(x); w.int(z); w.byte(y); }
    return w.done();
  },
  mobEquipment({ eid = 0, item, slot, selectedSlot }) { const w = pk(P.MOB_EQUIPMENT); w.long(eid); w.slot(item); w.byte(slot); w.byte(selectedSlot); return w.done(); },
  mobArmorEquipment({ eid = 0, slots }) { const w = pk(P.MOB_ARMOR_EQUIPMENT); w.long(eid); for (const s of slots) w.slot(s); return w.done(); },
  interact({ action, target, flavor }) { const w = pk(P.INTERACT); w.byte(action); flavor === 'nukkit' ? w.varlong(target) : w.long(target); return w.done(); },
  useItem({ x, y, z, face, fx, fy, fz, posX, posY, posZ, slot, item }) {
    const w = pk(P.USE_ITEM); w.int(x); w.int(y); w.int(z); w.byte(face); w.float(fx); w.float(fy); w.float(fz);
    w.float(posX); w.float(posY); w.float(posZ); w.int(slot); w.slot(item);
    return w.done();
  },
  playerAction({ eid = 0, action, x = 0, y = 0, z = 0, face = 0 }) { const w = pk(P.PLAYER_ACTION); w.long(eid); w.int(action); w.int(x); w.int(y); w.int(z); w.int(face); return w.done(); },
  animate({ action = 1, eid = 0 }) { const w = pk(P.ANIMATE); w.byte(action); w.long(eid); return w.done(); },
  entityEvent({ eid = 0, event }) { const w = pk(P.ENTITY_EVENT); w.long(eid); w.byte(event); return w.done(); },
  dropItem({ type = 0, item }) { const w = pk(P.DROP_ITEM); w.byte(type); w.slot(item); return w.done(); },
  containerClose({ windowId }) { const w = pk(P.CONTAINER_CLOSE); w.byte(windowId); return w.done(); },
  containerSetSlot({ windowId, slot, hotbarSlot = 0, item }) { const w = pk(P.CONTAINER_SET_SLOT); w.byte(windowId); w.short(slot); w.short(hotbarSlot); w.slot(item); return w.done(); },
  craftingEvent({ windowId = 0, type = 0, uuid, input = [], output = [], flavor }) {
    const w = pk(P.CRAFTING_EVENT); w.byte(windowId);
    const n = (v) => (flavor === 'nukkit' ? w.uvarint(v) : w.int(v));
    n(type); w.uuid(uuid);
    n(input.length); for (const i of input) w.slot(i);
    n(output.length); for (const o of output) w.slot(o);
    return w.done();
  },
  blockEntityData({ x, y, z, nbt, flavor }) {
    const w = pk(P.BLOCK_ENTITY_DATA);
    if (flavor === 'nukkit') w.blockCoords(x, y, z); else { w.int(x); w.int(y); w.int(z); }
    w.put(nbt); return w.done();
  },
  playerInput({ motX, motY, jumping, sneaking }) { const w = pk(P.PLAYER_INPUT); w.float(motX); w.float(motY); w.byte((jumping ? 0x80 : 0) | (sneaking ? 0x40 : 0)); return w.done(); },
  requestChunkRadius({ radius }) { const w = pk(P.REQUEST_CHUNK_RADIUS); w.int(radius); return w.done(); },
  respawn({ x, y, z }) { const w = pk(P.RESPAWN); w.float(x); w.float(y); w.float(z); return w.done(); }
};

// Wrap game packets in a BatchPacket ([0x06][int len][zlib(int len + packet)...]) like a real 0.15 client.
// Nukkit-Retro only accepts batched packets from 0.15 clients; PocketMine/Genisys accepts both.
function batch(packets) {
  const parts = [];
  for (const p of packets) { const l = Buffer.alloc(4); l.writeInt32BE(p.length); parts.push(l, p); }
  const z = zlib.deflateSync(Buffer.concat(parts), { level: 6 });
  const w = new Writer(z.length + 5);
  w.byte(P.BATCH); w.int(z.length); w.put(z);
  return w.done();
}

module.exports = { P, NAMES, PlayerAction, decode, unbatch, enc, batch, fromLegacy, toLegacy, readMetadata, writeMetadata };
