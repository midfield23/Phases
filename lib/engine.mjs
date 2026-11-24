/**
 * The swap engine, shared by the Terminal tools and the LUNA panel.
 * Browser-safe: no Node imports. Everything LUNA-specific comes in through createEngine().
 *
 *   const engine = createEngine({ Luna, maps, tables, favorites: { eq: [...], dyn: [...] }, store });
 *   await engine.swap(session, track, 'com.SSLN.au.aufx_S4KE', { role: 'eq' });
 *   await engine.compare(session, track, id, { role: 'dyn' });  await engine.flip(session, track);  await engine.keep(session, track, 'b');
 *
 * Two rows, each with its own insert: the EQ row (EQ and filters) and the Compressor row
 * (compressor and gate). A channel strip can serve both rows from one insert; when the other
 * row has a plugin of its own, the strip's section for that row is switched off instead.
 *
 * store: { load(trackKey) -> Promise<state|undefined>, save(trackKey, state) -> Promise }
 * Track state (v2): { rows: { eq: row, dyn: row }, own: { pluginId: { param: normalized } },
 *   off: { slotId: { pluginId, eq?|dyn?: { param: normalized } } }, compare }
 *   row: { slot, remembered, held, heldAt }
 */
import { readStrip, planStrip, mergeRemembered, num, nearEnough, needsTable } from './convert.mjs';
import { CONTROLS } from './controls.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class StripError extends Error {}

/** Which sections each row looks after. Trims and polarity (io) travel with every row. */
export const ROLES = { eq: ['eq'], dyn: ['dyn', 'gate'] };
export const ROW_NAME = { eq: 'EQ', dyn: 'Compressor' };
const OTHER = { eq: 'dyn', dyn: 'eq' };
/** What switching a row's section off on a strip writes. */
const OFF = { eq: { eq_in: 'off', filters_in: 'off', hpf: 'off', lpf: 'off' }, dyn: { comp_in: 'off', gate_in: 'off' } };
const sectionOf = (key) => CONTROLS[key]?.section ?? 'eq';
const inRole = (key, role, io = true) => ROLES[role].includes(sectionOf(key)) || (io && sectionOf(key) === 'io');
const pickRole = (obj, role, io = true) => Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => inRole(k, role, io)));

/** The rows a map can serve, from what it has. */
export function rolesOf(map) {
  if (!map || map.unmapped) return [];
  const secs = new Set(Object.keys(map.controls ?? {}).map(sectionOf));
  if (map.flex || map.graphic) secs.add('eq');
  return Object.keys(ROLES).filter((r) => ROLES[r].some((s) => secs.has(s)));
}

export function createEngine({ Luna, maps, tables = {}, favorites = { cs: [] }, store, log = () => {}, nameOf = null }) {
  const mapOf = (id) => (maps instanceof Map ? maps.get(id) : maps[id]);
  const tablesOf = (id) => tables[id] ?? {};
  /** A plugin as a channel strip: its map, or a stand-in for one without a map (nothing carries). */
  const stripOf = (id) => mapOf(id) ?? {
    pluginId: id, name: nameOf?.(id) ?? String(id).split(/[.:]/).pop(), domain: 'cs', mode: 'real', controls: {}, unmapped: true,
  };
  /** A row's favourites, in order (empty slots dropped). Plugins without a map are allowed. */
  const favs = (role = 'eq') => (favorites[role] ?? favorites.cs ?? []).filter(Boolean);

  // ------------------------------------------------------------------ LUNA helpers

  const fmt = (v) => (v = num(v), typeof v === 'number' ? String(Math.round(v * 10000) / 10000) : String(v));
  /** A parameter's state, for the details view. */
  const show = (p) => (p ? `${fmt(p.real?.value)} / n${fmt(p.normalized?.value)} "${p.display?.value ?? ''}"` : '?');

  /**
   * What to hand the SDK. For a continuous control it adds the float literal LUNA wants itself,
   * and keeps a plain number as the local value; wrapping it here would leave the wrapper as the
   * value until LUNA reports back. Wrap only when the SDK doesn't know the control is continuous.
   */
  const wire = (p, v) => (p.discrete?.value === false ? v : Luna.float(v));

  async function writeNorm(p, n) {
    try {
      await p.normalized.set(wire(p, n));
    } catch (e) {
      if (e.code !== 'uasrv.invalid_type') throw e;
      await p.normalized.set(n === 0 ? 1e-9 : n === 1 ? 1 - 1e-9 : n);
    }
  }

  /**
   * Write a value in real units. LUNA refuses one outside the knob's range
   * (uasrv.invalid_value) rather than clamping it: a filter then goes to the end of its
   * range (fully open); anything else is rethrown and left at its default.
   */
  async function writeReal(p, w) {
    try {
      await p.real.set(wire(p, w.real));
    } catch (e) {
      if (e.code !== 'uasrv.invalid_value' || !w.filter) throw e;
      const now = typeof num(p.real.value) === 'number' ? num(p.real.value) : w.real;
      await writeNorm(p, w.real < now ? 0 : 1);
    }
  }

  /** A slot's parameters by name, once their values (and, optionally, these names) have arrived. */
  async function slotParams(slot, expect = [], timeoutMs = 6000) {
    await slot.controls.load();
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ps = slot.params;
      const names = new Set(ps.map((p) => p.name.value));
      // A stepped control's list of steps can arrive after its value; without it a step can't be chosen.
      const stepsIn = (p) => p.discrete?.value !== true || Array.isArray(p.realValues?.value) || Date.now() - t0 > 3000;
      if (ps.length && ps.every((p) => typeof num(p.normalized.value) === 'number' && stepsIn(p)) && expect.every((n) => names.has(n))) break;
      if (!ps.length && !expect.length && Date.now() - t0 > 1500) break;   // a plugin that shows no parameters
      await sleep(100);
    }
    await sleep(150);
    return new Map(slot.params.map((p) => [p.name.value, p]));
  }

  /** Load the insert list; a slot whose plugin hasn't arrived would read as empty. */
  async function loadInserts(track) {
    await track.effects.load();
    for (let i = 0; i < 20 && track.effectSlots.some((s) => s.pluginId.value === undefined); i++) await sleep(100);
    if (track.effectSlots.some((s) => s.pluginId.value === undefined)) {
      throw new StripError(`"${track.name.value}": insert list didn't load. Nothing changed.`);
    }
    if (track.uid.value && track.uid.value !== track.id) {
      throw new StripError(`"${track.name.value}": track ids disagree; refusing to edit. Nothing changed.`);
    }
  }

  /** Load a plugin into one slot of this track and confirm it landed there. */
  async function loadInto(track, slotId, pluginId) {
    const slot = track.effects.byId(slotId);
    await slot.setPlugin(pluginId, { wait: false });
    for (let i = 0; i < 50; i++) {
      await sleep(300);
      await track.effects.reload();
      const s = track.effects.byId(slotId);
      if (s?.pluginError.value) throw new StripError(`LUNA could not load ${mapOf(pluginId)?.name ?? pluginId}: ${s.pluginError.value}`);
      if (s?.pluginId.value === pluginId) return s;
    }
    throw new StripError(`${mapOf(pluginId)?.name ?? pluginId} did not appear in ${slotId} on "${track.name.value}". ` +
      'Nothing was written; check the other channels and undo in LUNA if it landed elsewhere.');
  }

  const trackKey = (track) => track.uid?.value ?? track.id;
  const emptyRow = () => ({ slot: null, remembered: {}, held: [], heldAt: {} });
  async function loadState(track) {
    const s = (await store.load(trackKey(track))) ?? {};
    if (s.v === 2) {
      return { own: {}, off: {}, compare: null, ...s, rows: { eq: { ...emptyRow(), ...s.rows?.eq }, dyn: { ...emptyRow(), ...s.rows?.dyn } } };
    }
    // Saved by the one-strip version: one memory, one strip insert serving both rows
    const row = (role) => ({
      slot: s.stripSlot ?? null,
      remembered: pickRole(s.remembered, role),
      held: (s.held ?? []).filter((k) => inRole(k, role)),
      heldAt: pickRole(s.heldAt, role),
    });
    const c = s.compare;
    return {
      v: 2, rows: { eq: row('eq'), dyn: row('dyn') }, own: s.own ?? {}, off: {},
      compare: c ? { ...c, role: 'eq', aMode: 'slot', bServes: ['eq', 'dyn'] } : null,
    };
  }
  const saveState = (track, ts) => store.save(trackKey(track), ts);

  const snapshotOf = (params) => Object.fromEntries([...params].map(([n, p]) => [n, num(p.normalized.value)]));

  // ------------------------------------------------------------------ reading the track

  /** Is this slot's section for `role` switched off by us (the other row has its own plugin)? */
  const isOff = (ts, slot, role) => { const o = ts.off?.[slot.id]; return !!o && o.pluginId === slot.pluginId.value && !!o[role]; };
  const covers = (slot, role) => rolesOf(mapOf(slot.pluginId.value)).includes(role);

  /**
   * Which insert serves each row: the one we put there (kept while it still holds a plugin
   * that can do the job), else a strip already serving the other row, else any mapped plugin
   * that can, preferring one made for just that job.
   */
  function resolveRows(track, ts) {
    const slots = track.effectSlots;
    const c = ts.compare;
    const rows = {};
    for (const role of Object.keys(ROLES)) {
      const id = ts.rows[role]?.slot;
      const s = id && slots.find((x) => x.id === id && !x.isEmpty);
      if (s && (!mapOf(s.pluginId.value) || covers(s, role)) && !isOff(ts, s, role) && s.id !== c?.b) rows[role] = s;
    }
    for (const role of Object.keys(ROLES)) {
      if (rows[role]) continue;
      const other = rows[OTHER[role]];
      if (other && covers(other, role) && !isOff(ts, other, role)) { rows[role] = other; continue; }
      const cands = slots.filter((s) => !s.isEmpty && s !== other && s.id !== c?.b && covers(s, role) && !isOff(ts, s, role));
      cands.sort((x, y) => rolesOf(mapOf(x.pluginId.value)).length - rolesOf(mapOf(y.pluginId.value)).length);
      rows[role] = cands[0] ?? null;
    }
    return rows;
  }

  async function view(track) {
    await loadInserts(track);
    const ts = await loadState(track);
    const found = resolveRows(track, ts);
    const entry = (s) => (s ? { slot: s, map: stripOf(s.pluginId.value), shared: found.eq === found.dyn } : null);
    const rows = { eq: entry(found.eq), dyn: entry(found.dyn) };
    let compare = null;
    const c = ts.compare;
    if (c) {
      const sa = track.effects.byId(c.a), sb = track.effects.byId(c.b);
      if (sa?.pluginId.value === c.aId && sb?.pluginId.value === c.bId) {
        const a = { slot: sa, map: stripOf(c.aId) }, b = { slot: sb, map: stripOf(c.bId) };
        compare = { role: c.role ?? 'eq', a, b, active: sb.in.value === false ? 'a' : 'b', aMode: c.aMode ?? 'slot' };
      }
    }
    return { ts, rows, compare };
  }
  /** The rows a slot serves right now. */
  const servedBy = (rows, slot) => Object.keys(ROLES).filter((r) => rows[r]?.slot.id === slot.id);

  /**
   * What's on the track. Returns { rows: { eq, dyn }, compare, active, strips }:
   * a row is { slot, map, shared } or null; compare is { role, a, b, active } or null.
   * `active` (the EQ row's plugin, else the Compressor row's) and `strips` are for older callers.
   */
  async function inspect(track) {
    const { rows, compare } = await view(track);
    const active = compare ? compare[compare.active] : rows.eq ?? rows.dyn;
    const strips = [...new Map([rows.eq, rows.dyn].filter(Boolean).map((r) => [r.slot.id, r])).values()];
    return { rows, compare, active, strips };
  }

  /** The favourite `step` places from `activeId` in a row's list (wraps). */
  function stepFrom(activeId, step, role = 'eq') {
    const list = favs(role);
    if (!list.length) return null;
    const i = list.indexOf(activeId);
    if (i < 0) return list[step < 0 ? list.length - 1 : 0];
    return list[(i + step + list.length) % list.length];
  }

  // ------------------------------------------------------------------ writing a strip

  async function writeAll(session, label, params, writes, onError = null) {
    await session.transaction(label, async () => {
      for (const w of writes) {
        const p = params.get(w.param);
        if (!p) continue;
        try {
          if ('real' in w) await writeReal(p, w);
          else await writeNorm(p, w.normalized);
        } catch (e) { if (onError) onError(w, e); else throw e; }
      }
    });
  }

  /**
   * LUNA refuses a value past the end of a knob, and the SDK doesn't say where the ends are.
   * For refused values: set each knob to both ends to see them, then go to the nearer end if the
   * value only just misses it (within 10% of the knob's span, or 1 dB); otherwise put the knob back.
   * Returns the keys that went to an end.
   */
  async function toNearestEnd(session, map, params, refused, trace) {
    const cands = refused.filter((w) => params.has(w.param) && 'real' in w && w.key && !w.filter && isFinite(w.real) && params.get(w.param)?.discrete?.value === false)
      .map((w) => ({ w, p: params.get(w.param), was: num(params.get(w.param).normalized.value) }));
    if (!cands.length) return [];
    const at = async (n) => {
      await session.transaction(`Strip values: ${map.name}`, async () => { for (const c of cands) await writeNorm(c.p, n); });
      await sleep(300);
      return cands.map((c) => num(c.p.real.value));
    };
    const lo = await at(0), hi = await at(1);
    const done = [];
    await session.transaction(`Strip values: ${map.name}`, async () => {
      for (const [i, c] of cands.entries()) {
        const target = c.w.real, ends = [lo[i], hi[i]];
        let n = typeof c.was === 'number' ? c.was : 0;
        if (ends.every((v) => typeof v === 'number' && isFinite(v))) {
          const end = Math.abs(target - ends[0]) <= Math.abs(target - ends[1]) ? 0 : 1;
          const tol = nearEnough(ends[1] - ends[0], CONTROLS[c.w.key]?.unit);
          if (Math.abs(target - ends[end]) <= tol) {
            n = end;
            done.push(c.w.key);
            const t = trace.find((x) => x.key === c.w.key);
            if (t) t.result += ` → nearest end ${fmt(ends[end])}`;
          }
        }
        await writeNorm(c.p, n);
      }
    });
    return done;
  }

  /**
   * Write values (or an own-mode snapshot) to a freshly loaded plugin. `values` are the
   * remembered settings for the rows it serves; `sections` those rows' sections.
   */
  async function applyTo(session, slot, map, ts, { mode = 'copy', sections, values }) {
    const mapped = [...new Set(Object.values(map.controls).map((c) => c.param).filter(Boolean))];   // fixed controls have none
    const expected = mapped.slice(0, 3);
    const params = await slotParams(slot, expected);
    const missing = mapped.filter((n) => !params.has(n));
    const warnings = missing.length ? [`not on ${map.name} in LUNA (check the map): ${missing.join(', ')}`] : [];
    const tbl = tablesOf(map.pluginId);
    if (needsTable(map) && !Object.keys(tbl).length) {
      warnings.push(`${map.name} has no measured table yet (run tools/build-table.mjs); ${map.mode === 'table' ? 'values' : 'its measured knobs'} not carried`);
    }

    let writes = [], skipped = [], held = [], planned = [];
    const snapshot = ts.own[map.pluginId];
    if (mode === 'own' && snapshot) {
      writes = Object.entries(snapshot).filter(([n]) => params.has(n)).map(([param, normalized]) => ({ param, normalized }));
    } else {
      ({ writes, skipped, held, nearest: planned } = planStrip(map, params, tbl, values, sections));
      if (snapshot) {
        // The sections this plugin isn't carrying for: as it was last left
        for (const [key, def] of Object.entries(map.controls)) {
          const sec = CONTROLS[key]?.section;
          if (sec !== 'io' && !sections.includes(sec) && def.param in snapshot && params.has(def.param)) writes.push({ param: def.param, normalized: snapshot[def.param] });
        }
        // ...and everything its map doesn't carry (modes, knob positions, meters): as it was last left
        const touched = new Set(writes.map((w) => w.param));
        for (const d of Object.values(map.controls)) for (const n of [d.param, d.range?.param, d.enable?.param]) if (n) touched.add(n);
        for (const w of Object.values(map.when ?? {})) touched.add(w.param);
        for (const [param, normalized] of Object.entries(snapshot)) {
          if (!touched.has(param) && params.has(param) && typeof normalized === 'number') writes.push({ param, normalized });
        }
      }
    }

    const refused = [];
    const trace = [];
    await session.transaction(`Strip values: ${map.name}`, async () => {
      for (const w of writes) {
        const p = params.get(w.param);
        if (!p) { refused.push(w); trace.push({ key: w.key ?? '', param: w.param, from: '', sent: '', stepped: '', before: '?', result: 'not on the plugin in LUNA' }); continue; }
        const t = { key: w.key ?? '', param: w.param, from: w.key ? fmt(values?.[w.key]) : '', sent: ('real' in w ? `real ${fmt(w.real)}` : `norm ${fmt(w.normalized)}`) + (w.nearest ? ' (nearest end)' : ''),
          stepped: p.discrete?.value === true ? (Array.isArray(p.realValues?.value) ? 'steps' : 'NO STEPS') : '',
          before: show(p) };
        trace.push(t);
        try {
          if ('real' in w) await writeReal(p, w);
          else await writeNorm(p, w.normalized);
          t.result = 'ok';
        } catch (e) {
          // One value LUNA won't take must not stop the rest
          refused.push(w);
          t.result = `refused ${e.code ?? e.message}`;
          log(`  ${w.param}: refused (${e.code ?? e.message})`);
        }
      }
    });
    // Refused: the map has no recorded ends for that knob, so find them now
    const nearest = [...planned, ...await toNearestEnd(session, map, params, refused, trace)];
    if (refused.length) {
      const keys = refused.map((w) => w.key).filter(Boolean);
      skipped.push(...keys.filter((k) => !nearest.includes(k)));
      held.push(...keys);   // the exact value stays remembered either way
    }
    await sleep(500);
    for (const t of trace) t.after = show(params.get(t.param));
    // Check again later: something that moves a value after our write shows up here.
    setTimeout(() => { for (const t of trace) t.later = show(params.get(t.param)); }, 3000);
    const shows = readStrip(map, params, tbl);
    const heldAt = Object.fromEntries(held.filter((k) => k in shows).map((k) => [k, shows[k]]));
    return { params, carried: writes.length - refused.length + (nearest.length - planned.length), nearest, skipped: [...new Set(skipped)], held: [...new Set(held)], heldAt, warnings, trace };
  }

  /**
   * Switch a row's section off on a plugin (its EQ, filters included, or its compressor and
   * gate). Returns what those controls were, to put back, or null if the map has no switch for it.
   */
  async function sectionOff(session, slot, map, role, params = null) {
    const vals = Object.fromEntries(Object.entries(OFF[role]).filter(([k]) => map.controls[k]));
    if (!Object.keys(vals).some((k) => k.endsWith('_in'))) return null;
    params ??= await slotParams(slot);
    const { writes } = planStrip(map, params, tablesOf(map.pluginId), vals, ROLES[role]);
    const saved = {};
    for (const w of writes) if (params.has(w.param)) saved[w.param] = num(params.get(w.param).normalized.value);
    await writeAll(session, `${ROW_NAME[role]} off: ${map.name}`, params, writes, (w, e) => log(`  ${w.param}: refused (${e.code ?? e.message})`));
    return saved;
  }
  async function sectionOn(session, slot, map, role, saved, params = null) {
    if (!saved) return;
    params ??= await slotParams(slot);
    await writeAll(session, `${ROW_NAME[role]} on: ${map.name}`, params,
      Object.entries(saved).map(([param, normalized]) => ({ param, normalized })), () => {});
  }

  /** Read a plugin into the memory of the rows it serves, and keep its snapshot. */
  async function absorb(slot, map, ts, roles) {
    const params = await slotParams(slot);
    const values = readStrip(map, params, tablesOf(map.pluginId));
    ts.own[map.pluginId] = snapshotOf(params);
    for (const role of roles) {
      const row = ts.rows[role];
      row.remembered = mergeRemembered(row.remembered, pickRole(values, role), row.held ?? [], row.heldAt ?? {});
    }
    return values;
  }

  /** The remembered settings for a plugin serving `serves`; trims come from `role`'s row. */
  function memoryFor(ts, serves, role) {
    const out = {};
    for (const x of serves) if (x !== role) Object.assign(out, pickRole(ts.rows[x].remembered, x, false));
    return Object.assign(out, pickRole(ts.rows[role].remembered, role));
  }
  const sectionsFor = (serves) => ['io', ...serves.flatMap((r) => ROLES[r])];
  function setHeld(ts, serves, held, heldAt) {
    for (const x of serves) {
      ts.rows[x].held = held.filter((k) => inRole(k, x));
      ts.rows[x].heldAt = pickRole(heldAt, x);
    }
  }
  /** Turn off the sections of `map` that rows served elsewhere look after. */
  async function quietOthers(session, slot, map, serves, ts, params, warnings) {
    for (const x of rolesOf(map).filter((r) => !serves.includes(r))) {
      const saved = await sectionOff(session, slot, map, x, params);
      if (saved) ts.off[slot.id] = { ...(ts.off[slot.id]?.pluginId === map.pluginId ? ts.off[slot.id] : {}), pluginId: map.pluginId, [x]: saved };
      else warnings.push(`${map.name}'s ${x === 'eq' ? 'EQ' : 'compressor'} has no in/out switch in its map, so it's still on.`);
    }
  }

  const summary = (target, r, ts, serves) => ({
    to: target.name,
    carried: r.carried,
    skipped: r.skipped,
    keptForLater: Object.keys(memoryFor(ts, serves, serves[0])).filter((k) => !target.controls[k] && !target.flex && !target.graphic),
    warnings: r.warnings,
    trace: r.trace,
    nearest: r.nearest ?? [],
  });

  /** An empty insert for a new row plugin: EQ before the compressor, the compressor after the EQ. */
  function emptyFor(track, role, otherSlot) {
    const slots = track.effectSlots;
    const empty = (s) => s.isEmpty;
    if (!otherSlot) return slots.find(empty);
    const i = slots.indexOf(otherSlot);
    if (role === 'eq') return [...slots.slice(0, i)].reverse().find(empty) ?? slots.slice(i + 1).find(empty);
    return slots.slice(i + 1).find(empty) ?? [...slots.slice(0, i)].reverse().find(empty);
  }

  // ------------------------------------------------------------------ actions

  /**
   * Replace a row's plugin with `targetId`, carrying that row's settings. A strip that takes
   * over a row with no plugin of its own carries that row too; one whose other row has its own
   * plugin gets that section switched off. Inserts one if `insert`.
   */
  async function swap(session, track, targetId, { role = 'eq', mode = 'copy', insert = false, slotId: intoSlot = null } = {}) {
    const target = stripOf(targetId);
    const v = await view(track);
    if (v.compare) throw new StripError('Finish the comparison first: keep A or B.');
    const cur = v.rows[role], other = OTHER[role], oth = v.rows[other];
    if (cur?.map.pluginId === targetId) return { to: target.name, carried: 0, skipped: [], keptForLater: [], warnings: ['already on it'] };

    const ts = v.ts;
    const notes = [];
    let slotId, wasIn, wasOpen, from = null, curServes = [];
    if (cur) {
      from = cur.map.name;
      curServes = servedBy(v.rows, cur.slot);
      await absorb(cur.slot, cur.map, ts, curServes);
      slotId = cur.slot.id;
      wasIn = cur.slot.in.value;
      wasOpen = cur.slot.editorOpen.value === true;
    } else {
      if (!insert) throw new StripError(`No ${ROW_NAME[role]} plugin on "${track.name.value}".`);
      const empty = intoSlot ? track.effects.byId(intoSlot) : emptyFor(track, role, oth?.slot);
      if (!empty || !empty.isEmpty) throw new StripError(intoSlot ? `${intoSlot} isn't empty.` : 'No empty insert slot on this track.');
      slotId = empty.id;
    }
    const tRoles = target.unmapped ? [role] : rolesOf(target);
    const otherFree = !oth || oth.slot.id === slotId;   // the other row has no plugin of its own
    const serves = [role, ...(tRoles.includes(other) && otherFree ? [other] : [])];
    if (curServes.includes(other) && !serves.includes(other)) {
      notes.push(`${from}'s ${other === 'dyn' ? 'compressor' : 'EQ'} settings are kept for the ${ROW_NAME[other]} row.`);
    }

    log(`${track.name.value} ${ROW_NAME[role]}: ${from ?? '(none)'} -> ${target.name}`);
    const slot = await loadInto(track, slotId, targetId);
    delete ts.off[slotId];
    const r = await applyTo(session, slot, target, ts, { mode, sections: sectionsFor(serves), values: memoryFor(ts, serves, role) });
    await quietOthers(session, slot, target, serves, ts, r.params, r.warnings);
    if (wasIn === false) await slot.setIn(false).catch(() => {});
    if (wasOpen) await slot.openEditor().catch(() => {});
    setHeld(ts, serves, r.held, r.heldAt);
    for (const x of serves) ts.rows[x].slot = slotId;
    for (const x of curServes) if (!serves.includes(x)) ts.rows[x].slot = null;
    await saveState(track, ts);
    const warnings = [...notes, ...r.warnings, ...(target.unmapped ? [`${target.name} has no map yet, so settings didn't carry.`] : [])];
    return { from, role, serves, ...summary(target, r, ts, serves), warnings };
  }

  /**
   * Load `targetId` into a spare insert next to a row's plugin, with that row's settings, and
   * make it the one you hear (A = the original, B = the candidate). When A is a strip that also
   * serves the other row and B can't, A stays in and only its section for this row goes off.
   */
  async function compare(session, track, targetId, { role = 'eq', mode = 'copy' } = {}) {
    const target = stripOf(targetId);
    const v = await view(track);
    if (v.compare) throw new StripError('Already comparing: keep A or B first.');
    const cur = v.rows[role];
    if (!cur) throw new StripError(`No ${ROW_NAME[role]} plugin on "${track.name.value}" to compare with.`);
    if (cur.map.pluginId === targetId) throw new StripError(`Already on ${target.name}.`);

    const slots = track.effectSlots;
    const ai = slots.indexOf(cur.slot);
    const spare = slots.slice(ai + 1).find((s) => s.isEmpty) ?? slots.find((s) => s.isEmpty);
    if (!spare) throw new StripError('No free insert slot for the comparison.');

    const ts = v.ts;
    const aServes = servedBy(v.rows, cur.slot);
    await absorb(cur.slot, cur.map, ts, aServes);
    const tRoles = target.unmapped ? [role] : rolesOf(target);
    const bServes = aServes.filter((x) => x === role || tRoles.includes(x));
    log(`${track.name.value} ${ROW_NAME[role]}: compare ${cur.map.name} with ${target.name} in ${spare.id}`);
    const b = await loadInto(track, spare.id, targetId);
    delete ts.off[b.id];
    const r = await applyTo(session, b, target, ts, { mode, sections: sectionsFor(bServes), values: memoryFor(ts, bServes, role) });
    await quietOthers(session, b, target, bServes, ts, r.params, r.warnings);

    let aMode = aServes.some((x) => !bServes.includes(x)) ? 'section' : 'slot';
    let aSaved = null;
    if (aMode === 'section') {
      aSaved = await sectionOff(session, cur.slot, cur.map, role);
      if (!aSaved) {
        aMode = 'slot';
        r.warnings.push(`${cur.map.name} has no ${role === 'eq' ? 'EQ' : 'compressor'} switch in its map, so A/B bypasses all of it.`);
      }
    }
    await session.transaction('Compare', async () => {
      if (aMode === 'slot') await cur.slot.setIn(false);
      await b.setIn(true);
    });
    ts.compare = { role, a: cur.slot.id, aId: cur.map.pluginId, b: b.id, bId: targetId, aMode, aSaved, aServes, bServes, held: r.held, heldAt: r.heldAt };
    await saveState(track, ts);
    return { from: cur.map.name, role, ...summary(target, r, ts, bServes), slot: b.id };
  }

  /** Switch which of the two you hear. */
  async function flip(session, track) {
    const { compare: c, ts } = await view(track);
    if (!c) throw new StripError('No comparison in progress.');
    const toA = c.active === 'b';
    if (c.aMode === 'section') {
      if (toA) {
        await c.b.slot.setIn(false);
        await sectionOn(session, c.a.slot, c.a.map, c.role, ts.compare.aSaved);
      } else {
        ts.compare.aSaved = await sectionOff(session, c.a.slot, c.a.map, c.role) ?? ts.compare.aSaved;
        await c.b.slot.setIn(true);
        await saveState(track, ts);
      }
    } else {
      await session.transaction('Flip A/B', async () => {
        await c.a.slot.setIn(toA);
        await c.b.slot.setIn(!toA);
      });
    }
    return { active: toA ? 'a' : 'b', name: (toA ? c.a : c.b).map.name, role: c.role };
  }

  /** End the comparison, keeping 'a' or 'b'. Keeping B leaves it where the original was in the chain. */
  async function keep(session, track, which) {
    const { compare: c, ts } = await view(track);
    if (!c) throw new StripError('No comparison in progress.');
    const tc = ts.compare;
    const aServes = tc.aServes ?? [c.role], bServes = tc.bServes ?? aServes;
    const done = (kept, warnings = []) => ({ kept, role: c.role, warnings });

    if (which === 'a') {
      if (c.aMode === 'section' && c.active === 'b') await sectionOn(session, c.a.slot, c.a.map, c.role, tc.aSaved);
      await absorb(c.a.slot, c.a.map, ts, aServes);
      await session.transaction(`Keep ${c.a.map.name}`, async () => {
        await c.a.slot.setIn(true);
        await c.b.slot.clear();
      });
      delete ts.off[c.b.slot.id];
      ts.compare = null;
      for (const x of aServes) ts.rows[x].slot = c.a.slot.id;
      await saveState(track, ts);
      return done(c.a.map.name);
    }

    // Keep B
    if (c.aMode === 'section' && c.active === 'a') tc.aSaved = await sectionOff(session, c.a.slot, c.a.map, c.role) ?? tc.aSaved;
    await absorb(c.b.slot, c.b.map, ts, bServes);
    setHeld(ts, bServes, tc.held ?? [], tc.heldAt ?? {});
    if (c.aMode === 'section') {
      // A stays for the other row, with this row's section off
      await c.b.slot.setIn(true);
      ts.off[c.a.slot.id] = { ...(ts.off[c.a.slot.id]?.pluginId === c.aId ? ts.off[c.a.slot.id] : {}), pluginId: c.aId, [c.role]: tc.aSaved };
      ts.compare = null;
      for (const x of bServes) ts.rows[x].slot = c.b.slot.id;
      await saveState(track, ts);
      return done(c.b.map.name);
    }
    const slots = track.effectSlots;
    const between = (x, y) => slots.slice(Math.min(x, y) + 1, Math.max(x, y)).some((s) => !s.isEmpty);
    const ia = slots.indexOf(c.a.slot), ib = slots.indexOf(c.b.slot);
    if (between(ia, ib)) {
      // Other plugins sit between them: put B's plugin, with B's settings, where A was.
      const offB = ts.off[c.b.slot.id];
      await c.b.slot.clear();
      ts.compare = null;
      delete ts.off[c.b.slot.id];
      const slot = await loadInto(track, c.a.slot.id, c.b.map.pluginId);
      const r = await applyTo(session, slot, c.b.map, { ...ts, own: { ...ts.own } }, { mode: 'own', sections: sectionsFor(bServes), values: {} });
      await slot.setIn(true).catch(() => {});
      if (offB) ts.off[slot.id] = offB; else delete ts.off[slot.id];
      for (const x of bServes) ts.rows[x].slot = slot.id;
      await saveState(track, ts);
      return done(c.b.map.name, r.warnings);
    }
    await session.transaction(`Keep ${c.b.map.name}`, async () => {
      await c.b.slot.setIn(true);
      await c.a.slot.clear();
    });
    delete ts.off[c.a.slot.id];
    ts.compare = null;
    for (const x of bServes) ts.rows[x].slot = c.b.slot.id;
    await saveState(track, ts);
    return done(c.b.map.name);
  }

  /**
   * Put a plugin in an empty slot. A mapped plugin for a row that has none gets that row's
   * remembered settings; anything else loads as LUNA would.
   */
  async function add(session, track, slotId, pluginId, opts = {}) {
    const { rows, compare: c } = await view(track);
    const slot = track.effects.byId(slotId);
    if (!slot || !slot.isEmpty) throw new StripError(`${slotId} isn't empty.`);
    const map = mapOf(pluginId);
    const role = opts.role ?? rolesOf(map)[0] ?? 'eq';
    const asRow = !!map || favs(role).includes(pluginId);
    if (asRow && !rows[role] && !c) return swap(session, track, pluginId, { ...opts, role, insert: true, slotId });
    await loadInto(track, slotId, pluginId);
    return { to: stripOf(pluginId).name, added: true };
  }

  /** Empty a slot. A row plugin's settings are remembered first, for the next one added. */
  async function remove(session, track, slotId) {
    const v = await view(track);
    const c = v.compare;
    if (c && (c.a.slot.id === slotId || c.b.slot.id === slotId)) throw new StripError('Finish the comparison first: keep A or B.');
    const slot = track.effects.byId(slotId);
    if (!slot || slot.isEmpty) return { removed: null };
    const name = stripOf(slot.pluginId.value).name;
    const serves = servedBy(v.rows, slot);
    if (serves.length) {
      const ts = v.ts;
      await absorb(slot, stripOf(slot.pluginId.value), ts, serves);
      for (const x of serves) if (ts.rows[x].slot === slotId) ts.rows[x].slot = null;
      delete ts.off[slotId];
      await saveState(track, ts);
    }
    await slot.clear();
    return { removed: name };
  }

  /** Bypass or un-bypass a slot. */
  async function power(session, track, slotId) {
    const slot = track.effects.byId(slotId);
    if (!slot || slot.isEmpty) return;
    await slot.setIn(slot.in.value === false);
  }

  return { add, remove, power, inspect, stepFrom, swap, compare, flip, keep, favs, mapOf, stripOf, tablesOf, readStrip, slotParams, loadInserts, loadState, rolesOf, memoryFor };
}
