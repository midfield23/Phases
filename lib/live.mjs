/** Everything that touches a live LUNA: maps on disk, tables, params, writes, state. */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { Luna } from './luna.mjs';
import { parseDisplay, num } from './convert.mjs';

export { ROOT, sleep, safeId, args } from './util.mjs';
import { ROOT, sleep, safeId } from './util.mjs';

// ---------------------------------------------------------------- files

const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8'), revive) : fallback);
const writeJson = (f, data) => { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(data, replace, 2) + '\n'); };
// JSON has no Infinity: store it as a string
function replace(_k, v) { return v === Infinity ? '__inf__' : v === -Infinity ? '__-inf__' : v; }
function revive(_k, v) { return v === '__inf__' ? Infinity : v === '__-inf__' ? -Infinity : v; }

export function loadMaps() {
  const dir = join(ROOT, 'maps');
  const maps = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const m = readJson(join(dir, f));
    if (m?.pluginId && !String(m.pluginId).startsWith('TODO')) maps.set(m.pluginId, m);
  }
  return maps;
}

export const tableFile = (pluginId) => join(ROOT, 'tables', `${safeId(pluginId)}.json`);
export const loadTables = (pluginId) => readJson(tableFile(pluginId), { params: {} }).params;
export function saveTables(pluginId, params) {
  writeJson(tableFile(pluginId), { pluginId, built: new Date().toISOString(), params });
}

export const loadFavorites = () => readJson(join(ROOT, 'favorites.json'), { cs: [] });

const STATE = join(ROOT, '.state', 'tracks.json');
export const loadState = () => readJson(STATE, {});
export const saveState = (s) => writeJson(STATE, s);

// ---------------------------------------------------------------- LUNA

export async function connect() {
  const luna = await Luna.connect();
  const session = await luna.session();
  await session.ready();
  return { luna, session };
}

export function findTrack(session, name) {
  const want = String(name ?? '').toLowerCase();
  const tracks = session.visibleTracks;
  return tracks.find((t) => (t.name.value ?? '').toLowerCase() === want)
    ?? tracks.find((t) => (t.name.value ?? '').toLowerCase().includes(want));
}

/**
 * Load a slot's parameters and wait until their values have arrived. With `expect`
 * (parameter names from the map), also wait until those names are there — right after a
 * swap the slot can still list the previous plugin's parameters for a moment.
 */
export async function slotParams(slot, timeoutMs = 4000, expect = []) {
  await slot.controls.load();
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ps = slot.params;
    const names = new Set(ps.map((p) => p.name.value));
    const ready = ps.length && ps.every((p) => typeof num(p.normalized.value) === 'number')
      && expect.every((n) => names.has(n));
    if (ready) break;
    await sleep(100);
  }
  await sleep(150);
  return new Map(slot.params.map((p) => [p.name.value, p]));
}

/** Write a 0-1 position. LUNA can refuse a bare whole number, so always send a float. */
export async function writeNorm(p, n) {
  try {
    // The SDK adds the float literal itself for a continuous control, and keeps a plain number
    await p.normalized.set(p.discrete?.value === false ? n : Luna.float(n));
  } catch (e) {
    if (e.code !== 'uasrv.invalid_type') throw e;
    await p.normalized.set(n === 0 ? 1e-9 : n === 1 ? 1 - 1e-9 : n);
  }
}

export async function writeReal(p, v) {
  await p.real.set(p.discrete?.value === false ? v : Luna.float(v));
}

/** After writes have committed: did a real-unit write get clamped by the plugin? */
export function clamped(p, wanted) {
  const d = parseDisplay(p.display.value);
  if (d == null || !Number.isFinite(d)) return false;
  return Math.abs(d - wanted) > 0.05 * Math.max(1, Math.abs(wanted));
}

export { Luna };
