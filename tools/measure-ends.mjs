#!/usr/bin/env node
/**
 * measure-ends.mjs — record where each knob of a real-mode strip starts and stops.
 *
 * LUNA refuses a value past the end of a knob and the SDK doesn't say where the ends are. With
 * the ends in the map, a value that only just misses goes straight to the nearer end, and the
 * panel doesn't have to find the ends during a swap (knobs jumping, extra undo steps).
 *
 * For every continuous knob the map uses: sets it to 0 and to 1, reads the value in real units,
 * puts it back, and writes "ends": [value at 0, value at 1] into maps/<plugin>.json.
 * Table-mode maps (SSL Native) don't need this: their tables already cover the whole knob.
 *
 * Scratch session: it moves knobs and leaves undo entries.
 *
 *   node tools/measure-ends.mjs --track Probe --plugin API
 *   node tools/measure-ends.mjs --track Probe --plugin API --dry     # show, don't save
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { args, connect, findTrack, slotParams, writeNorm, sleep, ROOT } from '../lib/live.mjs';
import { num } from '../lib/convert.mjs';

const a = args();
if (!a.track || !a.plugin) {
  console.error('usage: node tools/measure-ends.mjs --track <name> --plugin <id or part> [--wait 250] [--dry]');
  process.exit(1);
}
const wait = Math.max(100, Number(a.wait ?? 250));

const { luna, session } = await connect();
const track = findTrack(session, a.track);
if (!track) throw new Error(`No track "${a.track}"`);
await track.effects.load();
await sleep(300);

const want = String(a.plugin).toLowerCase();
const slot = track.effectSlots.find((s) => !s.isEmpty && `${s.pluginId.value} ${s.pluginName.value ?? ''}`.toLowerCase().includes(want));
if (!slot) throw new Error(`No plugin matching "${a.plugin}" on "${track.name.value}"`);
const id = slot.pluginId.value;

// The map file itself (not loadMaps), so it can be written back
const dir = join(ROOT, 'maps');
const file = readdirSync(dir).map((f) => join(dir, f)).find((f) => f.endsWith('.json') && JSON.parse(readFileSync(f, 'utf8')).pluginId === id);
if (!file) throw new Error(`No map for ${id} in maps/.`);
const map = JSON.parse(readFileSync(file, 'utf8'));
if (map.mode !== 'real') throw new Error(`${map.name} is a ${map.mode}-mode map; its table already covers each knob's range.`);

const params = await slotParams(slot);
// Measured knobs (table: true) and fixed controls have no ends to record
const names = [...new Set(Object.values(map.controls).filter((d) => !d.states && !d.table && d.param).map((d) => d.param))];
console.error(`Measuring knob ends: ${map.name} (${id}) on "${track.name.value}"`);

const ends = {};
for (const name of names) {
  const p = params.get(name);
  if (!p) { console.error(`  ! ${name}: not on this plugin — check the map`); continue; }
  if (p.discrete?.value) { console.error(`  ${name.padEnd(24)} stepped: its steps are read live, nothing to record`); continue; }
  const original = num(p.normalized.value);
  try {
    const read = async (n) => { await writeNorm(p, n); await sleep(wait); return num(p.real.value); };
    const at0 = await read(0), at1 = await read(1);
    if (![at0, at1].every((v) => typeof v === 'number' && Number.isFinite(v))) throw new Error(`no value in real units (${at0}, ${at1})`);
    ends[name] = [round(at0), round(at1)];
    console.error(`  ${name.padEnd(24)} ${ends[name][0]} … ${ends[name][1]}`);
  } catch (e) {
    console.error(`  ! ${name}: ${e.code ?? e.message}`);
  } finally {
    try { await writeNorm(p, original); } catch { /* leave it */ }
  }
}

let changed = 0;
for (const def of Object.values(map.controls)) {
  if (!ends[def.param]) continue;
  if (JSON.stringify(def.ends) !== JSON.stringify(ends[def.param])) changed++;
  def.ends = ends[def.param];
}
if (a.dry) console.error(`\n--dry: ${changed} change(s) not saved.`);
else {
  writeFileSync(file, formatMap(map));
  console.error(`\n${Object.keys(ends).length} knob(s) measured, ${changed} changed -> ${file}`);
}
await luna.close();

function round(v) { return Math.round(v * 10000) / 10000; }

/** The maps' layout: one line per control, keys lined up. */
function formatMap(m) {
  const { controls, ...rest } = m;
  const head = JSON.stringify(rest, null, 2).replace(/\n}$/, '');
  const width = Math.max(...Object.keys(controls).map((k) => k.length)) + 3;
  const lines = Object.entries(controls).map(([k, v]) => `    ${`"${k}":`.padEnd(width + 1)} ${JSON.stringify(v).replace(/([,:])(?=["{\[\d-])/g, '$1 ').replace(/^\{/, '{ ').replace(/\}$/, ' }')}`);
  return `${head},\n  "controls": {\n${lines.join(',\n')}\n  }\n}\n`;
}
