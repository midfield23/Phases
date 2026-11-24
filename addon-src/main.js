// Phases: the panel. Follows LUNA's selected track. Two rows, each with its own
// insert, favourites and A/B: EQ (EQ and filters) and Compressor (compressor and gate).
// A channel strip can serve both rows from one insert. Drives the shared engine (engine.js,
// built from lib/); maps, measured tables and favourites come from data.js.

const ADD_ON_ID = 'com.johnmulholland.strip-favorites';
const { createEngine, StripError, rolesOf } = StripEngine;
const DATA = window.STRIP_DATA;
const ROLES = ['eq', 'dyn'];
const ROW = { eq: { title: 'EQ', noun: 'EQ', plural: 'EQs' }, dyn: { title: 'COMPRESSOR', noun: 'compressor', plural: 'compressors' } };
const $ = (id) => document.getElementById(id);
const q = (role, sel) => document.querySelector(`[data-role="${role}"] ${sel}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const ICON = {
  power: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/></svg>',
  x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>',
  swap: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 7h12l-4-4"/><path d="M17 17H5l4 4"/></svg>',
};

let luna, session, engine, track;
let sessionReleases = [], trackReleases = [];
let busy = false, pending = false, view = null;
let catalog = new Map();               // pluginId -> { name, manufacturer }
let picker = null;                      // { role, index, tab }: choosing favourite `index` of a row
let focusRow = 'eq';                    // the row the arrow keys step

// ------------------------------------------------------------------ favourites

// Up to eight per row, saved with the panel. The one-list version's favourites seed both rows:
// all of them for EQ, the ones with a compressor for Compressor.
const MAX_FAVS = 8;
const favLists = (() => {
  const read = (k) => { try { const v = JSON.parse(localStorage.getItem(`${ADD_ON_ID}:${k}`) ?? 'null'); return Array.isArray(v) ? v.filter(Boolean) : null; } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(`${ADD_ON_ID}:${k}`, JSON.stringify(v)); } catch { /* none */ } };
  const old = read('favslots');
  const seed = (role) => (old
    ? old.filter((id) => (DATA.maps[id] ? rolesOf(DATA.maps[id]).includes(role) : role === 'eq'))
    : (DATA.favorites?.[role] ?? DATA.favorites?.cs ?? []));
  const lists = { eq: read('fav:eq') ?? seed('eq'), dyn: read('fav:dyn') ?? seed('dyn') };
  for (const r of ROLES) write(`fav:${r}`, lists[r]);
  return {
    get: (role) => lists[role],
    set(role, i, id) { lists[role][i] = id; lists[role] = lists[role].filter(Boolean).slice(0, MAX_FAVS); write(`fav:${role}`, lists[role]); },
    drop(role, i) { lists[role].splice(i, 1); write(`fav:${role}`, lists[role]); },
  };
})();
const favourites = { get eq() { return favLists.get('eq'); }, get dyn() { return favLists.get('dyn'); } };

// ------------------------------------------------------------------ remembered values

// Kept in the session (travels with it), per track. JSON has no Infinity, so it's encoded.
function makeStore(sess) {
  const enc = (s) => JSON.parse(JSON.stringify(s, (_k, v) => (v === Infinity ? '__inf__' : v === -Infinity ? '__-inf__' : v)));
  const dec = (s) => JSON.parse(JSON.stringify(s), (_k, v) => (v === '__inf__' ? Infinity : v === '__-inf__' ? -Infinity : v));
  const local = {
    load: async (k) => { try { const v = localStorage.getItem(`${ADD_ON_ID}:${sess.uid}:${k}`); return v ? dec(JSON.parse(v)) : undefined; } catch { return undefined; } },
    save: async (k, s) => { try { localStorage.setItem(`${ADD_ON_ID}:${sess.uid}:${k}`, JSON.stringify(enc(s))); } catch { /* none */ } },
  };
  let ctx, usable = true;
  const ready = async () => { if (!ctx) { ctx = sess.storage.context(ADD_ON_ID); await ctx.load(); } return ctx; };
  return {
    async load(k) {
      if (!usable) return local.load(k);
      try { const v = (await ready()).value('tracks', k).value; return v == null ? undefined : dec(v); } catch { usable = false; return local.load(k); }
    },
    async save(k, s) {
      if (!usable) return local.save(k, s);
      try { const c = await ready(); await c.add('tracks', k, null); await c.set('tracks', k, enc(s)); } catch { usable = false; return local.save(k, s); }
    },
  };
}

// ------------------------------------------------------------------ options

const prefs = (() => {
  const key = `${ADD_ON_ID}:prefs`;
  let p = { mode: 'copy' };
  try { p = { ...p, ...JSON.parse(localStorage.getItem(key) ?? '{}') }; } catch { /* defaults */ }
  const save = () => { try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* none */ } };
  return { get: () => p, set: (o) => { p = { ...p, ...o }; save(); } };
})();
const options = (role) => ({ mode: prefs.get().mode, role });
function bindOptions() {
  $('mode').value = prefs.get().mode;
  $('mode').onchange = () => prefs.set({ mode: $('mode').value });
}

// ------------------------------------------------------------------ names

function plugName(id) { return DATA.maps[id]?.name ?? catalog.get(id)?.name ?? String(id).split(/[.:]/).pop(); }
function plugMaker(id) { return catalog.get(id)?.manufacturer ?? ''; }
async function loadCatalog() {
  try {
    const rows = await luna.plugins.query({ limit: 5000 });
    catalog = new Map(rows.map((r) => [r.pluginId, r]));
  } catch { /* older LUNA: names come from maps, else the id */ }
}

// ------------------------------------------------------------------ messages and actions

function say(text, bad = false) { $('msg').textContent = text; $('msg').classList.toggle('bad', bad); }

// The last swap's write-by-write record, for tracking down a value that lands wrong.
let lastTrace = null;
function traceText() {
  if (!lastTrace?.length) return 'No values written yet.';
  return lastTrace.map((t) => [
    `${t.key || '-'} → ${t.param}${t.stepped ? ` [${t.stepped}]` : ''}`,
    `  strip value ${t.from}  sent ${t.sent}  ${t.result ?? ''}`,
    `  before ${t.before}`,
    `  after  ${t.after ?? '?'}`,
    `  3 s    ${t.later ?? '(not yet)'}`,
  ].join('\n')).join('\n');
}
function drawDetails() {
  const open = $('details').classList.contains('open');
  $('detailsText').textContent = open ? traceText() : '';
  $('detailsBtn').textContent = open ? 'Hide details' : 'Details';
}
function describe(r) {
  if (!r) return '';
  if (r.trace) { lastTrace = r.trace; setTimeout(drawDetails, 3300); }
  if (r.warnings?.includes('already on it')) return `Already on ${r.to}.`;
  if (r.added || (!r.from && !r.carried && !r.skipped?.length && !r.warnings?.length)) return `${r.to} added.`;
  const lines = [`${r.from ? `${r.from} → ` : ''}${r.to}: carried ${r.carried} value${r.carried === 1 ? '' : 's'}.`];
  if (r.serves?.length === 2) lines[0] += ' It covers both rows.';
  if (r.nearest?.length) lines.push(`Just past the knob's range, so set to the nearest end: ${r.nearest.join(', ')}.`);
  if (r.skipped?.length) lines.push(`Left at default: ${r.skipped.join(', ')}.`);
  const unmapped = (r.warnings ?? []).some((w) => /no map/.test(w));
  const kept = r.keptForLater ?? [];
  if (unmapped) lines.splice(0, 1, `${r.from ? `${r.from} → ` : ''}${r.to}.`);
  else if (kept.length) lines.push(kept.length <= 4 ? `Kept for later: ${kept.join(', ')}.` : `Kept ${kept.length} settings this plugin doesn't have, for later.`);
  for (const w of r.warnings ?? []) lines.push(w);
  return lines.join('\n');
}
async function act(fn) {
  if (busy || !track) return;
  busy = true;
  document.body.classList.add('busy');
  say('Working…');
  try { say((await fn()) ?? ''); } catch (e) {
    say(e instanceof StripError ? e.message : `Something went wrong: ${e.message ?? e}`, true);
    if (!(e instanceof StripError)) console.error(e);
  } finally {
    busy = false;
    document.body.classList.remove('busy');
    await render();
  }
}

const switchTo = (role, id) => { focusRow = role; return act(async () => describe(await engine.swap(session, track, id, { ...options(role), insert: true }))); };
const step = (role, n) => { focusRow = role; return act(async () => {
  const v = await engine.inspect(track);
  if (v.compare) throw new StripError('Finish the comparison first: keep A or B.');
  const id = engine.stepFrom(v.rows[role]?.map.pluginId, n, role);
  if (!id) throw new StripError(`No ${ROW[role].noun} favourites yet: click + to add one.`);
  return describe(await engine.swap(session, track, id, { ...options(role), insert: true }));
}); };
const compareWith = (role, id) => { focusRow = role; return act(async () => `${describe(await engine.compare(session, track, id, options(role)))}\nNow hearing B. Flip to compare, then keep one.`); };
const flip = () => act(async () => { const r = await engine.flip(session, track); return `Now hearing ${r.active.toUpperCase()}: ${r.name}.`; });
const keep = (which) => act(async () => { const r = await engine.keep(session, track, which); return [`Kept ${r.kept}.`, ...r.warnings].join('\n'); });
const power = (slotId) => act(async () => { await engine.power(session, track, slotId); return ''; });
function assign(role, index, id) {
  favLists.set(role, index, id);
  picker = null;
  const needsMap = !DATA.maps[id];
  say(`${plugName(id)} added to the ${ROW[role].noun} favourites.${needsMap ? ' It has no map yet, so settings won\'t carry to or from it.' : ''}`);
  render();
}
function unassign(role, index) {
  const id = favLists.get(role)[index];
  favLists.drop(role, index);
  say(`${plugName(id)} taken out of the ${ROW[role].noun} favourites.`);
  render();
}
async function toggleEditor(slot) {
  try { if (slot.editorOpen.value) await slot.closeEditor(); else await slot.openEditor(); } catch (e) { say(e.message ?? String(e), true); }
}

// ------------------------------------------------------------------ drawing

async function render() {
  if (busy) { pending = true; return; }
  pending = false;
  if (!session || !engine) return;
  $('track').textContent = track?.name.value ?? 'No track';
  const c = track?.color?.value;
  $('swatch').style.background = typeof c === 'number' ? `#${(c & 0xffffff).toString(16).padStart(6, '0')}` : '';
  if (!track) { view = null; for (const r of ROLES) { q(r, '.favs').innerHTML = ''; drawRow(r, null); } drawPicker(); return; }
  try { view = await engine.inspect(track); } catch (e) { view = null; say(e.message, true); }
  for (const r of ROLES) { drawFavs(r, view); drawRow(r, view); }
  drawPicker();
}

const insertNo = (slot) => (track ? track.effectSlots.indexOf(slot) + 1 : 0);

function drawFavs(role, v) {
  const root = q(role, '.favs');
  root.innerHTML = '';
  const cmp = v?.compare?.role === role ? v.compare : null;
  const busyElsewhere = !!v?.compare && !cmp;
  const row = v?.rows[role];
  const list = favLists.get(role);
  const activeId = cmp ? null : row?.map.pluginId;

  // One entry: a favourite (index >= 0) or the plugin on the track that isn't one (index -1)
  const entry = (id, i) => {
    const line = el('div', 'line');
    line.append(el('span', 'n cond', i >= 0 ? String(i + 1) : ''));
    const map = DATA.maps[id];
    const isA = cmp && cmp.a.map.pluginId === id, isB = cmp && cmp.b.map.pluginId === id;
    const live = (isA && cmp.active === 'a') || (isB && cmp.active === 'b');
    const on = id === activeId;
    const slot = on ? row.slot : isA ? cmp.a.slot : isB ? cmp.b.slot : null;
    const box = el('div', 'fs');
    if (on) box.classList.add('on');
    if (on && slot.in.value === false) box.classList.add('bypassed');
    if (live) box.classList.add('live');
    if (isA || isB) box.append(el('span', 'ab cond', isA ? 'A' : 'B'));

    // The plugin on the track: power on the left
    if (on) {
      const off = slot.in.value === false;
      const pw = el('button', 'pw');
      pw.innerHTML = ICON.power;
      pw.setAttribute('aria-label', `${off ? 'Turn on' : 'Bypass'} ${plugName(id)}`);
      pw.title = off ? 'Turn on' : row.shared ? 'Bypass (the whole strip: both rows)' : 'Bypass';
      pw.disabled = busyElsewhere;
      pw.onclick = () => power(slot.id);
      box.append(pw);
    }

    const nm = el('button', 'nm');
    nm.append(el('b', null, plugName(id)));
    const both = map && rolesOf(map).length === 2;
    let sub;
    if (isA || isB) sub = live ? 'Listening' : (isA && cmp.aMode === 'section' ? `${ROW[role].noun} off while you compare` : 'Off while you compare');
    else if (on) sub = [slot.in.value === false ? 'Bypassed' : `Insert ${insertNo(slot)}`, row.shared ? 'serves both rows' : i < 0 ? 'not a favourite' : ''].filter(Boolean).join(' · ');
    else sub = [plugMaker(id), both ? 'channel strip' : ''].filter(Boolean).join(' · ');
    nm.append(el('small', null, sub));
    nm.title = v?.compare ? 'Finish the comparison first' : on ? 'On this track now' : `Switch the ${ROW[role].noun} to ${plugName(id)}`;
    nm.disabled = !!v?.compare || on;
    nm.onclick = () => switchTo(role, id);
    box.append(nm);

    const needsTable = map && StripEngine.needsTable(map) && !Object.keys(DATA.tables[id] ?? {}).length;
    if (!map) box.append(el('span', 'note cond', 'NO MAP'));
    else if (needsTable) box.append(el('span', 'note cond', 'NOT MEASURED'));

    if (slot) {
      const open = el('button', 'open', slot.editorOpen.value ? 'Close' : 'Open');
      open.title = 'Open or close the plugin window';
      open.onclick = () => toggleEditor(slot);
      box.append(open);
    }
    if (i < 0 && list.length < MAX_FAVS) {
      const add = el('button', 'keepfav', '+ Add');
      add.title = `Add ${plugName(id)} to the ${ROW[role].noun} favourites`;
      add.onclick = () => assign(role, list.length, id);
      box.append(add);
    }
    if (!v?.compare && row && !on) {
      const c = el('button', 'tool');
      c.innerHTML = ICON.swap;
      c.setAttribute('aria-label', `Compare with ${plugName(id)}`);
      c.title = `Compare with ${plugName(id)}`;
      c.onclick = () => compareWith(role, id);
      box.append(c);
    }
    if (i >= 0 && !isA && !isB) {
      const x = el('button', 'tool');
      x.innerHTML = ICON.x;
      x.setAttribute('aria-label', `Take ${plugName(id)} out of the ${ROW[role].noun} favourites`);
      x.title = 'Take out of favourites';
      x.onclick = () => unassign(role, i);
      box.append(x);
    }
    line.append(box);
    root.append(line);
  };

  // The plugin on the track (or A in a comparison), if it isn't a favourite, goes first
  const current = cmp ? cmp.a.map.pluginId : activeId;
  if (current && !list.includes(current)) entry(current, -1);
  list.forEach((id, i) => entry(id, i));

  if (list.length < MAX_FAVS) {
    const line = el('div', 'line');
    line.append(el('span', 'n cond', ''));
    const on = picker?.role === role;
    const add = el('button', `add${on ? ' on' : ''}`, list.length ? '+' : `+  Add ${ROW[role].noun} favourites`);
    add.setAttribute('aria-label', `Add a ${ROW[role].noun} favourite`);
    add.onclick = () => {
      picker = on ? null : { role, index: list.length, tab: 'mapped' };
      $('search').value = '';
      render();
      if (picker) setTimeout(() => $('search').focus(), 0);
    };
    line.append(add);
    root.append(line);
  }
}

// The picker: mapped plugins that can do this row's job, or every plugin LUNA would put
// in a slot, searched the way LUNA's own plugin browser does. It opens under its row.
let searchSeq = 0;
let lastSearch = { key: null, rows: [] };
async function drawPicker() {
  const p = $('picker');
  if (!picker || !track) { picker = null; p.classList.remove('show'); return; }
  const role = picker.role;
  q(role, '.favs').after(p);
  p.classList.add('show');
  $('pickTitle').textContent = `ADD ${ROW[role].title} FAVOURITE`;
  $('tabMapped').textContent = `Mapped ${ROW[role].plural}`;
  $('tabMapped').classList.toggle('on', picker.tab === 'mapped');
  $('tabAll').classList.toggle('on', picker.tab === 'all');
  const qs = $('search').value.trim().toLowerCase();
  const list = $('list');
  const taken = new Set(favLists.get(role));
  const fill = (rows) => {
    list.innerHTML = '';
    rows = rows.filter((r) => !taken.has(r.id));
    if (!rows.length) { list.append(el('div', 'empty', qs ? 'Nothing matches.' : 'Nothing left to add.')); return; }
    for (const r of rows) {
      const b = el('button');
      const m = DATA.maps[r.id];
      const kind = !m ? 'no map' : rolesOf(m).length === 2 ? 'channel strip' : '';
      b.append(el('span', null, r.name), el('small', null, [r.maker, kind].filter(Boolean).join(' · ')));
      b.onclick = () => {
        if (!catalog.has(r.id)) catalog.set(r.id, { pluginId: r.id, name: r.name, manufacturer: r.maker });
        assign(role, picker.index, r.id);
      };
      list.append(b);
    }
  };
  if (picker.tab === 'mapped') {
    // One-job plugins first, then channel strips
    const rows = Object.values(DATA.maps).filter((m) => rolesOf(m).includes(role))
      .sort((a, b) => rolesOf(a).length - rolesOf(b).length || plugName(a.pluginId).localeCompare(plugName(b.pluginId)))
      .map((m) => ({ id: m.pluginId, name: plugName(m.pluginId), maker: plugMaker(m.pluginId) }))
      .filter((r) => !qs || `${r.name} ${r.maker}`.toLowerCase().includes(qs));
    if (!rows.length && !qs) { list.innerHTML = ''; list.append(el('div', 'empty', `No ${ROW[role].plural} mapped yet. Use All plugins: they switch, but settings only carry once mapped.`)); return; }
    fill(rows);
    return;
  }
  const key = `${qs}`;
  if (lastSearch.key === key) { fill(lastSearch.rows); return; }
  const seq = ++searchSeq;
  list.innerHTML = '';
  list.append(el('div', 'empty', 'Searching…'));
  try {
    const opts = { search: qs || undefined, limit: 80, insertType: 'effect_0', channelUid: track.id, sessionUid: session.uid };
    const rows = (await luna.plugins.query(opts)).map((r) => ({ id: r.pluginId, name: r.name, maker: r.manufacturer }));
    if (seq !== searchSeq) return;
    lastSearch = { key, rows };
    fill(rows);
  } catch {
    if (seq !== searchSeq) return;
    fill([...catalog.values()].filter((r) => !qs || `${r.name} ${r.manufacturer}`.toLowerCase().includes(qs)).slice(0, 80)
      .map((r) => ({ id: r.pluginId, name: r.name, maker: r.manufacturer })));
  }
}

function drawRow(role, v) {
  const sec = document.querySelector(`[data-role="${role}"]`);
  sec.classList.toggle('focus', focusRow === role);
  const cmp = v?.compare?.role === role ? v.compare : null;
  const ins = q(role, '.ins');
  ins.innerHTML = '';
  ins.className = 'ins';
  const where = q(role, '.where');
  const row = v?.rows[role];
  where.textContent = cmp ? `A/B · inserts ${insertNo(cmp.a.slot)} & ${insertNo(cmp.b.slot)}` : row ? `Insert ${insertNo(row.slot)}` : '';
  where.classList.toggle('blue', !!cmp);
  q(role, '.prev').disabled = q(role, '.next').disabled = !!v?.compare;
  const box = q(role, '.cmp');
  box.classList.toggle('show', !!cmp);

  if (cmp) {
    ins.style.display = 'none';
    const sideA = q(role, '.sideA'), sideB = q(role, '.sideB');
    sideA.lastElementChild.textContent = plugName(cmp.a.map.pluginId);
    sideB.lastElementChild.textContent = plugName(cmp.b.map.pluginId);
    sideA.classList.toggle('live', cmp.active === 'a');
    sideB.classList.toggle('live', cmp.active === 'b');
    sideA.firstElementChild.textContent = cmp.active === 'a' ? 'A · listening' : 'A · original';
    sideB.firstElementChild.textContent = cmp.active === 'b' ? 'B · listening' : 'B · candidate';
    q(role, '.keepA').textContent = `Keep A · ${plugName(cmp.a.map.pluginId)}`;
    q(role, '.keepB').textContent = `Keep B · ${plugName(cmp.b.map.pluginId)}`;
    q(role, '.cmpNote').textContent = cmp.aMode === 'section'
      ? `${plugName(cmp.a.map.pluginId)} stays in for the ${ROW[ROLES.find((r) => r !== role)].noun}: only its ${ROW[role].noun} switches.` : '';
    return;
  }
  ins.style.display = row || !v ? 'none' : '';
  if (!row && v) {
    ins.classList.add('none');
    ins.textContent = `No ${ROW[role].noun} on this track: click a favourite to add one.`;
  }
}

// ------------------------------------------------------------------ following LUNA

function releaseAll(list) { for (const u of list.splice(0)) { try { u(); } catch { /* gone */ } } }
let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; if (busy) pending = true; else render(); }, 150);
}

async function followTrack() {
  releaseAll(trackReleases);
  picker = null;
  track = session?.focusedTrack.value ?? null;
  if (track) {
    trackReleases.push(track.effects.onChange(schedule));
    trackReleases.push(track.name.onChange(schedule));
    if (track.color) trackReleases.push(track.color.onChange(schedule));
    try {
      await track.effects.load();
      for (const s of track.effectSlots) {
        trackReleases.push(s.pluginId.onChange(schedule));
        trackReleases.push(s.in.onChange(schedule));
      }
    } catch { /* drawn on the next change */ }
  }
  say('');
  await render();
}

async function bindSession() {
  releaseAll(sessionReleases);
  releaseAll(trackReleases);
  session = luna.sessions.current();
  if (!session) {
    engine = null; track = null;
    $('status').textContent = 'no session open';
    $('track').textContent = '—';
    for (const r of ROLES) { q(r, '.favs').innerHTML = ''; q(r, '.ins').innerHTML = ''; }
    return;
  }
  await session.ready();
  $('status').textContent = '';
  engine = createEngine({ Luna, maps: DATA.maps, tables: DATA.tables, favorites: favourites, store: makeStore(session), nameOf: (id) => catalog.get(id)?.name ?? null });
  sessionReleases.push(session.focusedTrack.onChange(followTrack));
  await followTrack();
}

async function connect() {
  for (;;) {
    try { luna = await Luna.connect(); break; } catch (e) {
      $('status').textContent = e instanceof Luna.NotRunning ? 'waiting for LUNA…' : e.message;
      await sleep(1500);
    }
  }
  Luna.bindShortcuts(luna);
  loadCatalog().then(() => render());
  await luna.sessions.ready();
  luna.sessions.focused.onChange(bindSession);
  luna.sessions.items.onChange(bindSession);
  await bindSession();
}

for (const role of ROLES) {
  q(role, '.prev').onclick = () => step(role, -1);
  q(role, '.next').onclick = () => step(role, 1);
  q(role, '.flip').onclick = flip;
  q(role, '.keepA').onclick = () => keep('a');
  q(role, '.keepB').onclick = () => keep('b');
  q(role, '.bar').addEventListener('click', (e) => { if (e.target.closest('button')) return; focusRow = role; render(); });
}
$('pickClose').onclick = () => { picker = null; render(); };
$('tabMapped').onclick = () => { if (picker) { picker.tab = 'mapped'; drawPicker(); } };
$('tabAll').onclick = () => { if (picker) { picker.tab = 'all'; drawPicker(); } };
let searchTimer;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(drawPicker, 200); };
$('detailsBtn').addEventListener('click', () => { $('details').classList.toggle('open'); drawDetails(); });
$('copyDetails').addEventListener('click', async () => {
  const text = `${$('msg').textContent}\n\n${traceText()}`;
  try { await navigator.clipboard.writeText(text); $('copyDetails').textContent = 'Copied'; }
  catch { const r = document.createRange(); r.selectNodeContents($('detailsText')); getSelection().removeAllRanges(); getSelection().addRange(r); $('copyDetails').textContent = 'Selected: press ⌘C'; }
  setTimeout(() => { $('copyDetails').textContent = 'Copy'; }, 2000);
});
document.addEventListener('keydown', (e) => {
  if (['SELECT', 'INPUT'].includes(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey) {
    if (e.key === 'Escape' && picker) { picker = null; render(); }
    return;
  }
  if (e.key === 'Escape' && picker) { e.preventDefault(); picker = null; render(); }
  // ←/→ step the focused row (or flip while comparing); ↑/↓ choose the row
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); focusRow = e.key === 'ArrowUp' ? 'eq' : 'dyn'; render(); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); if (view?.compare) flip(); else step(focusRow, -1); }
  if (e.key === 'ArrowRight') { e.preventDefault(); if (view?.compare) flip(); else step(focusRow, 1); }
});
bindOptions();
$('build').textContent = window.STRIP_BUILD ? `Build ${window.STRIP_BUILD}` : '';
setInterval(() => { if (pending && !busy) render(); }, 500);
connect();
