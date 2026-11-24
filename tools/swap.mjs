#!/usr/bin/env node
/**
 * swap.mjs — switch a track's channel strip from the Terminal (the panel does the same).
 *
 *   node tools/swap.mjs --track Vox                      # next favourite (favorites.json)
 *   node tools/swap.mjs --track Vox --prev
 *   node tools/swap.mjs --track Vox --to S4KE            # a specific one (id or part of its name)
 *   node tools/swap.mjs --track Vox --mode own           # each strip comes back as you left it
 *   node tools/swap.mjs --track Vox --sections eq,dyn    # carry EQ + compressor only (I/O always carries)
 *   node tools/swap.mjs --track Vox --insert             # no strip yet: add the first favourite
 *   node tools/swap.mjs --track Vox --dry                # show what would carry, change nothing
 *
 *   node tools/swap.mjs --track Vox --compare S4KE       # load it next to the current strip (A/B)
 *   node tools/swap.mjs --track Vox --flip               # switch which one you hear
 *   node tools/swap.mjs --track Vox --keep b             # end the comparison, keeping A or B
 *
 * Remembered values: in the Terminal they live in .state/tracks.json; the panel keeps its own
 * in the session.
 */
import { args, connect, findTrack, loadMaps, loadTables, loadFavorites, loadState, saveState } from '../lib/live.mjs';
import { createEngine, StripError } from '../lib/engine.mjs';
import { readStrip, mergeRemembered } from '../lib/convert.mjs';
import { Luna } from '../lib/luna.mjs';

const a = args();
if (!a.track) {
  console.error('usage: node tools/swap.mjs --track <name> [--next|--prev|--to <id>|--compare <id>|--flip|--keep a|b] [--row eq|comp] [--mode copy|own] [--insert] [--dry]');
  process.exit(1);
}
const mode = a.mode === 'own' ? 'own' : 'copy';
const role = /^(comp|dyn)/i.test(String(a.row ?? '')) ? 'dyn' : 'eq';
const fmt = (v) => (typeof v === 'number' ? (Number.isFinite(v) ? +v.toFixed(3) : (v > 0 ? '∞' : '-∞')) : v);

const maps = loadMaps();
const tables = Object.fromEntries([...maps.keys()].map((id) => [id, loadTables(id)]));
const favorites = loadFavorites();
const all = loadState();
const store = {
  load: async (k) => all[k],
  save: async (k, s) => { all[k] = s; saveState(all); },
};
const engine = createEngine({ Luna, maps, tables, favorites, store, log: (m) => console.error(m) });

const { luna, session } = await connect();
try {
  const track = findTrack(session, a.track);
  if (!track) throw new StripError(`No track "${a.track}"`);
  const { strips, rows, compare } = await engine.inspect(track);
  const active = rows[role];

  const pick = (w) => {
    w = String(w).toLowerCase();
    return engine.favs(role).find((id) => id.toLowerCase().includes(w) || maps.get(id).name.toLowerCase().includes(w))
      ?? [...maps.keys()].find((id) => id.toLowerCase().includes(w) || maps.get(id).name.toLowerCase().includes(w));
  };

  if (!active) {
    console.error(`No ${role === 'eq' ? 'EQ' : 'compressor'} on "${track.name.value}".` + (a.insert ? '' : ' Its inserts:'));
    if (!a.insert) {
      for (const s of track.effectSlots.filter((x) => !x.isEmpty)) {
        console.error(`  ${s.id.padEnd(10)} ${String(s.pluginName.value ?? '').padEnd(32)} ${s.pluginId.value}${maps.has(s.pluginId.value) ? '' : '  (no map)'}`);
      }
      console.error('\nIf one of these is your strip, its id needs a map in maps/. To add one to an empty slot, run again with --insert.');
      process.exitCode = 1;
    }
  }

  if (a.flip) {
    const r = await engine.flip(session, track);
    console.error(`Now hearing ${r.active.toUpperCase()}: ${r.name}`);
  } else if (a.keep) {
    const r = await engine.keep(session, track, String(a.keep).toLowerCase() === 'a' ? 'a' : 'b');
    console.error(`Kept ${r.kept}`);
    r.warnings.forEach((w) => console.error(`  ! ${w}`));
  } else if (a.compare) {
    const id = pick(a.compare);
    if (!id) throw new StripError(`No mapped strip matching "${a.compare}"`);
    const r = await engine.compare(session, track, id, { mode, role });
    report(r);
    console.error(`Now hearing B (${r.to}). --flip to switch, --keep a or --keep b to finish.`);
  } else if (active || a.insert) {
    if (compare) throw new StripError('A comparison is in progress: --flip, or --keep a / --keep b.');
    const targetId = a.to ? pick(a.to) : engine.stepFrom(active?.map.pluginId, a.prev ? -1 : 1, role);
    if (!targetId) throw new StripError(a.to ? `No mapped strip matching "${a.to}"` : 'favorites.json lists no mapped strips');
    if (a.dry) {
      const ts = await engine.loadState(track);
      let read = {};
      if (active) read = readStrip(active.map, await engine.slotParams(active.slot), engine.tablesOf(active.map.pluginId));
      const row = ts.rows[role];
      const merged = mergeRemembered(engine.memoryFor(ts, [role], role), read, row.held ?? [], row.heldAt ?? {});
      const target = maps.get(targetId);
      console.error(`${track.name.value}: ${active?.map.name ?? '(no strip)'} -> ${target.name}  [${mode}]`);
      for (const [k, v] of Object.entries(merged)) {
        const kept = (row.held ?? []).includes(k) && k in read && read[k] !== v;
        const from = kept ? `  (kept; strip shows ${fmt(read[k])})` : k in read ? '' : '  (remembered)';
        console.error(`  ${k.padEnd(14)} ${String(fmt(v)).padEnd(10)}${from}${target.controls[k] ? '' : '  — not on target, kept for later'}`);
      }
    } else {
      report(await engine.swap(session, track, targetId, { mode, role, insert: !!a.insert }));
    }
  }
  void strips;
} catch (e) {
  if (e instanceof StripError) { console.error(e.message); process.exitCode = 1; } else throw e;
} finally {
  await luna.close();
}

function report(r) {
  if (r.warnings?.includes('already on it')) { console.error(`Already on ${r.to}`); return; }
  console.error(`  carried ${r.carried} value(s)`);
  if (r.skipped?.length) console.error(`  left at default (not representable): ${r.skipped.join(', ')}`);
  if (r.keptForLater?.length) console.error(`  kept for later (not on ${r.to}): ${r.keptForLater.join(', ')}`);
  for (const w of r.warnings ?? []) console.error(`  ! ${w}`);
}
