'use strict';
// Crafting-grid recipe matcher. Uses the server's CraftingDataPacket where it is reliable
// (shapeless + square shaped recipes) and Java 1.8 recipe shapes (minecraft-data) for the rest.
// Genisys serialises non-square shaped recipes with width/height swapped, which loses cells.
const { javaItemToPe } = require('./mappings');

const WILD = null;

function itemMatches(m, it) {
  if (!m) return !it || !it.id;
  if (!it || !it.id) return false;
  if (m.id !== it.id) return false;
  return m.damage === WILD || m.damage === it.damage;
}

function peMatcher(slot) {
  if (!slot || !slot.id) return null;
  return { id: slot.id, damage: slot.damage === 0xffff || slot.damage === 32767 ? WILD : slot.damage };
}

function javaMatcher(x) {
  if (x == null) return null;
  const id = typeof x === 'number' ? x : x.id;
  const meta = typeof x === 'number' ? -1 : (x.metadata == null ? -1 : x.metadata);
  if (id == null || id < 0) return null;
  const pe = javaItemToPe({ blockId: id, itemDamage: meta < 0 ? 0 : meta, itemCount: 1 });
  return { id: pe.id, damage: meta < 0 ? WILD : pe.damage };
}

class RecipeBook {
  constructor() {
    this.recipes = [];       // {shape:[[m]] | null, ingredients:[m] | null, output, uuid}
    this.byOutput = new Map(); // "id:damage" and "id:*" -> uuid
    this.javaLoaded = false;
  }

  loadPe(entries) {
    this.recipes = [];
    this.byOutput.clear();
    for (const e of entries) {
      if (!e.output || !e.output.id) continue;
      this.byOutput.set(`${e.output.id}:${e.output.damage}`, e.uuid);
      if (!this.byOutput.has(`${e.output.id}:*`)) this.byOutput.set(`${e.output.id}:*`, e.uuid);
      if (e.type === 'shapeless') {
        this.recipes.push({ ingredients: e.input.map(peMatcher).filter(Boolean), output: e.output, uuid: e.uuid, src: 'pe' });
      } else if (e.type === 'shaped' && e.nukkit) {
        const rows = [];
        for (let z = 0; z < e.height; z++) { const row = []; for (let x = 0; x < e.width; x++) row.push(peMatcher(e.cells[z * e.width + x])); rows.push(row); }
        this.recipes.push({ shape: trim(rows), output: e.output, uuid: e.uuid, src: 'pe' });
      } else if (e.type === 'shaped' && e.width === e.height) {
        const n = e.width, rows = [];
        for (let z = 0; z < n; z++) { const row = []; for (let x = 0; x < n; x++) row.push(peMatcher(e.cells[z * n + x])); rows.push(row); }
        // Genisys writes [z][x]; the real orientation may be transposed, so register both.
        this.recipes.push({ shape: trim(rows), output: e.output, uuid: e.uuid, src: 'pe' });
        const t = rows[0].map((_, c) => rows.map((r) => r[c]));
        this.recipes.push({ shape: trim(t), output: e.output, uuid: e.uuid, src: 'pe' });
      }
    }
    this.loadJava();
  }

  loadJava() {
    let data;
    try { data = require('minecraft-data')('1.8.8').recipes; } catch (e) { return; }
    for (const list of Object.values(data)) {
      for (const r of list) {
        if (!r.inShape) continue; // shapeless ones come from the server
        const rows = r.inShape.map((row) => row.map(javaMatcher));
        const out = javaItemToPe({ blockId: r.result.id, itemDamage: r.result.metadata || 0, itemCount: r.result.count || 1 });
        this.recipes.push({ shape: trim(rows), output: out, uuid: null, src: 'java' });
      }
    }
  }

  uuidFor(out) {
    return this.byOutput.get(`${out.id}:${out.damage}`) || this.byOutput.get(`${out.id}:*`) || null;
  }

  // grid: array of PE items, size n*n (row-major). Returns {output, uuid} or null.
  match(grid, n) {
    const rows = [];
    for (let r = 0; r < n; r++) rows.push(grid.slice(r * n, r * n + n));
    const trimmed = trim(rows, true);
    const items = grid.filter((g) => g && g.id);
    if (!items.length) return null;
    for (const rec of this.recipes) {
      let ok = false;
      if (rec.shape) {
        if (rec.shape.length > n || rec.shape[0].length > n) continue;
        ok = shapeEquals(rec.shape, trimmed) || shapeEquals(mirror(rec.shape), trimmed);
      } else if (rec.ingredients) {
        if (rec.ingredients.length !== items.length || rec.ingredients.length > n * n) continue;
        ok = shapelessMatches(rec.ingredients, items);
      }
      if (!ok) continue;
      const uuid = rec.uuid || this.uuidFor(rec.output);
      if (!uuid) continue; // the server would not accept it
      const output = Object.assign({}, rec.output, { count: rec.output.count || 1 });
      if (output.damage === 0xffff) output.damage = 0;
      return { output, uuid };
    }
    return null;
  }
}

function trim(rows, isItems = false) {
  const has = (v) => isItems ? (v && v.id) : !!v;
  let top = 0, bottom = rows.length - 1, left = Infinity, right = -1;
  while (top <= bottom && !rows[top].some(has)) top++;
  while (bottom >= top && !rows[bottom].some(has)) bottom--;
  if (top > bottom) return [];
  for (let r = top; r <= bottom; r++) rows[r].forEach((v, c) => { if (has(v)) { left = Math.min(left, c); right = Math.max(right, c); } });
  const out = [];
  for (let r = top; r <= bottom; r++) out.push(rows[r].slice(left, right + 1));
  return out;
}

function mirror(rows) { return rows.map((r) => r.slice().reverse()); }

function shapeEquals(shape, grid) {
  if (shape.length !== grid.length) return false;
  for (let r = 0; r < shape.length; r++) {
    if (shape[r].length !== grid[r].length) return false;
    for (let c = 0; c < shape[r].length; c++) if (!itemMatches(shape[r][c], grid[r][c])) return false;
  }
  return true;
}

function shapelessMatches(ings, items) {
  const used = new Array(items.length).fill(false);
  outer: for (const m of ings) {
    for (let i = 0; i < items.length; i++) if (!used[i] && itemMatches(m, items[i])) { used[i] = true; continue outer; }
    return false;
  }
  return used.every(Boolean);
}

module.exports = { RecipeBook };
