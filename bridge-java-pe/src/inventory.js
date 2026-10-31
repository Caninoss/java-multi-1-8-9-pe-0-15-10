'use strict';
// Java 1.8 window/click model on top of the MCPE 0.15 (Genisys) inventory transaction system.
//
// Genisys keeps a per-player "floating inventory": every ContainerSetSlot that lowers a slot puts the
// difference into it, every one that raises a slot takes from it. That is exactly a Java cursor/crafting
// grid, so the proxy simulates Java clicks locally and only sends the resulting per-slot changes.
const { enc } = require('./pe');
const { maxStack, peItemToJava } = require('./mappings');
const { RecipeBook } = require('./recipes');

const EMPTY = Object.freeze({ id: 0, count: 0, damage: 0, nbt: null });
const isEmpty = (it) => !it || !it.id || it.count <= 0;
const clone = (it) => (isEmpty(it) ? EMPTY : { id: it.id, count: it.count, damage: it.damage, nbt: it.nbt, javaNbt: it.javaNbt });
const withCount = (it, n) => (n <= 0 ? EMPTY : Object.assign(clone(it), { count: n }));
function sameKind(a, b) {
  if (isEmpty(a) || isEmpty(b)) return false;
  if (a.id !== b.id || a.damage !== b.damage) return false;
  const na = a.nbt ? a.nbt.toString('hex') : '', nb = b.nbt ? b.nbt.toString('hex') : '';
  return na === nb;
}
function equalItems(a, b) { return (isEmpty(a) && isEmpty(b)) || (sameKind(a, b) && a.count === b.count); }

const ARMOR_FOR_SLOT = [
  (id) => [298, 302, 306, 310, 314, 86, 91, 397].includes(id),
  (id) => [299, 303, 307, 311, 315].includes(id),
  (id) => [300, 304, 308, 312, 316].includes(id),
  (id) => [301, 305, 309, 313, 317].includes(id)
];

const PE_WINDOW_ARMOR = 0x78;
const WORKBENCH_WINDOW = 120;

const JAVA_TYPES = {
  0: 'minecraft:chest', 2: 'minecraft:furnace', 3: 'minecraft:enchanting_table', 4: 'minecraft:brewing_stand',
  5: 'minecraft:anvil', 6: 'minecraft:dispenser', 7: 'minecraft:dropper', 8: 'minecraft:hopper'
};
const TITLES = {
  0: 'Chest', 2: 'Furnace', 3: 'Enchant', 4: 'Brewing Stand', 5: 'Repair & Name', 6: 'Dispenser', 7: 'Dropper', 8: 'Hopper'
};

class Inventory {
  constructor(session) {
    this.s = session;
    this.inv = new Array(36).fill(EMPTY);
    this.armor = new Array(4).fill(EMPTY);
    this.grid2 = new Array(4).fill(EMPTY);
    this.grid3 = new Array(9).fill(EMPTY);
    this.cursor = EMPTY;
    this.held = 0;
    this.container = null; // {peId, javaId, type, slots[], size}
    this.workbench = false;
    this.recipes = new RecipeBook();
    this.result2 = null; this.result3 = null;
    this.drag = null;
    this.outQueue = [];
    this.outBusy = false;
    this.lastSlotSend = 0;
    this.furnaceMaxBurn = 0;
    // 'floating' = PocketMine/Genisys (per-slot transactions + floating inventory)
    // 'group'    = Nukkit (balanced SimpleTransactionGroup, crafting straight from the inventory)
    this.groupMode = session.flavor === 'nukkit';
    this.synced = null;
    this.pendingEcho = new Map();
    this.syncScheduled = false;
  }

  // ---------------- key helpers ----------------
  get(key) {
    const t = key[0], i = +key.slice(1);
    switch (t) {
      case 'i': return this.inv[i];
      case 'a': return this.armor[i];
      case 'c': return this.container ? (this.container.slots[i] || EMPTY) : EMPTY;
      case 'g': return this.grid2[i];
      case 'w': return this.grid3[i];
      case 'r': return this.result2 ? this.result2.output : EMPTY;
      case 'R': return this.result3 ? this.result3.output : EMPTY;
      default: return EMPTY;
    }
  }
  set(key, it) {
    it = isEmpty(it) ? EMPTY : it;
    const t = key[0], i = +key.slice(1);
    switch (t) {
      case 'i': this.inv[i] = it; break;
      case 'a': this.armor[i] = it; break;
      case 'c': if (this.container) this.container.slots[i] = it; break;
      case 'g': this.grid2[i] = it; break;
      case 'w': this.grid3[i] = it; break;
      default: break;
    }
  }

  playerTail() {
    const k = [];
    for (let i = 9; i < 36; i++) k.push('i' + i);
    for (let i = 0; i < 9; i++) k.push('i' + i);
    return k;
  }
  view(windowId) {
    if (windowId === 0) return ['r', 'g0', 'g1', 'g2', 'g3', 'a0', 'a1', 'a2', 'a3', ...this.playerTail()];
    if (windowId === WORKBENCH_WINDOW && this.workbench) return ['R', ...[...Array(9).keys()].map((i) => 'w' + i), ...this.playerTail()];
    if (this.container && windowId === this.container.javaId) {
      return [...[...Array(this.container.size).keys()].map((i) => 'c' + i), ...this.playerTail()];
    }
    return null;
  }
  currentWindow() {
    if (this.workbench) return WORKBENCH_WINDOW;
    if (this.container) return this.container.javaId;
    return 0;
  }

  // ---------------- java output ----------------
  javaItem(it) { return this.s.toJavaItem(it); }

  sendWindow(windowId = this.currentWindow()) {
    const v = this.view(windowId);
    if (!v) return;
    this.s.java('window_items', { windowId, items: v.map((k) => this.javaItem(this.get(k))) });
    if (windowId !== 0) this.sendWindow(0);
  }
  sendCursor() { this.s.java('set_slot', { windowId: -1, slot: -1, item: this.javaItem(this.cursor) }); }
  sendKey(key) {
    for (const w of new Set([0, this.currentWindow()])) {
      const v = this.view(w);
      if (!v) continue;
      const idx = v.indexOf(key);
      if (idx >= 0) this.s.java('set_slot', { windowId: w, slot: idx, item: this.javaItem(this.get(key)) });
    }
  }
  sendHeld() { this.s.java('held_item_slot', { slot: this.held }); }

  // ---------------- server -> proxy ----------------
  // Apply an authoritative server value for one slot.
  serverSlot(key, item) {
    item = clone(item);
    if (!this.synced) this.synced = this.snapshot();
    const echo = this.pendingEcho.get(key);
    if (echo && Date.now() < echo.until && equalItems(item, echo.old)) return false; // stale echo of a group still executing
    const untouched = equalItems(this.get(key), this.synced[key] || EMPTY);
    this.synced[key] = item;
    if (!this.groupMode || untouched) { this.set(key, item); return true; }
    return false;
  }
  onSetContent(p) {
    if (p.windowId === 0) {
      for (let i = 0; i < 36; i++) this.serverSlot('i' + i, p.slots[i]);
      this.sendWindow(0);
    } else if (p.windowId === PE_WINDOW_ARMOR) {
      for (let i = 0; i < 4; i++) this.serverSlot('a' + i, p.slots[i]);
      this.sendWindow(0);
    } else if (this.container && p.windowId === this.container.peId) {
      for (let i = 0; i < this.container.size; i++) this.serverSlot('c' + i, p.slots[i] || EMPTY);
      this.sendWindow(this.container.javaId);
    }
  }
  onSetSlot(p) {
    let key = null;
    if (p.windowId === 0 && p.slot < 36) key = 'i' + p.slot;
    else if (p.windowId === PE_WINDOW_ARMOR && p.slot < 4) key = 'a' + p.slot;
    else if (this.container && p.windowId === this.container.peId && p.slot < this.container.size) key = 'c' + p.slot;
    if (!key) return;
    if (this.serverSlot(key, p.item)) this.sendKey(key);
  }
  onEquipmentSelf(p) {
    if (p.selectedSlot >= 0 && p.selectedSlot < 9 && p.selectedSlot !== this.held) { this.held = p.selectedSlot; this.sendHeld(); }
  }
  onContainerOpen(p) {
    this.closeLocalGrids(false);
    const size = p.type === 0 ? (p.slots > 27 ? 54 : 27) : p.slots;
    this.container = { peId: p.windowId, javaId: p.windowId & 0x7f || 1, type: p.type, size, slots: new Array(size).fill(EMPTY), pos: [p.x, p.y, p.z] };
    if (this.synced) { for (const k of Object.keys(this.synced)) if (k[0] === 'c') delete this.synced[k]; for (let i = 0; i < size; i++) this.synced['c' + i] = EMPTY; }
    this.furnaceMaxBurn = 0;
    const title = JSON.stringify({ text: size === 54 ? 'Large Chest' : (TITLES[p.type] || 'Container') });
    this.s.java('open_window', { windowId: this.container.javaId, inventoryType: JAVA_TYPES[p.type] || 'minecraft:chest', windowTitle: title, slotCount: p.type === 0 || p.type === 6 || p.type === 7 || p.type === 8 ? size : 0 });
  }
  onContainerClose(p) {
    if (this.container && p.windowId === this.container.peId) {
      const id = this.container.javaId;
      this.container = null;
      this.returnCursor();
      this.s.java('close_window', { windowId: id });
    }
  }
  onContainerData(p) {
    if (!this.container || p.windowId !== this.container.peId) return;
    const w = this.container.javaId;
    if (this.container.type === 2) { // furnace
      if (p.property === 0) {
        this.s.java('craft_progress_bar', { windowId: w, property: 2, value: p.value });
        this.s.java('craft_progress_bar', { windowId: w, property: 3, value: 200 });
      } else if (p.property === 1) {
        if (p.value > this.furnaceMaxBurn || p.value === 0) this.furnaceMaxBurn = Math.max(p.value, 1);
        this.s.java('craft_progress_bar', { windowId: w, property: 0, value: p.value });
        this.s.java('craft_progress_bar', { windowId: w, property: 1, value: this.furnaceMaxBurn });
      }
    } else {
      this.s.java('craft_progress_bar', { windowId: w, property: p.property, value: p.value });
    }
  }
  onCraftingData(p) { this.recipes.loadPe(p.entries); }

  // ---------------- proxy -> server queue ----------------
  // Crafting events are handled immediately by Genisys while slot transactions run on the player tick,
  // so a craft must trail the slot changes that fed the floating inventory by a couple of ticks.
  queuePe(buf, kind = 'slot') {
    this.outQueue.push({ buf, kind });
    this.pump();
  }
  pump() {
    if (this.outBusy || !this.outQueue.length) return;
    const next = this.outQueue[0];
    const wait = next.kind === 'craft' ? Math.max(0, this.lastSlotSend + 120 - Date.now()) : 0;
    if (wait > 0) { this.outBusy = true; setTimeout(() => { this.outBusy = false; this.pump(); }, wait); return; }
    this.outQueue.shift();
    this.s.pe(next.buf);
    if (next.kind === 'slot') this.lastSlotSend = Date.now();
    if (next.kind === 'craft') this.lastSlotSend = Date.now() - 60;
    this.pump();
  }

  snapshot() {
    const snap = {};
    for (let i = 0; i < 36; i++) snap['i' + i] = this.inv[i];
    for (let i = 0; i < 4; i++) snap['a' + i] = this.armor[i];
    if (this.container) for (let i = 0; i < this.container.size; i++) snap['c' + i] = this.container.slots[i] || EMPTY;
    return snap;
  }
  syncDiff(before) {
    if (this.groupMode) { this.scheduleSync(); return; }
    const after = this.snapshot();
    if (this.synced) Object.assign(this.synced, after);
    const lowered = [], raised = [];
    for (const k of Object.keys(after)) {
      const a = before[k] || EMPTY, b = after[k];
      if (equalItems(a, b)) continue;
      (sameKind(a, b) && b.count > a.count) || (isEmpty(a)) ? raised.push(k) : lowered.push(k);
    }
    for (const k of [...lowered, ...raised]) this.sendSlotToServer(k);
  }
  sendSlotToServer(k) {
    const t = k[0], i = +k.slice(1);
    let windowId;
    if (t === 'i') windowId = 0; else if (t === 'a') windowId = PE_WINDOW_ARMOR; else if (t === 'c' && this.container) windowId = this.container.peId; else return;
    this.queuePe(enc.containerSetSlot({ windowId, slot: i, item: this.get(k) }));
  }
  // Nukkit only accepts a group once everything in it balances, so changes are sent when nothing is
  // left "in hand" (cursor and crafting grids empty), as one batch diffed against the server's view.
  scheduleSync() {
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    setImmediate(() => { this.syncScheduled = false; this.trySync(); });
  }
  trySync() {
    if (!this.groupMode || !this.synced) return;
    if (!isEmpty(this.cursor) || this.grid2.some((g) => !isEmpty(g)) || this.grid3.some((g) => !isEmpty(g))) return;
    const now = this.snapshot();
    const lowered = [], raised = [];
    for (const k of Object.keys(now)) {
      const a = this.synced[k] || EMPTY, b = now[k];
      if (equalItems(a, b)) continue;
      (sameKind(a, b) && b.count > a.count) || isEmpty(a) ? raised.push(k) : lowered.push(k);
    }
    if (!lowered.length && !raised.length) return;
    const until = Date.now() + 1500;
    for (const k of [...lowered, ...raised]) {
      this.pendingEcho.set(k, { old: this.synced[k] || EMPTY, until });
      this.synced[k] = now[k];
      this.sendSlotToServer(k);
    }
  }
  // mirror Nukkit's Inventory.removeItem / addItem on our copy of the server state
  simulateRemove(item) {
    let left = item.count;
    for (let i = 0; i < 36 && left > 0; i++) {
      const k = 'i' + i, it = this.synced[k];
      if (it && it.id === item.id && (item.damage === 0xffff || it.damage === item.damage)) {
        const take = Math.min(left, it.count);
        this.synced[k] = withCount(it, it.count - take); left -= take;
      }
    }
  }
  simulateAdd(item) {
    let left = item.count; const max = maxStack(item.id);
    for (let pass = 0; pass < 2 && left > 0; pass++) {
      for (let i = 0; i < 36 && left > 0; i++) {
        const k = 'i' + i, it = this.synced[k] || EMPTY;
        if (pass === 0 && sameKind(it, item) && it.count < max) { const mv = Math.min(max - it.count, left); this.synced[k] = withCount(it, it.count + mv); left -= mv; }
        if (pass === 1 && isEmpty(it)) { const mv = Math.min(max, left); this.synced[k] = withCount(item, mv); left -= mv; }
      }
    }
  }
  dropToWorld(item) {
    if (isEmpty(item)) return;
    if (this.groupMode && this.synced && this.s.gamemode !== 1) { this.simulateRemove(item); this.scheduleSync(); }
    this.queuePe(enc.dropItem({ type: 0, item }));
  }

  // ---------------- crafting ----------------
  refreshResult(big) {
    const grid = big ? this.grid3 : this.grid2;
    const res = this.recipes.match(grid, big ? 3 : 2);
    if (big) this.result3 = res; else this.result2 = res;
    const win = big ? WORKBENCH_WINDOW : 0;
    if (this.view(win)) this.s.java('set_slot', { windowId: win, slot: 0, item: this.javaItem(res ? res.output : EMPTY) });
  }
  // consume one set of ingredients; returns crafted item or null
  craftOnce(big) {
    const res = big ? this.result3 : this.result2;
    if (!res) return null;
    const grid = big ? this.grid3 : this.grid2;
    const consumed = grid.filter((g) => !isEmpty(g)).map(clone);
    for (let i = 0; i < grid.length; i++) if (!isEmpty(grid[i])) {
      const it = grid[i];
      grid[i] = withCount(it, it.count - 1); // Genisys hands back cake buckets itself
    }
    if (this.groupMode) {
      // Nukkit takes the ingredients from the real inventory (they were never sent out of it) and addItem()s the result
      this.queuePe(enc.craftingEvent({ windowId: 0, type: big ? 1 : 0, uuid: res.uuid, input: [], output: [res.output], flavor: 'nukkit' }), 'slot');
      if (this.synced) { for (const g of consumed) this.simulateRemove(withCount(g, 1)); this.simulateAdd(res.output); }
    } else {
      this.queuePe(enc.craftingEvent({ windowId: 0, type: big ? 1 : 0, uuid: res.uuid, input: [], output: [res.output] }), 'craft');
    }
    const out = clone(res.output);
    this.refreshResult(big);
    return out;
  }

  // ---------------- java -> proxy clicks ----------------
  onWindowClick(p) {
    const v = this.view(p.windowId);
    if (!v) { this.s.java('transaction', { windowId: p.windowId, action: p.action, accepted: false }); return; }
    const before = this.snapshot();
    const big = p.windowId === WORKBENCH_WINDOW;
    const key = p.slot >= 0 && p.slot < v.length ? v[p.slot] : null;
    const isResult = key === 'r' || key === 'R';
    const isGrid = key && (key[0] === 'g' || key[0] === 'w');
    let resync = true;

    switch (p.mode) {
      case 0: // left / right click
        if (p.slot === -999) {
          if (p.mouseButton === 0) { this.dropToWorld(this.cursor); this.cursor = EMPTY; } else if (p.mouseButton === 1 && !isEmpty(this.cursor)) { this.dropToWorld(withCount(this.cursor, 1)); this.cursor = withCount(this.cursor, this.cursor.count - 1); }
        } else if (isResult) this.clickResult(big);
        else if (key) this.normalClick(key, p.mouseButton === 1);
        break;
      case 1: // shift click
        if (isResult) this.shiftCraft(big, v);
        else if (key) this.shiftClick(key, p.windowId, v);
        break;
      case 2: // number key swap
        if (key && p.mouseButton >= 0 && p.mouseButton < 9) {
          const hk = 'i' + p.mouseButton;
          if (isResult) {
            if (isEmpty(this.get(hk))) { const out = this.craftOnce(big); if (out) this.set(hk, out); }
          } else if (key !== hk) {
            const a = this.get(key), b = this.get(hk);
            if (key[0] === 'a' && !isEmpty(b) && !ARMOR_FOR_SLOT[+key.slice(1)](b.id)) break;
            this.set(key, b); this.set(hk, a);
          }
        }
        break;
      case 3: // middle click (creative clone)
        if (key && this.s.gamemode === 1 && isEmpty(this.cursor) && !isEmpty(this.get(key))) this.cursor = withCount(this.get(key), maxStack(this.get(key).id));
        break;
      case 4: // drop key
        if (p.slot === -999) break;
        if (isResult) { const out = this.craftOnce(big); if (out) this.dropToWorld(out); }
        else if (key && !isEmpty(this.get(key))) {
          const it = this.get(key);
          const n = p.mouseButton === 1 ? it.count : 1;
          this.set(key, withCount(it, it.count - n));
          if (isGrid) { this.dropToWorld(withCount(it, n)); } else { this.syncDiff(before); this.dropToWorld(withCount(it, n)); this.after(big, false, true, p); return; }
        }
        break;
      case 5: // drag painting
        resync = this.dragClick(p, key);
        break;
      case 6: // double click collect
        if (!isEmpty(this.cursor)) {
          const max = maxStack(this.cursor.id);
          for (const k of v) {
            if (this.cursor.count >= max) break;
            if (k === 'r' || k === 'R') continue;
            const it = this.get(k);
            if (sameKind(it, this.cursor)) {
              const take = Math.min(max - this.cursor.count, it.count);
              this.cursor = withCount(this.cursor, this.cursor.count + take);
              this.set(k, withCount(it, it.count - take));
            }
          }
        }
        break;
      default: break;
    }
    this.syncDiff(before);
    this.after(big, isGrid || isResult || p.mode === 1 || p.mode === 6 || p.mode === 5, resync, p);
  }

  after(big, gridTouched, resync, p) {
    if (gridTouched) { this.refreshResult(false); if (this.workbench) this.refreshResult(true); }
    if (p) this.s.java('transaction', { windowId: p.windowId, action: p.action, accepted: true });
    if (resync) { this.sendWindow(); this.sendCursor(); }
  }

  normalClick(key, right) {
    const slot = this.get(key);
    const c = this.cursor;
    if (key[0] === 'a' && !isEmpty(c) && !ARMOR_FOR_SLOT[+key.slice(1)](c.id)) return;
    if (isEmpty(c)) {
      if (isEmpty(slot)) return;
      if (right) { const take = Math.ceil(slot.count / 2); this.cursor = withCount(slot, take); this.set(key, withCount(slot, slot.count - take)); } else { this.cursor = slot; this.set(key, EMPTY); }
    } else if (isEmpty(slot)) {
      if (right) { this.set(key, withCount(c, 1)); this.cursor = withCount(c, c.count - 1); } else { this.set(key, c); this.cursor = EMPTY; }
    } else if (sameKind(slot, c)) {
      const max = maxStack(c.id);
      const move = right ? Math.min(1, max - slot.count) : Math.min(c.count, max - slot.count);
      if (move > 0) { this.set(key, withCount(slot, slot.count + move)); this.cursor = withCount(c, c.count - move); }
    } else { this.set(key, c); this.cursor = slot; }
  }

  clickResult(big) {
    const res = big ? this.result3 : this.result2;
    if (!res) return;
    const out = res.output;
    if (isEmpty(this.cursor)) { const it = this.craftOnce(big); if (it) this.cursor = it; } else if (sameKind(this.cursor, out) && this.cursor.count + out.count <= maxStack(out.id)) {
      const it = this.craftOnce(big); if (it) this.cursor = withCount(this.cursor, this.cursor.count + it.count);
    }
  }

  shiftCraft(big) {
    for (let n = 0; n < 64; n++) {
      const res = big ? this.result3 : this.result2;
      if (!res) break;
      const targets = [...[8, 7, 6, 5, 4, 3, 2, 1, 0], ...[...Array(27).keys()].map((i) => i + 9)].map((i) => 'i' + i);
      if (!this.canFit(res.output, targets)) break;
      const out = this.craftOnce(big);
      if (!out) break;
      this.merge(out, targets);
    }
  }

  canFit(item, keys) {
    let left = item.count; const max = maxStack(item.id);
    for (const k of keys) {
      const it = this.get(k);
      if (isEmpty(it)) left -= max; else if (sameKind(it, item)) left -= max - it.count;
      if (left <= 0) return true;
    }
    return false;
  }

  // merge item into keys (existing stacks first, then empty); returns leftover
  merge(item, keys) {
    let left = clone(item);
    const max = maxStack(item.id);
    for (const k of keys) {
      if (isEmpty(left)) break;
      const it = this.get(k);
      if (sameKind(it, left) && it.count < max) {
        const mv = Math.min(max - it.count, left.count);
        this.set(k, withCount(it, it.count + mv)); left = withCount(left, left.count - mv);
      }
    }
    for (const k of keys) {
      if (isEmpty(left)) break;
      if (isEmpty(this.get(k))) { const mv = Math.min(max, left.count); this.set(k, withCount(left, mv)); left = withCount(left, left.count - mv); }
    }
    return left;
  }

  shiftClick(key, windowId, view) {
    const it = this.get(key);
    if (isEmpty(it)) return;
    const main = [...Array(27).keys()].map((i) => 'i' + (i + 9));
    const hotbar = [...Array(9).keys()].map((i) => 'i' + i);
    let targets;
    const t = key[0], idx = +key.slice(1);
    if (windowId === 0) {
      if (t === 'i' && [298, 299, 300, 301, 302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317, 86].includes(it.id)) {
        const slot = ARMOR_FOR_SLOT.findIndex((f) => f(it.id));
        if (slot >= 0 && isEmpty(this.armor[slot])) { this.armor[slot] = withCount(it, 1); this.set(key, withCount(it, it.count - 1)); return; }
      }
      if (t === 'i') targets = idx < 9 ? main : hotbar;
      else targets = [...main, ...hotbar];
    } else if (this.workbench && windowId === WORKBENCH_WINDOW) {
      targets = t === 'i' ? (idx < 9 ? main : hotbar) : [...main, ...hotbar];
    } else if (this.container) {
      const contKeys = view.filter((k) => k[0] === 'c');
      if (t === 'c') targets = [...hotbar.slice().reverse(), ...main.slice().reverse()];
      else if (this.container.type === 2) targets = [isFuel(it.id) ? 'c1' : 'c0'];
      else if (this.container.type === 4) targets = ['c0', 'c1', 'c2', 'c3'].slice(it.id === 373 ? 1 : 0, it.id === 373 ? 4 : 1);
      else targets = contKeys;
    }
    if (!targets) return;
    const left = this.merge(it, targets);
    this.set(key, left);
  }

  dragClick(p, key) {
    const stage = p.mouseButton & 3;
    const kind = p.mouseButton >> 2; // 0 left, 1 right, 2 middle
    if (stage === 0) { this.drag = { kind, keys: [] }; return false; }
    if (stage === 1) { if (this.drag && key && !this.drag.keys.includes(key) && key !== 'r' && key !== 'R') this.drag.keys.push(key); return false; }
    if (stage === 2 && this.drag && !isEmpty(this.cursor)) {
      const keys = this.drag.keys.filter((k) => isEmpty(this.get(k)) || sameKind(this.get(k), this.cursor));
      const max = maxStack(this.cursor.id);
      if (keys.length) {
        const per = this.drag.kind === 1 ? 1 : this.drag.kind === 2 ? max : Math.max(1, Math.floor(this.cursor.count / keys.length));
        let left = this.cursor.count;
        for (const k of keys) {
          if (left <= 0) break;
          const it = this.get(k);
          const cur = isEmpty(it) ? 0 : it.count;
          const mv = Math.min(per, max - cur, this.drag.kind === 2 ? max : left);
          if (mv <= 0) continue;
          this.set(k, withCount(this.cursor, cur + mv));
          if (this.drag.kind !== 2 || this.s.gamemode !== 1) left -= mv;
        }
        this.cursor = withCount(this.cursor, left);
      }
    }
    this.drag = null;
    return true;
  }

  // ---------------- creative ----------------
  onCreativeSlot(slot, peItem) {
    if (slot === -1) { this.dropToWorld(peItem); return; }
    const v = this.view(0);
    const key = v[slot];
    if (!key || key === 'r') return;
    this.set(key, peItem);
    if (key[0] === 'g') { this.refreshResult(false); return; }
    if (this.synced) this.synced[key] = peItem;
    this.sendSlotToServer(key);
  }

  // ---------------- held item / drops ----------------
  setHeld(h) {
    this.held = h;
    this.s.pe(enc.mobEquipment({ eid: this.s.selfEid || 0, item: this.heldItemServer(), slot: h + 9, selectedSlot: h }));
  }
  dropHeld(all) {
    const it = this.inv[this.held];
    if (isEmpty(it)) return;
    const before = this.snapshot();
    const n = all ? it.count : 1;
    this.inv[this.held] = withCount(it, it.count - n);
    this.syncDiff(before);
    this.dropToWorld(withCount(it, n));
    this.sendKey('i' + this.held);
  }
  heldItem() { return this.inv[this.held]; }
  heldItemServer() { return this.groupMode && this.synced ? (this.synced['i' + this.held] || EMPTY) : this.inv[this.held]; }

  // ---------------- closing ----------------
  returnCursor() {
    if (isEmpty(this.cursor)) return;
    const before = this.snapshot();
    const left = this.merge(this.cursor, [...[...Array(9).keys()], ...[...Array(27).keys()].map((i) => i + 9)].map((i) => 'i' + i));
    this.cursor = EMPTY;
    this.syncDiff(before);
    this.dropToWorld(left);
  }
  closeLocalGrids(send = true) {
    const before = this.snapshot();
    const keys = [...[...Array(9).keys()], ...[...Array(27).keys()].map((i) => i + 9)].map((i) => 'i' + i);
    const leftovers = [];
    const all = [...this.grid2, ...(this.workbench ? this.grid3 : []), this.cursor];
    for (const it of all) if (!isEmpty(it)) { const l = this.merge(it, keys); if (!isEmpty(l)) leftovers.push(l); }
    this.grid2.fill(EMPTY); this.grid3.fill(EMPTY); this.cursor = EMPTY;
    this.result2 = null; this.result3 = null;
    this.workbench = false;
    this.syncDiff(before);
    for (const l of leftovers) this.dropToWorld(l);
    if (send) this.sendWindow(0);
  }
  onJavaClose(windowId) {
    if (this.container && windowId === this.container.javaId) {
      this.s.pe(enc.containerClose({ windowId: this.container.peId }));
      this.container = null;
    }
    this.closeLocalGrids(true);
  }
  openWorkbench() {
    this.closeLocalGrids(false);
    this.workbench = true;
    this.s.java('open_window', { windowId: WORKBENCH_WINDOW, inventoryType: 'minecraft:crafting_table', windowTitle: JSON.stringify({ text: 'Crafting' }), slotCount: 0 });
    this.sendWindow(WORKBENCH_WINDOW);
  }
}

function isFuel(id) {
  return [263, 173, 5, 17, 162, 280, 369, 327, 6, 58, 54, 85, 107, 53, 134, 135, 136, 163, 164, 47, 25, 84, 72, 96, 151, 268, 269, 270, 271, 290].includes(id);
}

module.exports = { Inventory, EMPTY, isEmpty, clone, WORKBENCH_WINDOW, peItemToJava };
