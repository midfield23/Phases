// Engine flows (swap, compare, flip, keep) against a small stand-in for LUNA's track and
// insert objects. Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEngine, StripError } from '../lib/engine.mjs';

const load = (f) => JSON.parse(readFileSync(new URL(`../maps/${f}`, import.meta.url)));
const API = load('uaudio_api_vision_channel_strip.json');
const SSL = load('com.SSLN.au.aufx_S4KE.json');
// Two small stand-ins for one-job plugins: an EQ and a compressor.
const EQ = { pluginId: 'test.eq', name: 'Test EQ', domain: 'cs', mode: 'real', controls: {
  eq_in: { param: 'EQ In', states: { off: 'Out', on: 'In' } }, hpf: { param: 'HPF', ends: [10, 1000] },
  lf_gain: { param: 'Low', ends: [-15, 15] }, hf_gain: { param: 'High', ends: [-15, 15] }, out: { param: 'Gain', ends: [-12, 12] } } };
const COMP = { pluginId: 'test.comp', name: 'Test Comp', domain: 'cs', mode: 'real', controls: {
  comp_in: { param: 'Comp In', states: { off: 'Out', on: 'In' } }, comp_thresh: { param: 'Threshold', ends: [-40, 0] },
  comp_ratio: { param: 'Ratio', ends: [1, 20] }, out: { param: 'Makeup', ends: [0, 24] } } };
const maps = { [API.pluginId]: API, [SSL.pluginId]: SSL, [EQ.pluginId]: EQ, [COMP.pluginId]: COMP };
const lin = (lo, hi, n = 11) => Array.from({ length: n }, (_, i) => [i / (n - 1), String(+(lo + (hi - lo) * i / (n - 1)).toFixed(2))]);
const SSL_TABLES = {
  'Input Trim': lin(-20, 20), 'Output Trim': lin(-20, 20), 'HF Gain': lin(-15, 15), 'HMF Gain': lin(-15, 15),
  'LMF Gain': lin(-15, 15), 'LF Gain': lin(-15, 15), 'Compressor Threshold': lin(10, -20), 'Gate Threshold': lin(-30, 10),
  'Gate Range': lin(0, 40), 'Compressor Release': lin(0.1, 4), 'Gate Release': lin(0.1, 4), 'Compressor Mix': lin(0, 100),
  'Compressor Ratio': [...lin(1, 20, 10).map(([n, t]) => [n * 0.9, t]), [1, '']],
  'High Pass Filter': [[0, 'OUT'], ...lin(16, 350, 10).map(([n, t]) => [0.1 + n * 0.9, t])],
  'Low Pass Filter': [[0, 'OUT'], ...lin(22, 3, 10).map(([n, t]) => [0.1 + n * 0.9, t])],
  'HF Frequency': lin(1.5, 16), 'HMF Frequency': lin(0.6, 7), 'LMF Frequency': lin(0.2, 2.5), 'LF Frequency': lin(30, 450),
  'HMF Q': lin(3, 0.5), 'LMF Q': lin(3, 0.5),
  ...Object.fromEntries(['Polarity', 'Dynamics Pre-EQ', 'Filters In', 'EQ In', 'Dynamics In', 'Compressor Fast Attack', 'Gate Expander', 'Gate Fast Attack']
    .map((n) => [n, [[0, 'Out'], [0.45, 'Out'], [0.55, 'In'], [1, 'In']]])),
  'HF Type': [[0, 'Shelf'], [1, 'Bell']], 'LF Type': [[0, 'Shelf'], [1, 'Bell']],
};

// ---------------------------------------------------------------- a tiny LUNA stand-in

const prop = (value) => ({ value, async set(v) { this.value = v; } });
const RANGES = { 'Line Gain': [0, 12], '215 HP Filter': [12, 596], '225 Thresh': [13, -18] };   // [at n0, at n1]: the API threshold runs downwards
const STEPS = {
  '550 HF Freq': [20000, 15000, 12500, 10000, 7000, 5000, 2500], '550 HMF Freq': [12500, 10000, 8000, 5000, 3000, 1500, 800],
  '550 LMF Freq': [1000, 700, 500, 240, 180, 150, 75], '550 LF Freq': [400, 300, 200, 100, 50, 40, 30],
  ...Object.fromEntries(['550 HF Gain', '550 HMF Gain', '550 LMF Gain', '550 LF Gain'].map((n) => [n, [-12, -9, -6, -4, -2, 0, 2, 4, 6, 9, 12]])),
};
function makeParam(name, spec) {
  const p = { name: prop(name), discrete: prop(!!spec.labels || !!spec.steps), normalized: prop(spec.norm ?? 0.5), real: prop(spec.real ?? 0), display: prop(spec.display ?? '') };
  if (spec.labels || spec.steps) {
    const labels = spec.labels ?? spec.steps.map(String);
    p.displayValues = prop(labels); p.realValues = prop(spec.steps ?? labels.map((_, i) => i));
    const sync = () => { const i = Math.round(unwrap(p.normalized.value) * (labels.length - 1)); p.display.value = labels[i]; p.real.value = p.realValues.value[i]; };
    p.normalized.set = async (v) => { p.normalized.value = v; sync(); };
    sync();
  } else {
    p.displayValues = prop(undefined); p.realValues = prop(undefined);
    const r = spec.range, lo = r && Math.min(...r), hi = r && Math.max(...r);
    if (r) p.normalized.value = Math.min(1, Math.max(0, (p.real.value - r[0]) / (r[1] - r[0])));
    p.normalized.set = async (v) => {   // kept as sent, as the SDK does
      p.normalized.value = v;
      if (r) p.real.value = r[0] + unwrap(v) * (r[1] - r[0]);
    };
    p.real.set = async (v) => {
      const x = unwrap(v);
      if (r && (x < lo || x > hi)) throw Object.assign(new Error('out of range'), { code: 'uasrv.invalid_value' });
      p.real.value = v;
      if (r) p.normalized.value = (x - r[0]) / (r[1] - r[0]);
    };
  }
  return p;
}
function paramsFor(pluginId) {
  if (pluginId === API.pluginId) {
    const out = [makeParam('EQ Type', { labels: ['550L', '560L'], norm: 0 })];
    for (const def of Object.values(API.controls)) {
      if (out.some((p) => p.name.value === def.param)) continue;
      if (def.states) out.push(makeParam(def.param, { labels: [...new Set(Object.values(def.states))], norm: 0 }));
      else if (STEPS[def.param]) out.push(makeParam(def.param, { steps: STEPS[def.param], norm: 0.5 }));
      else out.push(makeParam(def.param, { real: def.param === 'Line Gain' ? 0 : 0, norm: 0.5, range: RANGES[def.param] }));
    }
    return out;
  }
  if (pluginId === SSL.pluginId) return Object.keys(SSL_TABLES).map((n) => makeParam(n, { norm: 0.5 }));
  const m = maps[pluginId];
  if (m) {
    const extra = pluginId === COMP.pluginId ? [makeParam('Knee', { real: 0.5, range: [0, 1] })] : [];   // not in its map
    return extra.concat(Object.values(m.controls).map((def) => (def.states
      ? makeParam(def.param, { labels: Object.values(def.states), norm: 1 })
      : makeParam(def.param, { real: (def.ends[0] + def.ends[1]) / 2, range: def.ends }))));
  }
  return [makeParam('Mix', {})];
}
function makeSlot(id) {
  const s = {
    id, isEffectSlot: true, pluginId: prop(null), pluginName: prop(null), pluginError: prop(null), in: prop(true), editorOpen: prop(false),
    params: [], controls: { load: async () => {} },
    get isEmpty() { return !this.pluginId.value; },
    async setPlugin(pid) { this.pluginId.value = pid; this.params = paramsFor(pid); this.in.value = true; },
    async setIn(v) { this.in.value = v; },
    async clear() { this.pluginId.value = null; this.params = []; },
    async openEditor() { this.editorOpen.value = true; },
  };
  return s;
}
function makeTrack(name = 'Vox') {
  const slots = Array.from({ length: 8 }, (_, i) => makeSlot(`effect_${i}`));
  return {
    id: 'tr1', uid: prop('tr1'), name: prop(name),
    effects: { load: async () => {}, reload: async () => {}, byId: (id) => slots.find((s) => s.id === id), items: slots },
    get effectSlots() { return slots; },
  };
}
const session = { transaction: async (_l, fn) => fn() };
// Like the SDK's Luna.float: a wrapper the SDK keeps as the control's value until LUNA reports back.
class FloatLiteral { constructor(v) { this.value = v; } toJSON() { return this.value; } }
const Luna = { float: (n) => new FloatLiteral(n) };
const unwrap = (v) => (v instanceof FloatLiteral ? v.value : v);
const mem = {};
const store = { load: async (k) => (mem[k] ? structuredClone(mem[k]) : undefined), save: async (k, s) => { mem[k] = structuredClone(s); } };
const fresh = () => { for (const k of Object.keys(mem)) delete mem[k]; };
const engine = () => createEngine({ Luna, maps, tables: { [SSL.pluginId]: SSL_TABLES }, favorites: { cs: [API.pluginId, SSL.pluginId] }, store });
const P = (slot, name) => slot.params.find((p) => p.name.value === name);
const close = (a, b, tol = 0.02) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

async function apiTrack() {
  const track = makeTrack();
  const s0 = track.effectSlots[0];
  await s0.setPlugin(API.pluginId);
  P(s0, '215 HP Filter').real.value = 100;
  P(s0, '225 Thresh').real.value = -10;
  P(s0, '225 Ratio').real.value = 4;
  P(s0, '235 Thresh').real.value = -44;
  P(s0, '235 Depth').real.value = 80;
  await P(s0, '225 On').normalized.set(1);   // compressor on
  await P(s0, '235 On').normalized.set(0);   // gate off
  await P(s0, '550 LF Gain').normalized.set(0.7);   // +4 dB
  return track;
}

// ---------------------------------------------------------------- tests

test('swap API -> SSL -> API carries values and keeps what the SSL could not hold', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  const r = await e.swap(session, track, SSL.pluginId);
  const s0 = track.effectSlots[0];
  assert.equal(s0.pluginId.value, SSL.pluginId);
  assert.equal(r.from, 'API Vision');
  close(P(s0, 'Compressor Threshold').normalized.value, 2 / 3);   // -10 dB on a +10..-20 knob
  assert.equal(P(s0, 'Dynamics In').normalized.value, 0.55);      // in the "In" run
  assert.equal(P(s0, 'Gate Range').normalized.value, 0);          // gate off -> neutralised
  close(P(s0, 'LF Gain').normalized.value, (4 + 15) / 30);

  const back = await e.swap(session, track, API.pluginId);
  assert.equal(back.from, 'SSL 4K E');
  assert.equal(s0.pluginId.value, API.pluginId);
  close(P(s0, '225 Thresh').real.value, -10, 0.1);
  close(P(s0, '215 HP Filter').real.value, 100, 1);
  assert.equal(P(s0, '235 Thresh').real.value, -44);              // held through the SSL
  assert.equal(P(s0, '235 Depth').real.value, 80);
  assert.equal(P(s0, '235 On').display.value, 'Off');
  assert.equal(P(s0, '225 On').display.value, 'On');
  assert.equal(P(s0, '550 LF Gain').display.value, '4');
});

test('stepFrom cycles the favourites', () => {
  const e = engine();
  assert.equal(e.stepFrom(API.pluginId, 1), SSL.pluginId);
  assert.equal(e.stepFrom(SSL.pluginId, 1), API.pluginId);
  assert.equal(e.stepFrom(null, 1), API.pluginId);
});

test('no strip: refuses unless inserting', async () => {
  fresh();
  const e = engine(), track = makeTrack();
  await assert.rejects(e.swap(session, track, API.pluginId), StripError);
  await e.swap(session, track, API.pluginId, { insert: true });
  assert.equal(track.effectSlots[0].pluginId.value, API.pluginId);
});

test('compare: B next to A, flip, keep B', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  const [s0, s1] = track.effectSlots;
  await e.compare(session, track, SSL.pluginId);
  assert.equal(s1.pluginId.value, SSL.pluginId);
  assert.equal(s0.in.value, false);
  assert.equal(s1.in.value, true);
  close(P(s1, 'Compressor Threshold').normalized.value, 2 / 3);
  let v = await e.inspect(track);
  assert.equal(v.compare.active, 'b');
  await assert.rejects(e.swap(session, track, API.pluginId), /Finish the comparison/);

  await e.flip(session, track);
  assert.equal(s0.in.value, true);
  assert.equal(s1.in.value, false);
  await e.flip(session, track);

  await e.keep(session, track, 'b');
  assert.equal(s0.pluginId.value, null);
  assert.equal(s1.pluginId.value, SSL.pluginId);
  assert.equal(s1.in.value, true);
  v = await e.inspect(track);
  assert.equal(v.compare, null);
  assert.equal(v.active.map.pluginId, SSL.pluginId);
});

test('compare: keep A removes the candidate', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  await e.compare(session, track, SSL.pluginId);
  await e.keep(session, track, 'a');
  const [s0, s1] = track.effectSlots;
  assert.equal(s0.pluginId.value, API.pluginId);
  assert.equal(s0.in.value, true);
  assert.equal(s1.pluginId.value, null);
});

test('compare: keeping B past other plugins puts it where A was', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  await track.effectSlots[1].setPlugin('some.other.plugin');
  await e.compare(session, track, SSL.pluginId);
  const [s0, s1, s2] = track.effectSlots;
  assert.equal(s2.pluginId.value, SSL.pluginId);                  // B went to the next free slot
  await P(s2, 'LF Gain').normalized.set(0.9);                      // tweak B while comparing
  await e.keep(session, track, 'b');
  assert.equal(s0.pluginId.value, SSL.pluginId);                   // B now sits where A was
  assert.equal(P(s0, 'LF Gain').normalized.value, 0.9);            // with B's settings
  assert.equal(s1.pluginId.value, 'some.other.plugin');
  assert.equal(s2.pluginId.value, null);
});

test('a value outside the target knob\'s range is left at default and remembered; the rest still carries', async () => {
  fresh();
  const e = engine(), track = makeTrack();
  const s0 = track.effectSlots[0];
  await s0.setPlugin(SSL.pluginId);
  await P(s0, 'Input Trim').normalized.set(0.4);          // -4 dB: below the API's 0..12 line gain
  await P(s0, 'High Pass Filter').normalized.set(0.1);    // 16 Hz... fine
  await P(s0, 'Compressor Threshold').normalized.set(0.5);
  await P(s0, 'Dynamics In').normalized.set(1);
  const r = await e.swap(session, track, API.pluginId);
  assert.ok(r.skipped.includes('in_trim'));
  assert.equal(P(s0, 'Line Gain').real.value, 0);          // default, not an error
  close(P(s0, '225 Thresh').real.value, -5, 0.1);          // everything else carried
  // back to the SSL: the -4 dB trim comes back
  await e.swap(session, track, SSL.pluginId);
  close(P(s0, 'Input Trim').normalized.value, 0.4);
});

test('an out-of-range filter goes to the end of its range instead', async () => {
  fresh();
  const e = engine(), track = makeTrack();
  const s0 = track.effectSlots[0];
  await s0.setPlugin(SSL.pluginId);
  await P(s0, 'High Pass Filter').normalized.set(1);      // 350 Hz: inside the API's range
  await P(s0, 'Filters In').normalized.set(1);
  await e.swap(session, track, API.pluginId);
  close(P(s0, '215 HP Filter').real.value, 350, 1);
  P(s0, '215 HP Filter').real.value = 596;                 // API at its top end
  await e.swap(session, track, SSL.pluginId);              // SSL table tops out at 350
  close(P(s0, 'High Pass Filter').normalized.value, 1, 0.01);
});

test('add into a chosen slot carries remembered settings; remove remembers them first', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  const [s0, , s2] = track.effectSlots;
  await e.remove(session, track, 'effect_0');                       // strip removed: settings remembered
  assert.equal(s0.pluginId.value, null);
  await e.add(session, track, 'effect_2', SSL.pluginId);           // a strip into an empty track: carried
  assert.equal(s2.pluginId.value, SSL.pluginId);
  close(P(s2, 'Compressor Threshold').normalized.value, 2 / 3);
  await e.add(session, track, 'effect_0', 'some.other.plugin');     // not a strip: plain load
  assert.equal(s0.pluginId.value, 'some.other.plugin');
  await assert.rejects(e.add(session, track, 'effect_0', SSL.pluginId), /isn't empty/);
  await e.power(session, track, 'effect_2');
  assert.equal(s2.in.value, false);
  await e.power(session, track, 'effect_2');
  assert.equal(s2.in.value, true);
});

test('remove refuses a slot that is part of a comparison', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  await e.compare(session, track, SSL.pluginId);
  await assert.rejects(e.remove(session, track, 'effect_1'), /Finish the comparison/);
});

test('a favourite without a map switches like any strip, and the next swap replaces it in place', async () => {
  fresh();
  const e = createEngine({ Luna, maps, tables: { [SSL.pluginId]: SSL_TABLES }, favorites: { cs: [API.pluginId, 'plain.eq', SSL.pluginId] }, store, nameOf: (id) => (id === 'plain.eq' ? 'Plain EQ' : null) });
  const track = await apiTrack();
  const [s0, s1] = track.effectSlots;
  const r = await e.swap(session, track, 'plain.eq');
  assert.equal(s0.pluginId.value, 'plain.eq');
  assert.ok(r.warnings.some((w) => /no map/.test(w)));
  let v = await e.inspect(track);
  assert.equal(v.active.slot.id, 'effect_0');                       // remembered as the strip insert
  assert.equal(v.active.map.name, 'Plain EQ');
  await e.swap(session, track, SSL.pluginId);                         // replaces it in place
  assert.equal(s0.pluginId.value, SSL.pluginId);
  assert.equal(s1.pluginId.value, null);
  close(P(s0, 'Compressor Threshold').normalized.value, 2 / 3);      // API's settings survived the plain EQ
  assert.equal(e.stepFrom(SSL.pluginId, -1), 'plain.eq');
});

test('values the SDK still holds as sent (wrapped) read as numbers: the output level survives SSL -> API', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  const s0 = track.effectSlots[0];
  P(s0, 'Level').real.value = -3;
  await e.swap(session, track, SSL.pluginId);
  // A continuous write goes as a plain number, so the SDK keeps a number...
  assert.equal(typeof P(s0, 'Output Trim').normalized.value, 'number');
  // ...but a value can still sit wrapped (control type not known yet): it must not read as the bottom of the range.
  for (const p of s0.params) p.normalized.value = Luna.float(p.normalized.value);
  await e.swap(session, track, API.pluginId);
  close(unwrap(P(s0, 'Level').real.value), -3, 0.25);
  close(unwrap(P(s0, '225 Thresh').real.value), -10, 0.1);
});

test('a value just past the end of a knob goes to that end and is remembered exactly', async () => {
  fresh();
  const e = engine(), track = makeTrack();
  const s0 = track.effectSlots[0];
  await s0.setPlugin(SSL.pluginId);
  await P(s0, 'Compressor Threshold').normalized.set(1);   // -20 dB; the API stops at -18
  await P(s0, 'Dynamics In').normalized.set(1);
  const r = await e.swap(session, track, API.pluginId);
  assert.deepEqual(r.nearest, ['comp_thresh']);
  assert.ok(!r.skipped.includes('comp_thresh'));
  close(unwrap(P(s0, '225 Thresh').real.value), -18, 0.01);
  await e.swap(session, track, SSL.pluginId);
  close(P(s0, 'Compressor Threshold').normalized.value, 1);  // back to exactly -20
});

test('with the knob ends recorded in the map, a value just past an end goes there without searching', async () => {
  fresh();
  const withEnds = structuredClone(API);
  withEnds.controls.comp_thresh.ends = [13, -18];   // as measured on the API Vision
  withEnds.controls.in_trim.ends = [0, 12];
  const e = createEngine({ Luna, maps: { ...maps, [API.pluginId]: withEnds }, tables: { [SSL.pluginId]: SSL_TABLES }, favorites: { cs: [API.pluginId, SSL.pluginId] }, store });
  const track = makeTrack();
  const s0 = track.effectSlots[0];
  await s0.setPlugin(SSL.pluginId);
  await P(s0, 'Compressor Threshold').normalized.set(1);   // -20 dB
  await P(s0, 'Dynamics In').normalized.set(1);
  await P(s0, 'Input Trim').normalized.set(0.4);           // -4 dB: too far below 0..12
  let transactions = 0;
  const counting = { transaction: async (l, fn) => { transactions++; return fn(); } };
  const r = await e.swap(counting, track, API.pluginId);
  assert.deepEqual(r.nearest, ['comp_thresh']);
  assert.ok(r.skipped.includes('in_trim'));
  close(unwrap(P(s0, '225 Thresh').real.value), -18, 0.01);
  assert.equal(transactions, 1);                           // just the values: no searching for ends
  await e.swap(session, track, SSL.pluginId);
  close(P(s0, 'Compressor Threshold').normalized.value, 1);
  close(P(s0, 'Input Trim').normalized.value, 0.4);
});

// ---------------------------------------------------------------- two rows: EQ and Compressor

test('rows: a strip serves both rows; an EQ in the EQ row leaves the compressor settings for the Compressor row', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  const [s0] = track.effectSlots;
  let v = await e.inspect(track);
  assert.equal(v.rows.eq.slot.id, 'effect_0');
  assert.equal(v.rows.dyn.slot.id, 'effect_0');                    // one strip, both rows
  const r = await e.swap(session, track, EQ.pluginId, { role: 'eq' });
  assert.equal(s0.pluginId.value, EQ.pluginId);                      // replaced in place
  assert.ok(r.warnings.some((w) => /compressor settings are kept for the Compressor row/.test(w)));
  close(P(s0, 'HPF').real.value, 100, 1);                            // the EQ row's settings carried
  close(P(s0, 'Low').real.value, 4, 0.01);
  v = await e.inspect(track);
  assert.equal(v.rows.dyn, null);                                    // no compressor now
  // A compressor in the Compressor row goes after the EQ and gets the API's compressor
  await e.swap(session, track, COMP.pluginId, { role: 'dyn', insert: true });
  const s1 = track.effectSlots[1];
  assert.equal(s1.pluginId.value, COMP.pluginId);
  close(P(s1, 'Threshold').real.value, -10, 0.01);
  close(P(s1, 'Ratio').real.value, 4, 0.01);
  v = await e.inspect(track);
  assert.equal(v.rows.eq.slot.id, 'effect_0');
  assert.equal(v.rows.dyn.slot.id, 'effect_1');
});

test('rows: each row keeps its own output level', async () => {
  fresh();
  const e = engine(), track = makeTrack();
  await e.swap(session, track, EQ.pluginId, { role: 'eq', insert: true });
  await e.swap(session, track, COMP.pluginId, { role: 'dyn', insert: true });
  const [s0, s1] = track.effectSlots;
  P(s0, 'Gain').real.value = -3;
  P(s1, 'Makeup').real.value = 6;
  await e.swap(session, track, SSL.pluginId, { role: 'dyn' });       // strip in the Compressor row
  close(P(s1, 'Output Trim').normalized.value, (6 + 20) / 40);      // the compressor's makeup, not the EQ's gain
  assert.equal(P(s1, 'EQ In').normalized.value, 0);                 // its EQ is off: the EQ row has its own
  assert.equal(P(s1, 'Filters In').normalized.value, 0);
  assert.equal(P(s1, 'Dynamics In').normalized.value, 0.55);
});

test('rows: a strip in the Compressor row with its EQ off is not taken for the EQ row', async () => {
  fresh();
  const e = engine(), track = makeTrack();
  await e.swap(session, track, EQ.pluginId, { role: 'eq', insert: true });
  await e.swap(session, track, SSL.pluginId, { role: 'dyn', insert: true });
  await e.remove(session, track, 'effect_0');                         // EQ gone
  const v = await e.inspect(track);
  assert.equal(v.rows.eq, null);                                     // the strip's EQ is still off
  assert.equal(v.rows.dyn.map.name, SSL.name);
});

test('rows: comparing EQs on a strip switches only the strip\'s EQ, so its compressor stays in', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  const [s0, s1] = track.effectSlots;
  await P(s0, 'EQ On').normalized.set(1);
  await P(s0, '215 On').normalized.set(1);
  await e.compare(session, track, EQ.pluginId, { role: 'eq' });
  assert.equal(s1.pluginId.value, EQ.pluginId);
  assert.equal(s0.in.value, true);                                    // the API stays in...
  assert.equal(P(s0, 'EQ On').display.value, 'Off');                  // ...with its EQ and filter off
  assert.equal(P(s0, '215 On').display.value, 'Off');
  assert.equal(P(s0, '225 On').display.value, 'On');                  // compressor still on
  let v = await e.inspect(track);
  assert.equal(v.compare.active, 'b');
  await e.flip(session, track);                                       // hear A: the API's EQ back, B out
  assert.equal(s1.in.value, false);
  assert.equal(P(s0, 'EQ On').display.value, 'On');
  assert.equal(P(s0, '215 On').display.value, 'On');
  await e.flip(session, track);
  await e.keep(session, track, 'b');
  v = await e.inspect(track);
  assert.equal(v.compare, null);
  assert.equal(v.rows.eq.slot.id, 'effect_1');                        // the Test EQ is the EQ row
  assert.equal(v.rows.dyn.slot.id, 'effect_0');                       // the API is the Compressor row
  assert.equal(P(s0, 'EQ On').display.value, 'Off');
});

test('rows: keeping A after an EQ comparison puts the strip\'s EQ back', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  const [s0, s1] = track.effectSlots;
  await P(s0, 'EQ On').normalized.set(1);
  await P(s0, '215 On').normalized.set(1);
  await e.compare(session, track, EQ.pluginId, { role: 'eq' });
  await e.keep(session, track, 'a');
  assert.equal(s1.pluginId.value, null);
  assert.equal(P(s0, 'EQ On').display.value, 'On');
  const v = await e.inspect(track);
  assert.equal(v.rows.eq.slot.id, 'effect_0');
  assert.equal(v.rows.dyn.slot.id, 'effect_0');
});

test('rows: state saved by the one-strip version still reads', async () => {
  fresh();
  const e = engine(), track = await apiTrack();
  mem.tr1 = { remembered: { hpf: 120, comp_thresh: -8, out: -2 }, held: ['comp_mix'], heldAt: {}, own: {}, compare: null, stripSlot: 'effect_0' };
  const ts = await e.loadState(track);
  assert.deepEqual(ts.rows.eq.remembered, { hpf: 120, out: -2 });
  assert.deepEqual(ts.rows.dyn.remembered, { comp_thresh: -8, out: -2 });
  assert.deepEqual(ts.rows.dyn.held, ['comp_mix']);
  const v = await e.inspect(track);
  assert.equal(v.rows.eq.slot.id, 'effect_0');
});

test('rows: each row steps through its own favourites', async () => {
  const e = createEngine({ Luna, maps, favorites: { eq: [EQ.pluginId, SSL.pluginId], dyn: [COMP.pluginId, API.pluginId] }, store });
  assert.equal(e.stepFrom(EQ.pluginId, 1, 'eq'), SSL.pluginId);
  assert.equal(e.stepFrom(COMP.pluginId, 1, 'dyn'), API.pluginId);
  assert.deepEqual(e.rolesOf(EQ), ['eq']);
  assert.deepEqual(e.rolesOf(SSL), ['eq', 'dyn']);
});

test('a control the map doesn\'t carry comes back as it was left on that plugin', async () => {
  fresh();
  const e = engine(), track = makeTrack();
  await e.swap(session, track, COMP.pluginId, { role: 'dyn', insert: true });
  const s0 = track.effectSlots[0];
  await P(s0, 'Knee').normalized.set(0.8);
  await e.swap(session, track, SSL.pluginId, { role: 'dyn' });
  await e.swap(session, track, COMP.pluginId, { role: 'dyn' });
  close(P(s0, 'Knee').normalized.value, 0.8, 1e-9);
});
