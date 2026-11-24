#!/usr/bin/env node
/**
 * build-addon.mjs — assemble the LUNA add-on in ./addon from:
 *   addon-src/      the panel (index.html, main.js)
 *   lib/            the shared engine (bundled into one script, as LUNA add-ons want)
 *   maps/, tables/, favorites.json   your data (re-run after build-table or editing favourites)
 *   your SDK clone  vendor/luna.global.js (LUNA_SDK, default ~/luna-builder-sdk)
 *
 *   node tools/build-addon.mjs
 *   node ~/luna-builder-sdk/dist/cli.js install addon     # once: links ./addon into LUNA's Add Ons
 *
 * After the first install, re-running this script is enough: LUNA's Add Ons entry is a link
 * to ./addon, so reopen the panel (or reload it) to pick up changes.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { ROOT } from '../lib/util.mjs';
import { needsTable } from '../lib/convert.mjs';

const OUT = join(ROOT, 'addon');
const SDK = process.env.LUNA_SDK ?? join(homedir(), 'luna-builder-sdk');
mkdirSync(join(OUT, 'vendor'), { recursive: true });

// 1. The engine: lib modules joined into one classic script
const parts = ['controls.mjs', 'convert.mjs', 'engine.mjs'].map((f) => {
  const src = readFileSync(join(ROOT, 'lib', f), 'utf8');
  return `// ---- lib/${f}\n` + src
    .replace(/^import[^;]+;\s*$/gm, '')
    .replace(/^export\s+(?=(const|let|function|async function|class)\b)/gm, '');
});
writeFileSync(join(OUT, 'engine.js'),
  `// Built from lib/ by tools/build-addon.mjs. Edit lib/, not this file.\n(function () {\n'use strict';\n${parts.join('\n')}\n` +
  'window.StripEngine = { createEngine, StripError, CONTROLS, SECTIONS, needsTable, rolesOf, ROLES, ROW_NAME };\n})();\n');

// 2. Data: maps, measured tables, favourites
const maps = {};
for (const f of readdirSync(join(ROOT, 'maps'))) {
  if (!f.endsWith('.json')) continue;
  const m = JSON.parse(readFileSync(join(ROOT, 'maps', f), 'utf8'));
  if (m.pluginId && !String(m.pluginId).startsWith('TODO')) maps[m.pluginId] = m;
}
const tables = {};
const tdir = join(ROOT, 'tables');
if (existsSync(tdir)) {
  for (const f of readdirSync(tdir)) {
    if (!f.endsWith('.json')) continue;
    const t = JSON.parse(readFileSync(join(tdir, f), 'utf8'));
    if (t.pluginId) tables[t.pluginId] = t.params ?? {};
  }
}
const favorites = existsSync(join(ROOT, 'favorites.json')) ? JSON.parse(readFileSync(join(ROOT, 'favorites.json'), 'utf8')) : { cs: [] };
writeFileSync(join(OUT, 'data.js'),
  `// Built by tools/build-addon.mjs from maps/, tables/ and favorites.json.\nwindow.STRIP_DATA = ${JSON.stringify({ maps, tables, favorites })};\nwindow.STRIP_BUILD = ${JSON.stringify(new Date().toLocaleString())};\n`);

// 3. The panel
for (const f of ['index.html', 'main.js', 'icon.png']) copyFileSync(join(ROOT, 'addon-src', f), join(OUT, f));

// 4. The SDK bundle and the manifest
const bundle = join(SDK, 'dist', 'luna.global.js');
if (!existsSync(bundle)) {
  console.error(`No SDK bundle at ${bundle}. Run "npm install" in your SDK clone, or set LUNA_SDK.`);
  process.exit(1);
}
copyFileSync(bundle, join(OUT, 'vendor', 'luna.global.js'));
const sdkVersion = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')).version;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({
  package_name: 'Phases',
  id: 'com.johnmulholland.strip-favorites',
  title: 'Phases',
  version: pkg.version,
  manufacturer: 'Tobacco Road Studios',
  description: 'Switch a track\'s EQ and compressor between your favourites, carrying settings across, and A/B two side by side.',
  categories: ['Mixing & Mastering', 'Workflow'],
  sdk_version: sdkVersion,
  min_luna_version: '3.1.2',
  engines: ['luna'],
  html: 'index.html',
  icon: 'icon.png',
  target: 'browser',
  targets: ['browser', 'window'],
  floating: true,
  show_with_session: true,
  unload_on_close: true,
  width: 380,
  height: 520,
}, null, 2) + '\n');

const allFavs = [...new Set([...(favorites.eq ?? []), ...(favorites.dyn ?? []), ...(favorites.cs ?? [])])];
const missing = allFavs.filter((id) => !maps[id]);
const noTable = Object.values(maps).filter((m) => needsTable(m) && !tables[m.pluginId]).map((m) => m.name);
console.error(`Built ${OUT}`);
console.error(`  ${Object.keys(maps).length} map(s), ${Object.keys(tables).length} table(s), ${(favorites.eq ?? favorites.cs ?? []).length} EQ and ${(favorites.dyn ?? favorites.cs ?? []).length} compressor favourite(s) in favorites.json`);
if (missing.length) console.error(`  ! favourites without a map (hidden): ${missing.join(', ')}`);
if (noTable.length) console.error(`  ! maps with knobs still to measure (build-table): ${noTable.join(', ')}`);
