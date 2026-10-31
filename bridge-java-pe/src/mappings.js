'use strict';
// ID translation tables between MCPE 0.15.x and Java Edition 1.8.x.

// ---------- blocks: PE id/meta -> Java id/meta ----------
const BLOCK_ID = new Uint16Array(256);
for (let i = 0; i < 256; i++) BLOCK_ID[i] = i <= 197 ? i : 1;

// PE-only / reshuffled block ids
Object.assign(BLOCK_ID, {
  95: 166,   // invisible bedrock -> barrier
  125: 158,  // dropper
  126: 157,  // activator rail
  157: 125,  // double wooden slab
  158: 126,  // wooden slab
  198: 2,    // grass path -> grass
  199: 0,    // item frame block -> air (frames are entities on Java)
  243: 3,    // podzol -> dirt:2 (meta fixed below)
  244: 141,  // beetroot -> carrots
  245: 4,    // stonecutter -> cobblestone
  246: 49,   // glowing obsidian -> obsidian
  247: 42,   // nether reactor core -> iron block
  248: 1, 249: 1, // update blocks
  255: 0
});
// ids that are free/unused in 0.15 but would be "real" blocks on Java and look wrong
for (const i of [166, 176, 177]) BLOCK_ID[i] = i; // barrier, banners exist on both

function slabMeta(m) { const t = m & 7; return (m & 8) | (t === 6 ? 7 : t === 7 ? 6 : t); }
function trapdoorMeta(m) { return (m & 3) | ((m & 4) ? 8 : 0) | ((m & 8) ? 4 : 0); }
const FENCE_JAVA = [85, 188, 189, 190, 192, 191]; // PE fence meta: oak,spruce,birch,jungle,acacia,dark oak

// returns Java block state (id << 4 | meta)
function peBlockToJava(id, meta) {
  switch (id) {
    case 0: return 0;
    case 43: case 44: return (id << 4) | slabMeta(meta);
    case 85: return ((FENCE_JAVA[meta] || 85) << 4);
    case 96: case 167: return (id << 4) | trapdoorMeta(meta);
    case 243: return (3 << 4) | 2;
    case 198: return 2 << 4;
    case 244: return (141 << 4) | Math.min(7, meta * 2);
    default: return (BLOCK_ID[id] << 4) | (meta & 0x0f);
  }
}

// precomputed lookup for chunk conversion: index (id<<4|meta)
const BLOCK_LUT = new Uint16Array(4096);
for (let id = 0; id < 256; id++) for (let m = 0; m < 16; m++) BLOCK_LUT[(id << 4) | m] = peBlockToJava(id, m);

// ---------- items ----------
// PE item id -> Java item id (only differences); the reverse is derived.
const ITEM_PE_TO_JAVA = {
  95: 166, 125: 158, 126: 157, 157: 125, 158: 126, 198: 2, 243: 3, 244: 141, 245: 4, 246: 49, 247: 42, 248: 1, 249: 1,
  410: 154,  // hopper item
  457: 391,  // beetroot -> carrot
  458: 295,  // beetroot seeds -> wheat seeds
  459: 282,  // beetroot soup -> mushroom stew
  438: 373,  // splash potion -> potion (+ splash flag)
  // newer PE items that do not exist on Java 1.8
  444: 299, 437: 373, 432: 289, 433: 289, 434: 289, 435: 289, 436: 289
};
const ITEM_JAVA_TO_PE = {
  166: 95, 158: 125, 157: 126, 125: 157, 126: 158, 154: 410,
  // Java-only items without PE 0.15 equivalents
  188: 85, 189: 85, 190: 85, 191: 85, 192: 85
};
const FENCE_JAVA_TO_PE_META = { 188: 1, 189: 2, 190: 3, 192: 4, 191: 5 };

function peItemToJava(item) {
  if (!item || !item.id || item.count <= 0) return { blockId: -1 };
  let id = item.id, damage = item.damage === 0xffff ? 0 : item.damage;
  if (id === 85 && damage > 0) { id = FENCE_JAVA[damage] || 85; damage = 0; }
  else if (id === 43 || id === 44) damage = slabMeta(damage);
  else if (id === 325) { // PE bucket uses meta for contents
    if (damage === 8 || damage === 9) { id = 326; damage = 0; } else if (damage === 10 || damage === 11) { id = 327; damage = 0; } else if (damage === 1) { id = 335; damage = 0; }
  } else if (id === 438) { id = 373; damage = (damage & 0x3fff) | 0x4000; }
  else if (id === 373) damage = PE_POTION_TO_JAVA[damage] ?? damage;
  else if (id === 383) damage = SPAWN_EGG_PE_TO_JAVA[damage] ?? damage;
  else if (ITEM_PE_TO_JAVA[id] !== undefined) id = ITEM_PE_TO_JAVA[id];
  else if (id > 197 && id < 256) id = 1;
  else if (id > 431) id = 1;
  const out = { blockId: id, itemCount: Math.min(127, item.count), itemDamage: damage };
  if (item.javaNbt) out.nbtData = item.javaNbt;
  return out;
}

function javaItemToPe(item) {
  if (!item || item.blockId == null || item.blockId < 0) return { id: 0, count: 0, damage: 0, nbt: null };
  let id = item.blockId, damage = item.itemDamage || 0;
  if (FENCE_JAVA_TO_PE_META[id] !== undefined) { damage = FENCE_JAVA_TO_PE_META[id]; id = 85; }
  else if (id === 43 || id === 44) damage = slabMeta(damage);
  else if (id === 326) { id = 325; damage = 8; } else if (id === 327) { id = 325; damage = 10; } else if (id === 335) { id = 325; damage = 1; }
  else if (id === 373 && (damage & 0x4000)) { id = 438; damage = JAVA_POTION_TO_PE[damage & 0x3fff] ?? 0; }
  else if (id === 373) damage = JAVA_POTION_TO_PE[damage] ?? damage;
  else if (id === 383) damage = SPAWN_EGG_JAVA_TO_PE[damage] ?? damage;
  else if (ITEM_JAVA_TO_PE[id] !== undefined) id = ITEM_JAVA_TO_PE[id];
  return { id, count: item.itemCount || 1, damage, nbt: null, javaNbt: item.nbtData };
}

// Potions: PE uses plain ids (0 water ... 35), Java uses bitfield damage values. Common ones only.
const PE_POTION_TO_JAVA = {
  0: 0, 1: 64, 2: 64, 3: 16, 4: 32, 5: 8198, 6: 8262, 7: 8193, 8: 8257, 9: 8257, 10: 8226, 11: 8290, 12: 8258,
  13: 8195, 14: 8259, 15: 8195, 16: 8227, 17: 8227, 18: 8202, 19: 8266, 20: 8266, 21: 8197, 22: 8229, 23: 8204,
  24: 8236, 25: 8196, 26: 8260, 27: 8228, 28: 8193, 29: 8257, 30: 8225, 31: 8201, 32: 8265, 33: 8233, 34: 8200, 35: 8264
};
const JAVA_POTION_TO_PE = {};
for (const [pe, j] of Object.entries(PE_POTION_TO_JAVA)) if (JAVA_POTION_TO_PE[j] === undefined) JAVA_POTION_TO_PE[j] = Number(pe);

// ---------- entities ----------
// PE network id -> { living: java mob type } | { object: java object type, data?, height }
const ENTITY = {
  10: { living: 93, height: 0.7 }, 11: { living: 92, height: 1.4 }, 12: { living: 90, height: 0.9 },
  13: { living: 91, height: 1.3 }, 14: { living: 95, height: 0.85 }, 15: { living: 120, height: 1.95 },
  16: { living: 96, height: 1.4 }, 17: { living: 94, height: 0.95 }, 18: { living: 101, height: 0.5 },
  19: { living: 65, height: 0.9 }, 20: { living: 99, height: 2.7 }, 21: { living: 97, height: 1.9 },
  22: { living: 98, height: 0.7 }, 32: { living: 54, height: 1.95 }, 33: { living: 50, height: 1.7 },
  34: { living: 51, height: 1.99 }, 35: { living: 52, height: 0.9 }, 36: { living: 57, height: 1.95 },
  37: { living: 55, height: 0.51 }, 38: { living: 58, height: 2.9 }, 39: { living: 60, height: 0.3 },
  40: { living: 59, height: 0.5 }, 41: { living: 56, height: 4 }, 42: { living: 62, height: 0.51 },
  43: { living: 61, height: 1.8 }, 44: { living: 54, height: 1.95, villager: true }, 45: { living: 66, height: 1.95 },
  46: { living: 51, height: 1.99 }, 47: { living: 54, height: 1.95 },
  65: { object: 50, height: 0.98 }, 66: { object: 70, height: 0.98, falling: true }, 68: { object: 75, height: 0.25 },
  77: { object: 90, height: 0.25 }, 80: { object: 60, height: 0.5 }, 81: { object: 61, height: 0.25 },
  82: { object: 62, height: 0.25 }, 84: { object: 10, height: 0.7 }, 86: { object: 73, height: 0.25 },
  90: { object: 1, height: 0.6 }, 96: { object: 10, data: 5, height: 0.7 }, 97: { object: 10, data: 3, height: 0.7 },
  98: { object: 10, data: 1, height: 0.7 },
  // newer ids some servers (Nukkit-Retro) may still send
  23: { living: 100, height: 1.6 }, 24: { living: 100, height: 1.6 }, 25: { living: 100, height: 1.6 },
  26: { living: 100, height: 1.6 }, 27: { living: 100, height: 1.6 }, 48: { living: 51, height: 2.4 },
  49: { living: 68, height: 0.85 }, 50: { living: 68, height: 2 }, 52: { living: 64, height: 3.5 },
  53: { living: 63, height: 8 }, 55: { living: 67, height: 0.3 }
};

// Genisys sends MoveEntity y as feet + eyeHeight where eyeHeight = height/2 + 0.1 (Human: 1.62)
function eyeOffset(peType) {
  if (peType === 'player') return 1.62;
  const e = ENTITY[peType];
  if (peType === 64) return 0.225; // items
  const h = e ? e.height : 1.8;
  return h / 2 + 0.1;
}

// Nukkit sends MoveEntity y as feet + getBaseOffset(): humans 1.62, items 0.125, TNT/falling 0.49, boats/minecarts 0.35
function nukkitEyeOffset(peType) {
  if (peType === 'player') return 1.62;
  if (peType === 64) return 0.125;
  if (peType === 65 || peType === 66) return 0.49;
  if ([84, 90, 96, 97, 98].includes(peType)) return 0.35;
  return 0;
}

const SPAWN_EGG_PE_TO_JAVA = {};
const SPAWN_EGG_JAVA_TO_PE = {};
for (const [pe, e] of Object.entries(ENTITY)) if (e.living && !e.villager && Number(pe) < 46) { SPAWN_EGG_PE_TO_JAVA[pe] = e.living; SPAWN_EGG_JAVA_TO_PE[e.living] = Number(pe); }

// ---------- stack sizes ----------
const STACK_1 = new Set([256, 257, 258, 259, 261, 267, 268, 269, 270, 271, 272, 273, 274, 275, 276, 277, 278, 279,
  282, 283, 284, 285, 286, 290, 291, 292, 293, 294, 298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310,
  311, 312, 313, 314, 315, 316, 317, 325, 326, 327, 328, 329, 333, 335, 342, 343, 346, 347, 354, 355, 359, 373, 387,
  398, 403, 407, 408, 417, 418, 419, 438, 459]);
const STACK_16 = new Set([323, 332, 344, 368, 379, 380, 390, 426]);
function maxStack(peId) { return STACK_1.has(peId) ? 1 : STACK_16.has(peId) ? 16 : 64; }

module.exports = {
  peBlockToJava, BLOCK_LUT, peItemToJava, javaItemToPe, ENTITY, eyeOffset, nukkitEyeOffset, maxStack
};
