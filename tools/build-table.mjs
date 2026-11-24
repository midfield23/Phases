#!/usr/bin/env node
/**
 * build-table.mjs — measure a table-mode plugin once, so swaps never read its display text.
 *
 * For every parameter its map uses, sweeps the 0-1 range and records the text the plugin
 * shows at each point, then puts the knob back. Switches get 21 points (enough to find
 * every state); continuous knobs get --points (default 101).
 *
 * Scratch session: it moves every mapped knob and leaves undo entries.
 *
 *   node tools/build-table.mjs --track Probe --plugin S4KE
 *   node tools/build-table.mjs --track Probe --plugin S4KE --only "HF Type,LF Type"   # just these
 */
import {
  args, connect, findTrack, slotParams, loadMaps, loadTables, saveTables, writeNorm, sleep, tableFile,
} from '../lib/live.mjs';

const a = args();
if (!a.track || !a.plugin) {
  console.error('usage: node tools/build-table.mjs --track <name> --plugin <id or part> [--points 101] [--wait 150] [--only "A,B"] [--lag]');
  process.exit(1);
}
const points = Math.max(5, Number(a.points ?? 101));
const wait = Math.max(50, Number(a.wait ?? 150));
// --lag: the plugin's display shows the value from the write before (Sie-Q), however long we wait.
// Each reading then belongs to the previous position: shift them back by one.
const lag = !!a.lag;
const only = a.only ? new Set(String(a.only).split(',').map((s) => s.trim())) : null;

const maps = loadMaps();
const { luna, session } = await connect();
const track = findTrack(session, a.track);
if (!track) throw new Error(`No track "${a.track}"`);
await track.effects.load();
await sleep(300);

const want = String(a.plugin).toLowerCase();
const slot = track.effectSlots.find((s) => !s.isEmpty && `${s.pluginId.value} ${s.pluginName.value ?? ''}`.toLowerCase().includes(want));
if (!slot) throw new Error(`No plugin matching "${a.plugin}" on "${track.name.value}"`);
const id = slot.pluginId.value;
const map = maps.get(id);
if (!map) throw new Error(`No map for ${id} in maps/. Make one first (see maps/ and tools/import-reasixty.mjs).`);

const params = await slotParams(slot);
const tables = loadTables(id);
const defsByParam = new Map();
// Flexible bands (Pro-Q 4...): one band's knobs are measured for all of them, plus any shape switch named
if (map.flex) {
  const t = map.flex.tables ?? {};
  for (const role of ['freq', 'gain', 'q']) if (t[role]) defsByParam.set(t[role], { param: t[role] });
  const shapeStates = map.flex.shapeSteps ? undefined : map.flex.shapes;
  for (const m of [t.shape, ...(map.flex.measure ?? [])].filter(Boolean)) {
    // an entry is a parameter name, or { param, states } for a switch with only some of the shapes
    const name = typeof m === 'string' ? m : m.param;
    const states = typeof m === 'string' ? shapeStates : m.states;
    defsByParam.set(name, states ? { param: name, states } : { param: name });
  }
}
for (const def of Object.values(map.controls)) {
  // A real-mode map: only its knobs marked `table: true` need measuring
  if (map.mode !== 'table' && !def.table) continue;
  if (!def.param) continue;
  if (!defsByParam.has(def.param)) defsByParam.set(def.param, def);
  // A range switch (4K G HMF x3) is measured like any switch
  // Range switches (4K G HMF x3) and filter on switches (88RS HP Enable) are measured like any switch
  for (const r of [def.range, def.enable]) {
    if (r && !defsByParam.has(r.param)) defsByParam.set(r.param, { param: r.param, states: { off: r.off, on: r.on } });
  }
}

console.error(`Measuring ${map.name} (${id}) on "${track.name.value}"${only ? ` — only ${[...only].join(', ')}` : ''}`);
let done = 0;
for (const [name, def] of defsByParam) {
  if (only && !only.has(name)) continue;
  const p = params.get(name);
  if (!p) { console.error(`  ! ${name}: not on this plugin — check the map`); continue; }
  const n = def.states ? 21 : points;
  const original = p.normalized.value;
  const rows = [];
  try {
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);
      await writeNorm(p, x);
      await sleep(wait);
      rows.push([Number(x.toFixed(4)), p.display.value ?? '']);
    }
  } catch (e) {
    console.error(`  ! ${name}: refused (${e.code ?? e.message}), skipped`);
    continue;
  } finally {
    try { await writeNorm(p, original); } catch { /* leave it */ }
  }
  if (lag && rows.length) {
    // putting the knob back makes the display show the last position's value
    await sleep(wait);
    const last = p.display.value ?? '';
    for (let i = 0; i < rows.length - 1; i++) rows[i][1] = rows[i + 1][1];
    rows[rows.length - 1][1] = last;
  }
  tables[name] = rows;
  done++;

  // Show what was found, so the map can be checked against it
  if (def.states) {
    const labels = [...new Set(rows.map((r) => r[1]))];
    const wanted = Object.values(def.states);
    // Labels are compared trimmed, as the map reads them (" ON" shows as ON)
    const shown = new Set(labels.map((l) => String(l).trim().toUpperCase()));
    const missing = wanted.filter((l) => !shown.has(String(l).trim().toUpperCase()));
    console.error(`  ${name.padEnd(26)} states: ${labels.map((l) => `"${l}"`).join(' ')}` +
      (missing.length ? `   ← map expects ${missing.map((l) => `"${l}"`).join(', ')}: FIX THE MAP` : ''));
  } else {
    const first = rows[0][1], mid = rows[Math.floor(rows.length / 2)][1], last = rows[rows.length - 1][1];
    console.error(`  ${name.padEnd(26)} "${first}" … "${mid}" … "${last}"${def.scale ? `  (×${def.scale})` : ''}`);
  }
  saveTables(id, tables);            // save as we go, so an interrupted run keeps its work
}

console.error(`\n${done} parameter(s) measured -> ${tableFile(id)}`);
await luna.close();
