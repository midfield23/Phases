#!/usr/bin/env node
/**
 * import-reasixty.mjs — draft LUNA maps from Rea-Sixty's user_plugins.json.
 *
 * Each Rea-Sixty channel-strip map ties a UC1/SSL-Link control (linkIdx) to a plugin
 * parameter. This turns those into our control keys and the parameter's NAME, which is
 * what LUNA matches on (the API Vision's names in LUNA match its UADx VST3 names exactly).
 *
 *   node tools/import-reasixty.mjs ~/Library/Application\ Support/REAPER/rea_sixty/user_plugins.json
 *
 * Writes maps/drafts/<name>.json. Each draft still needs:
 *   - pluginId: the LUNA id (run probe-strips.mjs with the plugin on a track; it prints it)
 *   - mode: "real" for UA plugins, "table" for everything else
 *   - states / scale / offText for switches and kHz knobs (see the two finished maps)
 * then move it up into maps/.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BY_LINK } from '../lib/controls.mjs';
import { ROOT, args } from '../lib/util.mjs';

const a = args();
const file = a._[0];
if (!file) { console.error('usage: node tools/import-reasixty.mjs <path to user_plugins.json>'); process.exit(1); }

const data = JSON.parse(readFileSync(file, 'utf8'));
const outDir = join(ROOT, 'maps', 'drafts');
mkdirSync(outDir, { recursive: true });

let made = 0;
for (const pl of data.plugins ?? []) {
  const name = pl.displayShort || pl.match;
  if (pl.domain !== 'ChannelStrip') {
    console.error(`  skip ${name}: ${pl.domain} (bus-compressor controls are not in the shared list yet)`);
    continue;
  }
  if (!pl.slots?.length) { console.error(`  skip ${name}: no controls mapped in Rea-Sixty`); continue; }

  const names = new Map((pl.paramSnapshot ?? []).map((p) => [p.vst3Param, p.name]));
  const controls = {};
  const unknown = [];
  const notes = [];
  for (const s of pl.slots) {
    const key = BY_LINK[s.linkIdx];
    const param = names.get(s.vst3Param);
    if (!key) { unknown.push(`linkIdx ${s.linkIdx} -> ${param ?? `param ${s.vst3Param}`}`); continue; }
    if (!param) { notes.push(`${key}: parameter ${s.vst3Param} not in the snapshot`); continue; }
    if (controls[key] && controls[key].param !== param) {
      notes.push(`${key}: Rea-Sixty maps it twice (${controls[key].param} / ${param}); kept the first`);
      continue;
    }
    controls[key] = { param, ...(s.inverted ? { inverted: true } : {}) };
  }

  // Sanity checks worth a human look
  const keysByParam = new Map();
  for (const [key, c] of Object.entries(controls)) keysByParam.set(c.param, [...(keysByParam.get(c.param) ?? []), key]);
  for (const [param, keys] of keysByParam) {
    if (keys.length > 1) notes.push(`CHECK: "${param}" feeds ${keys.join(', ')}; keep only the control it really is`);
  }
  if (/low|lp/i.test(controls.hpf?.param ?? '') && !/high|hp/i.test(controls.hpf?.param ?? '')) notes.push(`CHECK: hpf is "${controls.hpf.param}" — looks like the low-pass`);
  if (/high|hp/i.test(controls.lpf?.param ?? '') && !/low|lp/i.test(controls.lpf?.param ?? '')) notes.push(`CHECK: lpf is "${controls.lpf.param}" — looks like the high-pass`);

  const draft = {
    pluginId: 'TODO: LUNA plugin id (probe-strips.mjs prints it)',
    name,
    domain: 'cs',
    mode: 'TODO: "real" for UA plugins, "table" for others',
    reaSixty: { match: pl.match, original: pl.original_name ?? null },
    notes: [
      'Drafted from Rea-Sixty user_plugins.json. Check every line against the plugin in LUNA.',
      'Add switches (eq_in, comp_in, hf_type …) with "states", and "scale": 1000 for knobs shown in kHz.',
      ...notes,
    ],
    controls,
    ...(unknown.length ? { unmappedReaSixtyControls: unknown } : {}),
  };
  const out = join(outDir, `${name.replace(/[^\w.-]+/g, '_')}.json`);
  writeFileSync(out, JSON.stringify(draft, null, 2) + '\n');
  const checks = notes.filter((n) => n.startsWith('CHECK')).length;
  console.error(`  ${name}: ${Object.keys(controls).length} control(s)${unknown.length ? `, ${unknown.length} unknown linkIdx` : ''}${checks ? `, ${checks} to check` : ''} -> maps/drafts/`);
  made++;
}
console.error(`\n${made} draft map(s) written.`);
