'use strict';
// One Java 1.8 player <-> one MCPE 0.15.10 connection.
const { RakNetClient, queryStatus } = require('./raknet');
const { P, PlayerAction, decode, unbatch, enc, batch, fromLegacy, toLegacy } = require('./pe');
const { peItemToJava, javaItemToPe, ENTITY, eyeOffset, nukkitEyeOffset, peBlockToJava } = require('./mappings');
const { decodeChunk, emptyJavaChunk, Column } = require('./chunk');
const { Inventory, isEmpty } = require('./inventory');
const nbtle = require('./nbtle');

const SELF_JAVA_ID = 1;
const EYE = 1.62;

const toAngle = (deg) => { const v = Math.round(((deg % 360) + 360) % 360 * 256 / 360) & 0xff; return v > 127 ? v - 256 : v; };
const fixed = (v) => Math.floor(v * 32);
const vel = (v) => Math.max(-32768, Math.min(32767, Math.round((v || 0) * 8000)));
const chunkKey = (x, z) => `${x},${z}`;

const SOUNDS = {
  1000: ['random.click', 1.0], 1001: ['random.click', 1.2], 1002: ['random.bow', 1.2], 1003: ['random.door_open', 1.0],
  1004: ['random.fizz', 1.0], 1005: ['game.tnt.primed', 1.0], 1007: ['mob.ghast.moan', 1.0], 1008: ['mob.ghast.fireball', 1.0],
  1009: ['mob.ghast.fireball', 1.0], 1010: ['mob.zombie.wood', 1.0], 1012: ['mob.zombie.woodbreak', 1.0], 1015: ['mob.bat.takeoff', 1.0],
  1016: ['mob.zombie.infect', 1.0], 1017: ['mob.zombie.unfect', 1.0], 1018: ['mob.endermen.portal', 1.0], 1020: ['random.anvil_break', 1.0],
  1021: ['random.anvil_use', 1.0], 1022: ['random.anvil_land', 1.0], 1030: ['random.pop', 1.0], 1031: ['random.bow', 0.5],
  1051: ['random.orb', 1.0], 3500: ['random.click', 1.0], 3501: ['random.explode', 1.0], 3504: ['game.potion.smash', 1.0],
  3506: ['game.neutral.swim.splash', 1.0], 3507: ['game.neutral.swim.splash', 1.0]
};

// tiny generated 64x32 skin so Genisys' skin size check passes
function makeSkin() {
  const skin = Buffer.alloc(64 * 32 * 4);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 64; x++) {
    const o = (y * 64 + x) * 4;
    let c = [0x2b, 0x5d, 0x8a]; // shirt
    if (y < 16 && x < 32) c = [0xb4, 0x84, 0x6c]; // head
    if (y < 8 && x >= 8 && x < 24) c = [0x3b, 0x28, 0x1a]; // hair
    if (y >= 20 && x < 16) c = [0x3a, 0x3a, 0x80]; // legs
    skin[o] = c[0]; skin[o + 1] = c[1]; skin[o + 2] = c[2]; skin[o + 3] = 255;
  }
  return skin;
}
const SKIN = makeSkin();

const FOOD = new Set([260, 282, 297, 319, 320, 322, 349, 350, 357, 360, 363, 364, 365, 366, 367, 373, 375, 391, 392, 393, 394, 396, 400, 411, 412, 413, 423, 424, 457, 459, 460, 461, 462, 463, 466]);
// PocketMine/Nukkit send translation keys for their built-in kick reasons
const KICK_KEYS = {
  'disconnectionScreen.serverFull': 'The server is full!',
  'disconnectionScreen.notAuthenticated': 'You need to be signed in (the PE server has online-mode enabled).',
  'disconnectionScreen.outdatedClient': 'Outdated client! The server does not accept this MCPE version.\nTry the other version when starting the proxy.',
  'disconnectionScreen.outdatedServer': 'Outdated server! The server is older than this MCPE version.\nTry the other version when starting the proxy.',
  'disconnectionScreen.invalidName': 'The PE server rejected this name.\nIt only allows 3-16 letters, numbers and _ unless it has the long-name patch installed.',
  'disconnectionScreen.invalidSkin': 'Invalid skin.',
  'disconnectionScreen.noReason': 'Disconnected from the server.',
  'disconnectionScreen.loggedinOtherLocation': 'You logged in from another location.',
  'disconnectionScreen.resourcePack': 'Resource pack error.',
  'disconnectionScreen.removed': 'You were removed from the server.',
  'disconnectionScreen.timeout': 'Timed out.'
};
function formatKick(message) {
  let m = String(message || '').trim();
  if (!m) return 'Disconnected from the server.';
  if (KICK_KEYS[m]) return KICK_KEYS[m];
  m = m.replace(/%?disconnectionScreen\.[A-Za-z]+/g, (k) => KICK_KEYS[k.replace(/^%/, '')] || k.replace(/^%?disconnectionScreen\./, ''));
  return m;
}

function isConsumable(it) { return !!it && it.count > 0 && (FOOD.has(it.id) || (it.id === 325 && it.damage === 1)); }

// remembers the last PE name each Java account chose
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const NAMES_FILE = path.join(__dirname, '..', 'names.json');
const names = {
  data: null,
  load() { if (!this.data) { try { this.data = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); } catch (e) { this.data = {}; } } return this.data; },
  get(id) { return this.load()[id]; },
  set(id, name) { this.load()[id] = name; try { fs.writeFileSync(NAMES_FILE, JSON.stringify(this.data, null, 2)); } catch (e) { /* read-only install */ } }
};
function offlineUuid(name) {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  return h.toString('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

class Session {
  constructor(client, config, log) {
    this.client = client;
    this.cfg = config;
    this.log = log;
    this.javaName = client.username;
    this.javaUuid = client.uuid;
    this.username = client.username; // name used on the PE server (may be chosen in the name picker)
    this.uuid = client.uuid;          // uuid sent to the PE server
    this.closed = false;
    this.loggedIn = false;   // java login packet sent
    this.spawned = false;    // PE PLAYER_SPAWN received
    this.dead = false;
    this.gamemode = 0;
    this.advFlags = 0;
    this.dimension = 0;
    this.pos = { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, onGround: true };
    this.lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, t: 0 };
    this.food = 20; this.saturation = 5; this.health = 20;
    this.xp = { bar: 0, level: 0 };
    this.columns = new Map();
    this.sentChunks = new Set();
    this.entities = new Map(); // peId -> entity
    this.javaToPe = new Map();
    this.nextJavaId = 100;
    this.tab = new Map();      // uuid -> name
    this.selfRealId = null;
    this.signs = new Map();
    this.pendingSign = null;
    this.breaking = null;
    this.sneaking = false;
    this.flavor = 'genisys';
    this.legacy = (config.pe.protocol || 84) < 81; // MCPE 0.14.x
    this.selfEid = 0;
    this.outBatch = [];
    this.flushScheduled = false;
    this.inv = new Inventory(this);
  }

  // ------------------------------------------------------------------ plumbing
  dbg(...a) { if (this.cfg.debug) this.log(`[${this.username}]`, ...a); }
  java(name, data) {
    if (this.closed || this.client.state !== 'play') return;
    if (!this.loggedIn && name !== 'login' && name !== 'kick_disconnect') return;
    try { this.client.write(name, data); } catch (e) { this.log(`[${this.username}] failed to write ${name}: ${e.message}`); }
  }
  // Real 0.15 clients batch their packets; Nukkit-Retro only accepts batched packets from 0.15 clients.
  pe(buf) {
    if (!this.rak || this.rak.closed) return;
    if (this.legacy) { // 0.14 clients send packets one by one, wrapped in 0x8e
      const b = toLegacy(buf);
      if (b) this.rak.sendGame(b);
      return;
    }
    this.outBatch.push(buf);
    if (!this.flushScheduled) { this.flushScheduled = true; setImmediate(() => this.flushPe()); }
  }
  flushPe() {
    this.flushScheduled = false;
    if (!this.outBatch.length || !this.rak || this.rak.closed) { this.outBatch = []; return; }
    const list = this.outBatch; this.outBatch = [];
    this.rak.sendGame(batch(list));
  }

  async start() {
    const pe = this.cfg.pe;
    this.client.on('packet', (data, meta) => { try { this.onJava(meta.name, data); } catch (e) { this.log(`[${this.username}] java ${meta.name} handler error: ${e.stack}`); } });
    this.client.on('end', () => this.end(null));
    this.client.on('error', (e) => this.log(`[${this.username}] java error: ${e.message}`));
    if (String(this.cfg.java.nameSelect || 'ask').toLowerCase() === 'ask') {
      const name = await this.pickName();
      if (this.closed || !name) return;
      this.setPeName(name);
    }
    const type = String(pe.serverType || 'auto').toLowerCase();
    if (type === 'nukkit' || type === 'genisys' || type === 'pocketmine') this.flavor = type === 'nukkit' ? 'nukkit' : 'genisys';
    else {
      const st = await queryStatus(pe.host, pe.port);
      // PocketMine/Genisys advertise the 0.15 protocol; Nukkit-Retro advertises its newest one (113)
      this.flavor = st && st.protocol && (st.protocol < 60 || st.protocol > 84) ? 'nukkit' : 'genisys';
      this.log(`[${this.username}] PE server advertises protocol ${st ? st.protocol : '?'} (${st ? st.version : 'no ping reply'}) -> using ${this.flavor} packet layouts`);
    }
    this.inv = new Inventory(this);
    if (this.closed) return;
    this.rak = new RakNetClient({ host: pe.host, port: pe.port, mtu: pe.mtu, protocol: pe.raknetProtocol, log: this.log });
    if (this.legacy) this.rak.gamePrefix = 0x8e;
    this.rak.on('packet', (buf) => this.onPeRaw(buf));
    // give a kick message that is still being decoded a moment to win over the generic one
    this.rak.on('close', (reason) => setTimeout(() => this.end(`§cLost connection to the PE server\n§7${reason}`), 250));
    this.rak.connect().then(() => {
      this.log(`[${this.username}] RakNet connected to ${pe.host}:${pe.port}, logging in as MCPE ${pe.versionName || ''} (protocol ${pe.protocol})`);
      this.pe((this.legacy ? enc.loginLegacy : enc.login)({
        protocol: pe.protocol, username: this.username, uuid: this.uuid,
        clientId: Math.floor(Math.random() * 2 ** 31), serverAddress: `${pe.host}:${pe.port}`,
        skin: SKIN, skinId: 'Standard_Custom'
      }));
      this.flushPe();
      this.rak.flush();
    }).catch((e) => this.end(`Could not reach the PE server: ${e.message}`));
  }

  // ------------------------------------------------------------------ name picker
  // Holds the Java player in an empty sky "limbo" and lets them type the name to use on the PE server.
  pickName() {
    const saved = names.get(this.javaUuid);
    this.loggedIn = true; this.limbo = true;
    this.java('login', { entityId: SELF_JAVA_ID, gameMode: 2, dimension: 0, difficulty: 1, maxPlayers: this.cfg.java.maxPlayers || 20, levelType: 'flat', reducedDebugInfo: false });
    this.java('spawn_position', { location: { x: 0, y: 200, z: 0 } });
    this.java('abilities', { flags: 0x02 | 0x04, flyingSpeed: 0, walkingSpeed: 0 });
    this.java('position', { x: 0.5, y: 200, z: 0.5, yaw: 0, pitch: -20, flags: 0 });
    const max = this.maxNameLength();
    const btn = (label, value, color) => ({ text: `[${label}]`, color, bold: true, clickEvent: { action: 'run_command', value }, hoverEvent: { action: 'show_text', value: { text: 'Join as ' + value } } });
    const showPrompt = (err) => {
      if (err) this.java('chat', { message: JSON.stringify({ text: err, color: 'red' }), position: 0 });
      const extra = [{ text: '\nType the name you want to use in chat', color: 'gray' }, { text: ` (any characters, up to ${max})`, color: 'dark_gray' }];
      if (max > 100) extra.push({ text: '\nLonger than 100? End a message with + and keep typing in the next one.', color: 'dark_gray' });
      extra.push({ text: '\nor click: ', color: 'gray' });
      if (saved && saved !== this.javaName) extra.push(btn(saved, saved, 'green'), { text: ' ' });
      extra.push(btn(this.javaName, this.javaName, 'aqua'));
      this.java('chat', { message: JSON.stringify({ text: '§6§lChoose your name for the MCPE server', extra }), position: 0 });
      this.java('chat', { message: JSON.stringify({ text: `Choose a name (max ${max})` }), position: 2 });
    };
    return new Promise((resolve) => {
      this.nameResolve = (raw) => {
        const err = this.checkName(raw);
        if (err) { showPrompt(err); return; }
        clearTimeout(this.limboTimer); clearInterval(this.limboHint);
        this.nameResolve = null;
        resolve(String(raw).trim());
      };
      this.limboTimer = setTimeout(() => { this.end('§cYou did not choose a name in time.'); resolve(null); }, 5 * 60 * 1000);
      this.limboHint = setInterval(() => this.java('chat', { message: JSON.stringify({ text: `Choose a name (max ${max})` }), position: 2 }), 2000);
      showPrompt();
    });
  }
  maxNameLength() { return Math.max(1, Math.min(32767, Number(this.cfg.java.maxNameLength) || 128)); }
  checkName(raw) {
    const name = String(raw || '').trim();
    const visible = name.replace(/§./g, '');
    if (!visible.length) return 'The name cannot be empty.';
    if (name.length > this.maxNameLength()) return `That name is ${name.length} characters, the limit is ${this.maxNameLength()}.`;
    if (/[\x00-\x1f\x7f]/.test(name)) return 'The name cannot contain control characters.';
    if (/[\/\\]/.test(name)) return 'The name cannot contain / or \\ (the server saves player data under the name).';
    if (['rcon', 'console'].includes(visible.toLowerCase())) return 'That name is reserved by the server.';
    if (Buffer.byteLength(visible.toLowerCase(), 'utf8') > 240) return 'That name is too long for the server to save (over 240 bytes).';
    return null;
  }
  setPeName(name) {
    this.username = name;
    // a different name is a different player on the PE server, so give it its own offline uuid
    if (name !== this.javaName) this.uuid = offlineUuid(name);
    names.set(this.javaUuid, name);
    this.log(`[${this.javaName}] joining the PE server as "${name}"`);
    this.java('chat', { message: JSON.stringify({ text: `Joining as ${name}...`, color: 'green' }), position: 0 });
  }

  // Show a PE kick/disconnect on the Java "Disconnected" screen.
  kick(message) {
    this.end(formatKick(message), true);
  }

  end(reason, isKick = false) {
    if (this.closed) return;
    clearTimeout(this.limboTimer); clearInterval(this.limboHint);
    if (this.chunkGuard) clearInterval(this.chunkGuard);
    if (isKick) this.log(`[${this.username}] kicked by the PE server: ${String(reason).replace(/§./g, '').replace(/\n/g, ' | ')}`);
    this.stopEating();
    if (reason) {
      this.log(`[${this.username}] disconnect: ${reason}`);
      try { this.client.end(reason); } catch (e) { /* ignore */ }
    }
    this.closed = true;
    if (this.rak) this.rak.close('java client left');
  }

  toJavaItem(it) {
    const j = peItemToJava(it);
    if (it && it.nbt && j.blockId > 0) {
      const tag = nbtle.parseOne(it.nbt);
      if (tag) j.nbtData = tag;
    }
    return j;
  }
  fromJavaItem(j) {
    const it = javaItemToPe(j);
    if (j && j.nbtData) { try { it.nbt = nbtle.write(j.nbtData); } catch (e) { it.nbt = null; } }
    delete it.javaNbt;
    return it;
  }

  // ------------------------------------------------------------------ entity ids
  javaId(peId) {
    if (this.isSelf(peId)) return SELF_JAVA_ID;
    const e = this.entities.get(peId);
    return e ? e.javaId : null;
  }
  isSelf(id) { return id === this.selfEid || id === 0 || (this.selfRealId != null && id === this.selfRealId); }
  allocEntity(peId, data) {
    const old = this.entities.get(peId);
    if (old) this.java('entity_destroy', { entityIds: [old.javaId] });
    const javaId = this.nextJavaId++;
    const e = Object.assign({ peId, javaId }, data);
    this.entities.set(peId, e);
    this.javaToPe.set(javaId, peId);
    return e;
  }

  // ------------------------------------------------------------------ PE -> Java
  onPeRaw(buf, fromBatch = false) {
    if (this.legacy) {
      buf = fromLegacy(buf);
      if (!buf) return;
    }
    if (buf[0] === P.BATCH) {
      const p = decode(buf);
      let inner;
      try { inner = unbatch(p.payload); } catch (e) { this.dbg('bad batch: ' + e.message); return; }
      for (const b of inner) this.onPeRaw(b);
      return;
    }
    let p;
    try { p = decode(buf, this.flavor, this.legacy); } catch (e) { this.dbg(`decode error 0x${buf[0].toString(16)}: ${e.message}`); return; }
    if (this.cfg.debug && p.name !== 'MOVE_ENTITY' && p.name !== 'FULL_CHUNK_DATA' && p.name !== 'SET_ENTITY_MOTION') this.dbg('<- PE', p.name);
    try { this.handlePe(p); } catch (e) { this.log(`[${this.username}] error handling ${p.name}: ${e.stack}`); }
  }

  handlePe(p) {
    switch (p.id) {
      case P.PLAY_STATUS:
        if (p.status === 1 || p.status === 2) this.kick(p.status === 1 ? 'disconnectionScreen.outdatedClient' : 'disconnectionScreen.outdatedServer');
        else if (p.status === 3) this.onSpawn();
        break;
      case P.DISCONNECT: this.kick(p.message); break;
      case P.START_GAME: this.onStartGame(p); break;
      case P.TEXT: this.onText(p); break;
      case P.SET_TIME: this.java('update_time', { age: BigInt(Math.max(0, p.time)), time: BigInt(p.started ? p.time : -Math.max(1, p.time)) }); break;
      case P.SET_SPAWN_POSITION: this.java('spawn_position', { location: { x: p.x, y: p.y, z: p.z } }); break;
      case P.SET_HEALTH: this.onHealth(p.health); break;
      case P.SET_DIFFICULTY: this.java('difficulty', { difficulty: ['peaceful', 'easy', 'normal', 'hard'][p.difficulty & 3] }); break;
      case P.SET_PLAYER_GAMETYPE: this.setGamemode(p.gamemode); break;
      case P.ADVENTURE_SETTINGS: {
        let f = p.flags;
        // Nukkit-Retro uses the 0.16 bit layout (allowFlight 1<<6, noClip 1<<7) for 0.15 clients
        if (this.flavor === 'nukkit' && !this.legacy) f = (f & 1) | ((f & 0x40) ? 0x80 : 0) | ((f & 0x80) ? 0x100 : 0);
        this.advFlags = f; this.sendAbilities(); break;
      }
      case P.UPDATE_ATTRIBUTES: this.onAttributes(p); break;
      case P.FULL_CHUNK_DATA: this.onChunk(p); break;
      case P.UPDATE_BLOCK: for (const r of p.records) this.onBlock(r); break;
      case P.BLOCK_ENTITY_DATA: this.onTile(p); break;
      case P.BLOCK_EVENT: this.onBlockEvent(p); break;
      case P.LEVEL_EVENT: this.onLevelEvent(p); break;
      case P.EXPLODE:
        this.java('explosion', { x: p.x, y: p.y, z: p.z, radius: p.radius, affectedBlockOffsets: p.records.map(([x, y, z]) => ({ x, y, z })), playerMotionX: 0, playerMotionY: 0, playerMotionZ: 0 });
        break;
      case P.MOVE_PLAYER: this.onMovePlayer(p); break;
      case P.MOVE_ENTITY: for (const m of p.moves) this.onMoveEntity(m); break;
      case P.ADD_PLAYER: this.onAddPlayer(p); break;
      case P.ADD_ENTITY: this.onAddEntity(p); break;
      case P.ADD_ITEM_ENTITY: this.onAddItem(p); break;
      case P.ADD_PAINTING: this.onAddPainting(p); break;
      case P.SPAWN_EXPERIENCE_ORB: {
        const e = this.allocEntity(p.eid, { kind: 'orb', peType: 69, x: p.x, y: p.y, z: p.z, yaw: 0, pitch: 0, count: p.count });
        this.spawnJava(e);
        break;
      }
      case P.REMOVE_PLAYER:
      case P.REMOVE_ENTITY: {
        const e = this.entities.get(p.eid);
        if (e) { this.java('entity_destroy', { entityIds: [e.javaId] }); this.entities.delete(p.eid); this.javaToPe.delete(e.javaId); }
        break;
      }
      case P.TAKE_ITEM_ENTITY: {
        const item = this.javaId(p.target), who = this.javaId(p.eid);
        if (item != null && who != null) this.java('collect', { collectedEntityId: item, collectorEntityId: who });
        break;
      }
      case P.SET_ENTITY_MOTION:
        for (const m of p.entities) {
          if (m.eid !== this.selfEid && this.isSelf(m.eid)) continue; // echo of our own motion
          const id = this.javaId(m.eid);
          if (id != null) this.java('entity_velocity', { entityId: id, velocity: { x: vel(m.x), y: vel(m.y), z: vel(m.z) } });
        }
        break;
      case P.SET_ENTITY_DATA: this.onEntityData(p); break;
      case P.SET_ENTITY_LINK: {
        const rider = this.javaId(p.from), vehicle = this.javaId(p.to);
        if (this.isSelf(p.from)) this.vehicle = p.type === 0 ? null : p.to;
        if (rider != null) this.java('attach_entity', { entityId: rider, vehicleId: p.type === 0 ? -1 : (vehicle ?? -1), leash: false });
        break;
      }
      case P.ENTITY_EVENT: {
        const id = this.javaId(p.eid);
        if (id == null) break;
        if (id === SELF_JAVA_ID && (p.event === 3 || p.event === 9)) break; // death screen comes from health; eating is driven by us
        const ent = this.entities.get(p.eid);
        if (ent && ent.kind === 'player') {
          // a Java client removes a dead player entity on its own after the death animation,
          // but PE servers often "respawn" players by just moving them, so re-create it later
          if (p.event === 3) ent.deadAt = Date.now();
          else if (p.event === 17 && ent.deadAt) { this.respawnEntity(ent); break; }
        }
        const map = { 2: 2, 3: 3, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10 };
        if (map[p.event] !== undefined) this.java('entity_status', { entityId: id, entityStatus: map[p.event] });
        break;
      }
      case P.ANIMATE: {
        const id = this.javaId(p.eid);
        if (id != null && id !== SELF_JAVA_ID) this.java('animation', { entityId: id, animation: p.action === 1 ? 0 : p.action === 3 ? 2 : 0 });
        break;
      }
      case P.MOB_EFFECT: {
        const id = this.javaId(p.eid);
        if (id == null) break;
        if (p.eventId === 3) this.java('remove_entity_effect', { entityId: id, effectId: p.effectId });
        else this.java('entity_effect', { entityId: id, effectId: p.effectId, amplifier: p.amplifier, duration: p.duration, hideParticles: !p.particles });
        break;
      }
      case P.MOB_EQUIPMENT: {
        if (this.isSelf(p.eid)) { this.inv.onEquipmentSelf(p); break; }
        const id = this.javaId(p.eid);
        if (id != null) this.java('entity_equipment', { entityId: id, slot: 0, item: this.toJavaItem(p.item) });
        break;
      }
      case P.MOB_ARMOR_EQUIPMENT: {
        const id = this.javaId(p.eid);
        if (id == null || id === SELF_JAVA_ID) break;
        p.slots.forEach((s, i) => this.java('entity_equipment', { entityId: id, slot: 4 - i, item: this.toJavaItem(s) }));
        break;
      }
      case P.PLAYER_LIST: this.onPlayerList(p); break;
      case P.RESPAWN: this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z; break;
      case P.CHANGE_DIMENSION: this.onDimension(p); break;
      case P.CONTAINER_OPEN: this.inv.onContainerOpen(p); break;
      case P.CONTAINER_CLOSE: this.inv.onContainerClose(p); break;
      case P.CONTAINER_SET_CONTENT: this.inv.onSetContent(p); break;
      case P.CONTAINER_SET_SLOT: this.inv.onSetSlot(p); break;
      case P.CONTAINER_SET_DATA: this.inv.onContainerData(p); break;
      case P.CRAFTING_DATA: this.inv.onCraftingData(p); this.dbg(`loaded ${p.entries.length} recipes`); break;
      case P.CHUNK_RADIUS_UPDATED: this.chunkRadius = p.radius; break;
      default: break;
    }
  }

  onStartGame(p) {
    this.selfEid = p.eid;
    this.gamemode = p.gamemode & 3;
    this.dimension = p.dimension;
    this.pos.x = p.x; this.pos.y = p.y; this.pos.z = p.z;
    if (this.limbo) {
      // leave the name-picker world: hop through another dimension so the Java client drops it
      this.limbo = false;
      const javaDim = p.dimension === 1 ? -1 : 0;
      this.java('respawn', { dimension: javaDim === 0 ? -1 : 0, difficulty: 1, gamemode: this.gamemode, levelType: 'default' });
      this.java('respawn', { dimension: javaDim, difficulty: 1, gamemode: this.gamemode, levelType: p.generator === 2 ? 'flat' : 'default' });
    } else if (!this.loggedIn) {
      this.loggedIn = true;
      this.java('login', {
        entityId: SELF_JAVA_ID, gameMode: this.gamemode, dimension: p.dimension === 1 ? -1 : 0,
        difficulty: 1, maxPlayers: this.cfg.java.maxPlayers || 20, levelType: p.generator === 2 ? 'flat' : 'default', reducedDebugInfo: false
      });
      this.java('custom_payload', { channel: 'MC|Brand', data: Buffer.from('\x0cMCPE 0.15.10') });
    }
    this.java('spawn_position', { location: { x: p.spawnX, y: p.spawnY, z: p.spawnZ } });
    this.sendAbilities();
    this.pe(enc.requestChunkRadius({ radius: this.cfg.pe.chunkRadius || 8 }));
  }

  onSpawn() {
    if (!this.spawned) this.log(`[${this.username}] spawned in the PE world`);
    this.spawned = true;
    this.dead = false;
    this.sendPosition();
    this.startChunkGuard();
    this.inv.sendWindow(0);
    this.inv.sendHeld();
    this.inv.setHeld(this.inv.held);
  }

  // Re-send the chunks around the player after spawning/teleporting and keep everything within view
  // distance loaded on the Java side. Whatever drops a spawn chunk (a dimension respawn, a stale
  // unload, the 1.8 client discarding data mid-teleport), the player never stands in void for long.
  startChunkGuard() {
    if (this.chunkGuard) return;
    this.chunkGuard = setInterval(() => {
      if (this.closed) { clearInterval(this.chunkGuard); return; }
      if (!this.spawned) return;
      const r = (this.chunkRadius || this.cfg.pe.chunkRadius || 8);
      const cx = Math.floor(this.pos.x) >> 4, cz = Math.floor(this.pos.z) >> 4;
      for (const [k, col] of this.columns) {
        if (!this.sentChunks.has(k) && Math.abs(col.x - cx) <= r && Math.abs(col.z - cz) <= r) this.sendColumn(col);
      }
    }, 1000);
  }
  resendAround(delays = [300, 1500]) {
    for (const d of delays) {
      setTimeout(() => {
        if (this.closed) return;
        const cx = Math.floor(this.pos.x) >> 4, cz = Math.floor(this.pos.z) >> 4;
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
          const col = this.columns.get(chunkKey(cx + dx, cz + dz));
          if (col) this.sendColumn(col);
        }
      }, d);
    }
  }

  sendPosition() {
    // Remember every position we force on the Java client: until it echoes the latest one back, any
    // movement it sends is from before the teleport. Nukkit even does a fake far-away teleport on
    // world changes; acting on those stale echoes unloaded the freshly sent chunks (= void).
    this.pendingTp = (this.pendingTp || []).filter((t) => Date.now() - t.t < 5000);
    this.pendingTp.push({ x: this.pos.x, y: this.pos.y, z: this.pos.z, t: Date.now() });
    this.resendAround();
    this.java('position', { x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.pos.yaw, pitch: this.pos.pitch, flags: 0 });
  }

  setGamemode(gm) {
    this.gamemode = gm & 3;
    this.java('game_state_change', { reason: 'change_game_mode', gameMode: this.effectiveGamemode() });
    this.sendAbilities();
  }
  effectiveGamemode() {
    if ((this.advFlags & 0x100) && (this.advFlags & 0x80) && !(this.gamemode & 1)) return 3;
    if ((this.advFlags & 0x01) && !(this.gamemode & 1)) return 2;
    return this.gamemode;
  }
  sendAbilities() {
    const gm = this.effectiveGamemode();
    let flags = 0;
    if (gm === 1) flags = 0x01 | 0x04 | 0x08;
    else if (gm === 3) flags = 0x01 | 0x02 | 0x04;
    else if (this.advFlags & 0x80) flags = 0x04;
    this.java('abilities', { flags, flyingSpeed: 0.05, walkingSpeed: 0.1 });
  }

  onHealth(h) {
    this.health = h;
    if (h <= 0 && !this.dead) { this.dead = true; }
    else if (h > 0 && this.dead) { this.dead = false; this.javaRespawn(this.dimension); }
    this.java('update_health', { health: Math.max(0, h), food: Math.round(this.food), foodSaturation: this.saturation });
  }

  onAttributes(p) {
    if (!this.isSelf(p.eid)) return;
    let xpChanged = false;
    let healthChanged = false;
    for (const a of p.entries) {
      // Nukkit: "minecraft:health", "minecraft:player.hunger"; PocketMine/Genisys: "generic.health", "player.hunger"
      const key = String(a.name).replace(/^minecraft:/, '').replace(/^(generic|player)\./, '');
      switch (key) {
        case 'hunger': this.food = a.value; healthChanged = true; break;
        case 'saturation': this.saturation = a.value; healthChanged = true; break;
        case 'health': this.health = a.value; healthChanged = true; break;
        case 'experience': this.xp.bar = a.value; xpChanged = true; break;
        case 'level': this.xp.level = a.value; xpChanged = true; break;
        default: break;
      }
    }
    if (!healthChanged && !xpChanged) return;
    if (this.health <= 0 && !this.dead) this.dead = true;
    else if (this.health > 0 && this.dead) { this.dead = false; this.javaRespawn(this.dimension); }
    if (healthChanged) this.java('update_health', { health: Math.max(0, this.health), food: Math.round(this.food), foodSaturation: this.saturation });
    if (xpChanged) this.java('experience', { experienceBar: Math.max(0, Math.min(1, this.xp.bar)), level: Math.round(this.xp.level), totalExperience: 0 });
  }

  javaRespawn(dimension) {
    this.java('respawn', { dimension: dimension === 1 ? -1 : 0, difficulty: 1, gamemode: this.effectiveGamemode(), levelType: 'default' });
    this.sentChunks.clear();
    for (const col of this.columns.values()) this.sendColumn(col);
    for (const e of this.entities.values()) this.spawnJava(e);
    this.sendPosition();
    this.sendAbilities();
    this.inv.sendWindow(0);
    this.inv.sendHeld();
    this.java('update_health', { health: Math.max(0, this.health), food: Math.round(this.food), foodSaturation: this.saturation });
  }

  onDimension(p) {
    // switch through the other dimension so the Java client really reloads the world
    const javaDim = p.dimension === 1 ? -1 : 0;
    this.java('respawn', { dimension: javaDim === 0 ? -1 : 0, difficulty: 1, gamemode: this.effectiveGamemode(), levelType: 'default' });
    this.dimension = p.dimension;
    // the new dimension's chunks can arrive just before this packet; keep those, drop the old world
    const now = Date.now();
    for (const [k, col] of this.columns) if (now - (col.receivedAt || 0) > 3000) this.columns.delete(k);
    this.sentChunks.clear();
    for (const e of this.entities.values()) this.javaToPe.delete(e.javaId);
    this.entities.clear();
    this.java('respawn', { dimension: javaDim, difficulty: 1, gamemode: this.effectiveGamemode(), levelType: 'default' });
    this.pos.x = p.x; this.pos.y = p.y - EYE; this.pos.z = p.z;
    for (const col of this.columns.values()) this.sendColumn(col);
    this.sendPosition();
    this.pe(enc.playerAction({ eid: this.selfEid, action: PlayerAction.SPAWN_SAME_DIMENSION }));
  }

  // ---------------- chat ----------------
  onText(p) {
    const strip = (s) => s.replace(/^%/, '');
    switch (p.type) {
      case 1: this.chat(p.source ? `<${p.source}> ${p.message}` : p.message); break;
      case 2: {
        const m = /^((?:§.)*)%?(.*)$/.exec(p.message);
        const key = strip(m[2]);
        const color = m[1] || '';
        if (/^[a-z0-9_.]+$/i.test(key) && key.includes('.')) {
          const params = p.parameters.map((x) => ({ text: x.replace(/^%/, '') }));
          this.java('chat', { message: JSON.stringify({ text: color, extra: [{ translate: key, with: params }] }), position: 0 });
        } else {
          let msg = p.message;
          p.parameters.forEach((x, i) => { msg = msg.replace(`{%${i}}`, x).replace('%s', x); });
          this.chat(msg);
        }
        break;
      }
      case 3: case 4: this.java('chat', { message: JSON.stringify({ text: p.message }), position: 2 }); break;
      default: this.chat(p.message);
    }
  }
  chat(text) { this.java('chat', { message: JSON.stringify({ text: String(text) }), position: 0 }); }

  // ---------------- world ----------------
  onChunk(p) {
    let col;
    try { col = decodeChunk(p); } catch (e) { this.log(`[${this.username}] bad chunk: ${e.message}`); return; }
    col.receivedAt = Date.now();
    this.columns.set(chunkKey(col.x, col.z), col);
    this.trimColumns();
    this.sendColumn(col);
  }
  sendColumn(col) {
    this.java('map_chunk', col.toJava(this.dimension !== 1));
    this.sentChunks.add(chunkKey(col.x, col.z));
    for (const t of col.tiles) this.sendTileToJava(t);
  }
  trimColumns() {
    if (this.columns.size <= 1500) return;
    const cx = Math.floor(this.pos.x) >> 4, cz = Math.floor(this.pos.z) >> 4;
    const far = [...this.columns.entries()].filter(([k]) => !this.sentChunks.has(k))
      .sort((a, b) => (Math.abs(b[1].x - cx) + Math.abs(b[1].z - cz)) - (Math.abs(a[1].x - cx) + Math.abs(a[1].z - cz)));
    for (const [k] of far.slice(0, this.columns.size - 1200)) this.columns.delete(k);
  }
  unloadFarChunks() {
    const r = (this.chunkRadius || this.cfg.pe.chunkRadius || 8) + 3;
    const cx = Math.floor(this.pos.x) >> 4, cz = Math.floor(this.pos.z) >> 4;
    const now = Date.now();
    for (const [k, col] of this.columns) {
      if (now - (col.receivedAt || 0) < 10000) continue; // just sent by the server: it wants us to have it
      if (Math.abs(col.x - cx) > r || Math.abs(col.z - cz) > r) {
        if (!this.sentChunks.has(k)) continue;
        this.sentChunks.delete(k);
        this.java('map_chunk', emptyJavaChunk(col.x, col.z));
      }
    }
  }
  blockAt(x, y, z) {
    const col = this.columns.get(chunkKey(x >> 4, z >> 4));
    return col ? col.get(x & 15, y, z & 15) : 0;
  }
  onBlock(r) {
    const state = peBlockToJava(r.id, r.meta);
    const col = this.columns.get(chunkKey(r.x >> 4, r.z >> 4));
    if (col) col.set(r.x & 15, r.y, r.z & 15, state);
    this.java('block_change', { location: { x: r.x, y: r.y, z: r.z }, type: state });
    if (this.pendingSign && (r.id === 63 || r.id === 68) && this.pendingSign.x === r.x && this.pendingSign.y === r.y && this.pendingSign.z === r.z) {
      this.pendingSign = null;
      setTimeout(() => this.java('open_sign_entity', { location: { x: r.x, y: r.y, z: r.z } }), 100);
    }
  }
  onTile(p) {
    const tag = nbtle.parseOneAny(p.nbt);
    if (!tag) return;
    const t = nbtle.simple(tag);
    if (t.x == null) Object.assign(t, { x: p.x, y: p.y, z: p.z });
    this.sendTileToJava(t);
  }
  sendTileToJava(t) {
    if (t.id === 'Sign') {
      const line = (s) => JSON.stringify({ text: String(s || '') });
      this.java('update_sign', { location: { x: t.x, y: t.y, z: t.z }, text1: line(t.Text1), text2: line(t.Text2), text3: line(t.Text3), text4: line(t.Text4) });
    }
  }
  onBlockEvent(p) {
    const state = this.blockAt(p.x, p.y, p.z);
    this.java('block_action', { location: { x: p.x, y: p.y, z: p.z }, byte1: p.case1 & 0xff, byte2: p.case2 & 0xff, blockId: state >> 4 || 54 });
  }
  onLevelEvent(p) {
    const loc = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    const ev = p.evid & ~0x4000;
    if (ev === 3001) { this.java('game_state_change', { reason: 'start_raining', gameMode: 0 }); this.java('game_state_change', { reason: 'rain_level_change', gameMode: 1 }); return; }
    if (ev === 3003) { this.java('game_state_change', { reason: 'stop_raining', gameMode: 0 }); return; }
    if (ev === 3002) { this.java('game_state_change', { reason: 'thunder_level_change', gameMode: 1 }); return; }
    if (ev === 3004) { this.java('game_state_change', { reason: 'thunder_level_change', gameMode: 0 }); return; }
    if (ev === 2001) {
      const id = p.data & 0xfff, meta = (p.data >> 12) & 15;
      const st = peBlockToJava(id & 0xff, meta);
      this.java('world_event', { effectId: 2001, location: loc, data: (st >> 4) | ((st & 15) << 12), global: false });
      return;
    }
    if (ev === 2000 || ev === 2002 || ev === 2004) { this.java('world_event', { effectId: ev, location: loc, data: p.data, global: false }); return; }
    const s = SOUNDS[ev];
    if (s) this.java('named_sound_effect', { soundName: s[0], x: Math.round(p.x * 8), y: Math.round(p.y * 8), z: Math.round(p.z * 8), volume: 1, pitch: Math.min(255, Math.round(63 * s[1])) });
  }

  // ---------------- entities ----------------
  onMovePlayer(p) {
    // Only the StartGame id means "server moved you". Genisys also broadcasts our own movement back to us
    // under our real entity id; following those made the Java player rubber-band around.
    if (this.isSelf(p.eid)) {
      if (p.eid !== this.selfEid) return;
      this.pos.x = p.x; this.pos.y = p.y - EYE; this.pos.z = p.z; this.pos.yaw = p.yaw; this.pos.pitch = p.pitch;
      if (this.spawned) this.sendPosition();
      return;
    }
    const e = this.entities.get(p.eid);
    if (!e) return;
    if (e.deadAt && Date.now() - e.deadAt > 1200) { e.x = p.x; e.y = p.y - EYE; e.z = p.z; this.respawnEntity(e); }
    e.x = p.x; e.y = p.y - EYE; e.z = p.z; e.yaw = p.bodyYaw; e.headYaw = p.yaw; e.pitch = p.pitch;
    this.java('entity_teleport', { entityId: e.javaId, x: fixed(e.x), y: fixed(e.y), z: fixed(e.z), yaw: toAngle(e.yaw), pitch: toAngle(e.pitch), onGround: p.onGround });
    this.java('entity_head_rotation', { entityId: e.javaId, headYaw: toAngle(e.headYaw) });
  }
  onMoveEntity(p) {
    const e = this.entities.get(p.eid);
    if (!e) return;
    const off = this.flavor === 'nukkit' ? nukkitEyeOffset(e.kind === 'player' ? 'player' : e.peType) : eyeOffset(e.kind === 'player' ? 'player' : e.peType);
    if (e.deadAt && Date.now() - e.deadAt > 1200) { e.x = p.x; e.y = p.y - off; e.z = p.z; this.respawnEntity(e); }
    e.x = p.x; e.y = p.y - off; e.z = p.z; e.yaw = p.yaw; e.pitch = p.pitch; e.headYaw = p.headYaw;
    this.java('entity_teleport', { entityId: e.javaId, x: fixed(e.x), y: fixed(e.y), z: fixed(e.z), yaw: toAngle(e.yaw), pitch: toAngle(e.pitch), onGround: false });
    if (e.kind === 'mob' || e.kind === 'player') this.java('entity_head_rotation', { entityId: e.javaId, headYaw: toAngle(e.headYaw) });
  }

  javaMetadata(meta, extra = []) {
    const out = [];
    if (meta) {
      if (meta[0]) out.push({ key: 0, type: 0, value: meta[0].value & 0x3f });
      if (meta[1]) out.push({ key: 1, type: 1, value: meta[1].value });
      if (meta[2] && typeof meta[2].value === 'string') out.push({ key: 2, type: 4, value: meta[2].value });
      if (meta[3]) out.push({ key: 3, type: 0, value: meta[3].value ? 1 : 0 });
    }
    return out.concat(extra);
  }

  onAddPlayer(p) {
    if (p.uuid === this.uuid) return;
    if (!this.tab.has(p.uuid)) this.addTab(p.uuid, p.username);
    const e = this.allocEntity(p.eid, { kind: 'player', uuid: p.uuid, name: p.username, x: p.x, y: p.y, z: p.z, yaw: p.yaw, headYaw: p.headYaw, pitch: p.pitch, item: p.item, meta: p.metadata });
    this.spawnJava(e);
  }
  onAddEntity(p) {
    const def = ENTITY[p.type];
    if (!def) { this.dbg(`unmapped PE entity type ${p.type}`); return; }
    const e = this.allocEntity(p.eid, { kind: def.living ? 'mob' : 'object', peType: p.type, def, x: p.x, y: p.y, z: p.z, yaw: p.yaw, headYaw: p.yaw, pitch: p.pitch, vx: p.speedX, vy: p.speedY, vz: p.speedZ, meta: p.metadata });
    this.spawnJava(e);
  }
  onAddItem(p) {
    const e = this.allocEntity(p.eid, { kind: 'item', peType: 64, x: p.x, y: p.y, z: p.z, yaw: 0, pitch: 0, vx: p.speedX, vy: p.speedY, vz: p.speedZ, item: p.item });
    this.spawnJava(e);
  }
  onAddPainting(p) {
    const e = this.allocEntity(p.eid, { kind: 'painting', peType: 83, x: p.x, y: p.y, z: p.z, direction: p.direction, title: p.title });
    this.spawnJava(e);
  }

  respawnEntity(e) {
    e.deadAt = null;
    this.java('entity_destroy', { entityIds: [e.javaId] });
    if (e.kind === 'player' && !this.tab.has(e.uuid)) this.addTab(e.uuid, e.name);
    this.spawnJava(e);
  }

  spawnJava(e) {
    const base = { entityId: e.javaId, x: fixed(e.x), y: fixed(e.y), z: fixed(e.z) };
    switch (e.kind) {
      case 'player':
        if (!this.tab.has(e.uuid)) this.addTab(e.uuid, e.name);
        this.java('named_entity_spawn', Object.assign(base, {
          playerUUID: e.uuid, yaw: toAngle(e.yaw), pitch: toAngle(e.pitch), currentItem: 0,
          metadata: this.javaMetadata(e.meta, [{ key: 6, type: 3, value: 20 }, { key: 10, type: 0, value: 127 }])
        }));
        this.java('entity_head_rotation', { entityId: e.javaId, headYaw: toAngle(e.headYaw ?? e.yaw) });
        if (e.item && !isEmpty(e.item)) this.java('entity_equipment', { entityId: e.javaId, slot: 0, item: this.toJavaItem(e.item) });
        break;
      case 'mob': {
        const extra = [];
        if (e.def.villager) extra.push({ key: 13, type: 0, value: 1 });
        this.java('spawn_entity_living', Object.assign(base, {
          type: e.def.living, yaw: toAngle(e.yaw), pitch: toAngle(e.pitch), headPitch: toAngle(e.headYaw ?? e.yaw),
          velocity: { x: vel(e.vx), y: vel(e.vy), z: vel(e.vz) }, metadata: this.javaMetadata(e.meta, extra)
        }));
        break;
      }
      case 'object': {
        let objectData = e.def.data || 1;
        if (e.def.falling) {
          const info = e.meta && e.meta[20] ? e.meta[20].value : 12;
          const st = peBlockToJava(info & 0xff, (info >> 8) & 15);
          objectData = (st >> 4) | ((st & 15) << 12);
        }
        if (e.peType === 84 || e.peType === 90) objectData = e.def.data || 0;
        const pk = Object.assign(base, { type: e.def.object, pitch: toAngle(e.pitch), yaw: toAngle(e.yaw), objectData });
        if (objectData !== 0) pk.velocity = { x: vel(e.vx), y: vel(e.vy), z: vel(e.vz) };
        this.java('spawn_entity', pk);
        const md = this.javaMetadata(e.meta);
        if (md.length) this.java('entity_metadata', { entityId: e.javaId, metadata: md });
        break;
      }
      case 'item':
        this.java('spawn_entity', Object.assign(base, { type: 2, pitch: 0, yaw: 0, objectData: 1, velocity: { x: vel(e.vx), y: vel(e.vy), z: vel(e.vz) } }));
        this.java('entity_metadata', { entityId: e.javaId, metadata: [{ key: 10, type: 5, value: this.toJavaItem(e.item) }] });
        break;
      case 'orb':
        this.java('spawn_entity_experience_orb', Object.assign(base, { count: e.count || 1 }));
        break;
      case 'painting': {
        const dir = [2, 3, 0, 1][e.direction & 3] ?? 0;
        this.java('spawn_entity_painting', { entityId: e.javaId, title: e.title, location: { x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z) }, direction: dir });
        break;
      }
      default: break;
    }
  }

  onEntityData(p) {
    const id = this.javaId(p.eid);
    if (id == null) return;
    const e = this.entities.get(p.eid);
    if (e) e.meta = Object.assign(e.meta || {}, p.metadata);
    const md = this.javaMetadata(p.metadata);
    if (md.length) this.java('entity_metadata', { entityId: id, metadata: md });
  }

  // Java 1.8 only accepts 16-character profile names. Longer PE names get a unique 16-char profile
  // name, the full name in the tab list (displayName), and up to 48 characters on the nametag via a team
  // prefix/suffix.
  addTab(uuid, name) {
    name = String(name);
    this.tab.set(uuid, name);
    let profile = name;
    if (name.length > 16) {
      profile = name.length > 32 ? name.slice(16, 32) : name.slice(0, 16);
      const used = new Set([...(this.profileNames || new Map()).values()]);
      for (let i = 0; used.has(profile); i++) profile = profile.slice(0, 13) + '~' + String(i).padStart(2, '0');
    }
    (this.profileNames = this.profileNames || new Map()).set(uuid, profile);
    this.java('player_info', { action: 'add_player', data: [{ uuid, name: profile, properties: [], gamemode: 0, ping: 50, displayName: name.length > 16 ? JSON.stringify({ text: name }) : undefined }] });
    if (name.length > 16) {
      const team = 'ln' + uuid.replace(/-/g, '').slice(0, 14);
      const prefix = name.length > 32 ? name.slice(0, 16) : '';
      const suffix = name.length > 32 ? name.slice(32, 48) : name.slice(16, 32);
      // 1.8 crashes on creating an existing team or removing a missing one, so track them
      this.teams = this.teams || new Set();
      if (this.teams.has(team)) {
        this.java('scoreboard_team', { team, mode: 2, name: team, prefix, suffix, friendlyFire: 1, nameTagVisibility: 'always', color: -1 });
        this.java('scoreboard_team', { team, mode: 3, players: [profile] });
      } else {
        this.teams.add(team);
        this.java('scoreboard_team', { team, mode: 0, name: team, prefix, suffix, friendlyFire: 1, nameTagVisibility: 'always', color: -1, players: [profile] });
      }
    }
  }
  removeTab(uuid) {
    const name = this.tab.get(uuid);
    this.tab.delete(uuid);
    const team = 'ln' + uuid.replace(/-/g, '').slice(0, 14);
    if (this.teams && this.teams.has(team)) { this.teams.delete(team); this.java('scoreboard_team', { team, mode: 1 }); }
    if (this.profileNames) this.profileNames.delete(uuid);
  }
  onPlayerList(p) {
    if (p.type === 0) {
      for (const en of p.entries) {
        if (en.uuid === this.uuid) { this.selfRealId = en.eid; continue; }
        this.addTab(en.uuid, en.name);
      }
    } else {
      const data = p.entries.filter((en) => this.tab.has(en.uuid)).map((en) => ({ uuid: en.uuid }));
      for (const d of data) this.removeTab(d.uuid);
      if (data.length) this.java('player_info', { action: 'remove_player', data });
    }
  }

  // ------------------------------------------------------------------ Java -> PE
  onJava(name, d) {
    if (!this.loggedIn) return;
    if (this.limbo) {
      if (name === 'chat' && this.nameResolve) {
        let msg = String(d.message);
        if (!this.namePart) msg = msg.replace(/^\/+/, '');
        // the 1.8 chat box holds 100 characters: a line ending in "+" continues the name in the next message
        if (msg.endsWith('+') && msg.length > 1) {
          this.namePart = (this.namePart || '') + msg.slice(0, -1);
          this.java('chat', { message: JSON.stringify({ text: `Name so far (${this.namePart.length}): ${this.namePart}`, color: 'yellow' }), position: 0 });
          return;
        }
        const full = (this.namePart || '') + msg;
        this.namePart = '';
        this.nameResolve(full);
      }
      return;
    }
    switch (name) {
      case 'position': this.move(d.x, d.y, d.z, this.pos.yaw, this.pos.pitch, d.onGround); break;
      case 'look': this.move(this.pos.x, this.pos.y, this.pos.z, d.yaw, d.pitch, d.onGround); break;
      case 'position_look': this.move(d.x, d.y, d.z, d.yaw, d.pitch, d.onGround); break;
      case 'flying': this.move(this.pos.x, this.pos.y, this.pos.z, this.pos.yaw, this.pos.pitch, d.onGround); break;
      case 'chat': this.onJavaChat(d.message); break;
      case 'arm_animation': this.pe(enc.animate({ action: 1, eid: this.selfEid })); break;
      case 'held_item_slot': if (d.slotId >= 0 && d.slotId < 9) { this.stopEating(); this.inv.setHeld(d.slotId); } break;
      case 'block_dig': this.onDig(d); break;
      case 'block_place': this.onPlace(d); break;
      case 'use_entity': {
        const pe = this.javaToPe.get(d.target);
        if (pe == null) break;
        if (d.mouse === 1) this.pe(enc.interact({ action: 2, target: pe, flavor: this.flavor }));
        else if (d.mouse === 0) this.pe(enc.interact({ action: 1, target: pe, flavor: this.flavor }));
        break;
      }
      case 'entity_action': {
        const a = d.actionId;
        const map = { start_sneaking: PlayerAction.START_SNEAK, stop_sneaking: PlayerAction.STOP_SNEAK, stop_sleeping: PlayerAction.STOP_SLEEPING, start_sprinting: PlayerAction.START_SPRINT, stop_sprinting: PlayerAction.STOP_SPRINT };
        if (a === 'start_sneaking') this.sneaking = true; else if (a === 'stop_sneaking') this.sneaking = false;
        if (map[a] !== undefined) this.pe(enc.playerAction({ eid: this.selfEid, action: map[a] }));
        break;
      }
      case 'steer_vehicle':
        if (d.jump & 2) {
          if (this.vehicle != null) this.pe(enc.interact({ action: 3, target: this.vehicle, flavor: this.flavor }));
        } else this.pe(enc.playerInput({ motX: d.sideways, motY: d.forward, jumping: !!(d.jump & 1), sneaking: false }));
        break;
      case 'client_command':
        if (d.payload === 'perform_respawn' || d.payload === 0) this.pe(enc.playerAction({ eid: this.selfEid, action: PlayerAction.SPAWN_SAME_DIMENSION }));
        break;
      case 'settings':
        if (d.viewDistance > 0) this.pe(enc.requestChunkRadius({ radius: Math.min(d.viewDistance, this.cfg.pe.chunkRadius || 8) }));
        break;
      case 'window_click': this.inv.onWindowClick(d); break;
      case 'close_window': this.inv.onJavaClose(d.windowId); break;
      case 'set_creative_slot': this.inv.onCreativeSlot(d.slot, this.fromJavaItem(d.item)); break;
      case 'update_sign': this.onJavaSign(d); break;
      case 'tab_complete': this.java('tab_complete', { matches: [] }); break;
      default: break;
    }
  }

  move(x, y, z, yaw, pitch, onGround) {
    if (this.pendingTp && this.pendingTp.length) {
      const near = (t) => Math.abs(t.x - x) < 0.01 && Math.abs(t.z - z) < 0.01 && Math.abs(t.y - y) < 0.1;
      const i = this.pendingTp.findIndex(near);
      if (i >= 0) this.pendingTp.splice(0, i + 1);
      else if (Date.now() - this.pendingTp[this.pendingTp.length - 1].t > 1000) this.pendingTp = []; // client never confirmed; trust it again
      if (i < 0 && this.pendingTp.length) return;       // movement from before the teleport
      if (i >= 0 && this.pendingTp.length) return;      // echo of an intermediate teleport
    }
    this.pos.x = x; this.pos.y = y; this.pos.z = z; this.pos.yaw = yaw; this.pos.pitch = pitch; this.pos.onGround = onGround;
    if (!this.spawned || this.dead) return;
    const l = this.lastSent, now = Date.now();
    const moved = Math.abs(l.x - x) + Math.abs(l.y - y) + Math.abs(l.z - z) > 0.001 || Math.abs(l.yaw - yaw) + Math.abs(l.pitch - pitch) > 0.5;
    if (!moved && now - l.t < 1000) return;
    if (l.onGround && !onGround && y > l.y + 0.05) this.pe(enc.playerAction({ eid: this.selfEid, action: PlayerAction.JUMP }));
    l.onGround = onGround;
    const wrapYaw = ((yaw % 360) + 360) % 360;
    this.pe(enc.movePlayer({ eid: this.selfEid, x, y: y + EYE, z, yaw: wrapYaw, bodyYaw: wrapYaw, pitch, mode: 0, onGround }));
    const oldChunk = (Math.floor(l.x) >> 4) + ',' + (Math.floor(l.z) >> 4);
    Object.assign(l, { x, y, z, yaw, pitch, t: now });
    if (oldChunk !== (Math.floor(x) >> 4) + ',' + (Math.floor(z) >> 4)) this.unloadFarChunks();
  }

  onJavaChat(msg) {
    for (const line of String(msg).split('\n')) {
      if (!line.trim()) continue;
      this.pe(enc.text({ type: 1, source: this.username, message: line.slice(0, 255) }));
    }
  }

  onDig(d) {
    const { x, y, z } = d.location;
    switch (d.status) {
      case 0:
        if (this.gamemode & 1) { this.pe(enc.removeBlock({ eid: this.selfEid, x, y, z, flavor: this.flavor })); break; }
        this.breaking = { x, y, z };
        this.pe(enc.playerAction({ eid: this.selfEid, action: PlayerAction.START_BREAK, x, y, z, face: d.face }));
        break;
      case 1:
        this.breaking = null;
        this.pe(enc.playerAction({ eid: this.selfEid, action: PlayerAction.ABORT_BREAK, x, y, z, face: d.face }));
        break;
      case 2:
        this.breaking = null;
        this.pe(enc.playerAction({ eid: this.selfEid, action: PlayerAction.STOP_BREAK, x, y, z, face: d.face }));
        this.pe(enc.removeBlock({ eid: this.selfEid, x, y, z, flavor: this.flavor }));
        break;
      case 3: this.inv.dropHeld(true); break;
      case 4: this.inv.dropHeld(false); break;
      case 5: this.stopEating(); this.pe(enc.playerAction({ eid: this.selfEid, action: PlayerAction.RELEASE_ITEM, x: 0, y: 0, z: 0, face: 255 })); break;
      default: break;
    }
  }

  onPlace(d) {
    const { x, y, z } = d.location;
    const held = this.inv.heldItemServer();
    const common = { fx: (d.cursorX || 0) / 16, fy: (d.cursorY || 0) / 16, fz: (d.cursorZ || 0) / 16, posX: this.pos.x, posY: this.pos.y + EYE, posZ: this.pos.z, slot: this.inv.held, item: held };
    if (d.direction === -1 || d.direction === 255) {
      this.pe(enc.useItem(Object.assign({ x: 0, y: 0, z: 0, face: 0xff }, common)));
      if (isConsumable(held)) this.startEating();
      return;
    }
    const face = d.direction;
    const target = this.blockAt(x, y, z) >> 4;
    this.pe(enc.useItem(Object.assign({ x, y, z, face }, common)));
    if (target === 58 && !this.sneaking) { this.inv.openWorkbench(); return; }
    if (held && (held.id === 323)) {
      const off = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][face] || [0, 0, 0];
      this.pendingSign = { x: x + off[0], y: y + off[1], z: z + off[2] };
    }
  }

  // PE clients finish eating/drinking themselves and tell the server with EntityEvent(USE_ITEM);
  // a Java client never sends anything when it finishes, so time the 32 ticks here.
  startEating() {
    this.stopEating();
    const slot = this.inv.held;
    this.eatTimer = setTimeout(() => {
      this.eatTimer = null;
      if (this.closed || this.dead || this.inv.held !== slot) return;
      this.pe(enc.entityEvent({ eid: this.selfEid, event: 9 }));
    }, 1650);
  }
  stopEating() { if (this.eatTimer) { clearTimeout(this.eatTimer); this.eatTimer = null; } }

  onJavaSign(d) {
    const text = (s) => { try { const j = JSON.parse(s); return typeof j === 'string' ? j : (j.text || '') + (j.extra || []).map((e) => (typeof e === 'string' ? e : e.text || '')).join(''); } catch (e) { return String(s || ''); } };
    const { x, y, z } = d.location;
    const tag = nbtle.comp({
      id: nbtle.string('Sign'),
      Text1: nbtle.string(text(d.text1)), Text2: nbtle.string(text(d.text2)),
      Text3: nbtle.string(text(d.text3)), Text4: nbtle.string(text(d.text4)),
      x: nbtle.int(x), y: nbtle.int(y), z: nbtle.int(z)
    }, '');
    this.pe(enc.blockEntityData({ x, y, z, nbt: this.flavor === 'nukkit' ? nbtle.writeNetwork(tag) : nbtle.write(tag), flavor: this.flavor }));
  }
}

module.exports = { Session };
