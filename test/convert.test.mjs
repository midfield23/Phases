// Offline tests for lib/convert.mjs, using numbers from the 2026-11-22 probes.
// Run: node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseDisplay, tablePoints, valueAt, normFor, readControl, planControl, readStrip, planStrip, mergeRemembered,
} from '../lib/convert.mjs';

const load = (f) => JSON.parse(readFileSync(new URL(`../maps/${f}`, import.meta.url)));
const API = load('uaudio_api_vision_channel_strip.json');
const SSL = load('com.SSLN.au.aufx_S4KE.json');

const prop = (value) => ({ value });
const param = (o) => ({
  name: prop(o.name), discrete: prop(!!o.steps), real: prop(o.real), normalized: prop(o.norm),
  display: prop(o.display), displayValues: prop(o.labels), realValues: prop(o.steps),
});
const close = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b}`);

// The 4K E sweep, as build-table would store it (five points here; the tool takes ~100).
const SSL_TABLES = {
  'LF Gain': [[0, '-15.0'], [0.25, '-7.5'], [0.5, '0.0'], [0.75, '7.5'], [1, '15.0']],
  'LF Frequency': [[0, '30.0'], [0.25, '66.7'], [0.5, '200.0'], [0.75, '366.7'], [1, '450.0']],
  'High Pass Filter': [[0, 'OUT'], [0.25, '36.7'], [0.5, '120.0'], [0.75, '266.7'], [1, '350.0']],
  'Low Pass Filter': [[0, 'OUT'], [0.25, '10.67'], [0.5, '5.00'], [0.75, '3.67'], [1, '3.00']],
  'HMF Frequency': [[0, '0.60'], [0.25, '1.03'], [0.5, '3.00'], [0.75, '5.50'], [1, '7.00']],
  'Compressor Ratio': [[0, '1.0'], [0.25, '2.3'], [0.5, '5.0'], [0.75, '16.0'], [1, '']],
  'Compressor Threshold': [[0, '10.0'], [0.25, '3.3'], [0.5, '-5.0'], [0.75, '-13.3'], [1, '-20.0']],
  'EQ In': [[0, 'Out'], [0.1, 'Out'], [0.5, 'In'], [0.9, 'In'], [1, 'In']],
  'Dynamics In': [[0, 'Out'], [1, 'In']],
};

test('parseDisplay handles units the plugins print', () => {
  assert.equal(parseDisplay('88.8 Hz'), 88.8);
  assert.equal(parseDisplay('40.8 k'), 40800);
  assert.equal(parseDisplay('7 kHz'), 7000);
  assert.equal(parseDisplay('50 ms'), 0.05);
  assert.equal(parseDisplay('-4.2 dB'), -4.2);
  assert.equal(parseDisplay('-oo dB'), -Infinity);
  assert.equal(parseDisplay('OUT'), null);
});

test('table: interpolate, reverse direction, kHz scale, off and blank', () => {
  const lf = tablePoints(SSL.controls.lf_gain, SSL_TABLES['LF Gain']);
  close(valueAt(lf, 0.66), 4.8, 0.05);                 // check-writes showed "4.8" at 0.66
  close(normFor(lf, 3), 0.6);

  const thr = tablePoints(SSL.controls.comp_thresh, SSL_TABLES['Compressor Threshold']);
  close(normFor(thr, -10), 0.6506, 0.005);             // reversed knob

  const hmf = tablePoints(SSL.controls.hmf_freq, SSL_TABLES['HMF Frequency']);
  assert.equal(valueAt(hmf, 0.5), 3000);               // "3.00" kHz -> 3000 Hz

  const hpf = tablePoints(SSL.controls.hpf, SSL_TABLES['High Pass Filter']);
  assert.equal(valueAt(hpf, 0), 'off');

  const ratio = tablePoints(SSL.controls.comp_ratio, SSL_TABLES['Compressor Ratio']);
  assert.equal(valueAt(ratio, 1), Infinity);
  assert.equal(normFor(ratio, Infinity), 1);
  assert.equal(normFor(ratio, 40), null);              // past 16:1 but not "infinite": not representable
});

test('API Vision (real mode): read', () => {
  const hp = param({ name: '215 HP Filter', real: 88.8308, norm: 0.53, display: '88.8 Hz' });
  close(readControl(API, 'hpf', hp), 88.83);
  const mic = param({ name: 'Line Gain', real: 79.41, norm: 1, display: '65.0 dB' });
  assert.equal(readControl(API, 'in_trim', mic), 65);  // display wins when real disagrees
  const ratio = param({ name: '225 Ratio', real: 50, norm: 1, display: 'Limit' });
  assert.equal(readControl(API, 'comp_ratio', ratio), Infinity);
  const flt = param({ name: '550 HF Filter', real: 1, norm: 1, display: 'Peak', labels: ['Shelf', 'Peak'], steps: [0, 1] });
  assert.equal(readControl(API, 'hf_type', flt), 'bell');
});

test('API Vision (real mode): stepped bands snap to the nearest step', () => {
  const hf = param({
    name: '550 HF Freq', real: 7000, norm: 0.6667, display: '7 kHz',
    labels: ['20 kHz', '15 kHz', '12.5 kHz', '10 kHz', '7 kHz', '5 kHz', '2.5 kHz'],
    steps: [20000, 15000, 12500, 10000, 7000, 5000, 2500],
  });
  close(planControl(API, 'hf_freq', hf, null, 8000).normalized, 4 / 6);   // 8 kHz -> 7 kHz (log-nearest)
  close(planControl(API, 'hf_freq', hf, null, 9000).normalized, 3 / 6);   // 9 kHz -> 10 kHz
  assert.equal(planControl(API, 'hf_freq', hf, null, 800), null);         // far below the band: leave it
  const g = param({ name: '550 HF Gain', real: 6, norm: 0.8, display: '6 dB',
    steps: [-12, -9, -6, -4, -2, 0, 2, 4, 6, 9, 12], labels: [] });
  close(planControl(API, 'hf_gain', g, null, 4.8).normalized, 0.7);        // 4.8 dB -> 4 dB (step 7 of 0..10)
  close(planControl(API, 'hf_gain', g, null, 5.2).normalized, 0.8);        // 5.2 dB -> 6 dB
  assert.equal(planControl(API, 'hf_gain', g, null, 15), null);             // +15 dB: past the last step by more than 1 dB
});

test('SSL -> API whole strip', () => {
  const sslParams = new Map([
    ['LF Gain', param({ name: 'LF Gain', norm: 0.66 })],
    ['High Pass Filter', param({ name: 'High Pass Filter', norm: 0 })],
    ['Compressor Threshold', param({ name: 'Compressor Threshold', norm: 0.828 })],
    ['Dynamics In', param({ name: 'Dynamics In', norm: 1 })],
    ['EQ In', param({ name: 'EQ In', norm: 1 })],
  ]);
  const values = readStrip(SSL, sslParams, SSL_TABLES);
  close(values.lf_gain, 4.8, 0.05);
  assert.equal(values.hpf, 'off');
  close(values.comp_thresh, -15.4, 0.6);             // check-writes showed "-15.7" (5-point table)
  assert.equal(values.comp_in, 'on');
  assert.equal(values.gate_in, 'on');

  const apiParams = new Map([
    ['EQ Type', param({ name: 'EQ Type', display: '550L' })],
    ['550 LF Gain', param({ name: '550 LF Gain', steps: [-12, -9, -6, -4, -2, 0, 2, 4, 6, 9, 12], labels: [] })],
    ['215 HP Filter', param({ name: '215 HP Filter', norm: 0.5 })],
    ['225 Thresh', param({ name: '225 Thresh' })],
    ['225 On', param({ name: '225 On', labels: ['Off', 'On'], steps: [0, 1] })],
    ['235 On', param({ name: '235 On', labels: ['Off', 'On'], steps: [0, 1] })],
    ['EQ On', param({ name: 'EQ On', labels: ['Off', 'On'], steps: [0, 1] })],
  ]);
  const { writes } = planStrip(API, apiParams, {}, values);
  const w = Object.fromEntries(writes.map((x) => [x.param, x]));
  close(w['550 LF Gain'].normalized, 0.7);           // 4.8 dB -> 4 dB step
  assert.equal(w['215 HP Filter'].normalized, 0);     // SSL HPF out -> API HPF fully open
  close(w['225 Thresh'].real, values.comp_thresh);
  assert.equal(w['225 On'].normalized, 1);
  assert.equal(w['235 On'].normalized, 1);
});

test('API -> SSL whole strip, shared Dynamics In, EQ gated by EQ Type', () => {
  const values = { comp_in: 'off', gate_in: 'on', lf_gain: 3, hpf: 12, comp_ratio: Infinity, eq_in: 'on' };
  const sslParams = new Map(Object.keys(SSL_TABLES).map((n) => [n, param({ name: n, norm: 0.5 })]));
  const { writes } = planStrip(SSL, sslParams, SSL_TABLES, values);
  const w = Object.fromEntries(writes.map((x) => [x.param, x]));
  assert.equal(w['Dynamics In'].normalized, 1);       // gate on -> shared switch on
  close(w['LF Gain'].normalized, 0.6);
  assert.equal(w['High Pass Filter'].normalized, 0);   // 12 Hz is below the SSL's range -> OUT
  assert.equal(w['Compressor Ratio'].normalized, 0);   // compressor off, gate on: ratio 1:1
  const lim = planStrip(SSL, sslParams, SSL_TABLES, { comp_in: 'on', comp_ratio: Infinity }).writes
    .find((x) => x.param === 'Compressor Ratio');
  assert.equal(lim.normalized, 1);                     // limit -> infinity position
  close(w['EQ In'].normalized, 0.9);                   // middle of the "In" run

  // API in 560 mode: EQ values are not read
  const api = new Map([
    ['EQ Type', param({ name: 'EQ Type', display: '560L' })],
    ['550 LF Gain', param({ name: '550 LF Gain', real: 6, display: '6 dB' })],
  ]);
  assert.equal(readStrip(API, api, {}).lf_gain, undefined);
});

test('shared Dynamics In: an off section is neutralised, and reads back as off', () => {
  const tables = {
    ...SSL_TABLES,
    'Gate Range': [[0, '0.0'], [0.5, '20.0'], [1, '40.0']],
  };
  // API: compressor on, gate off -> SSL gate range 0, Dynamics In on
  const values = { comp_in: 'on', gate_in: 'off', gate_range: 80, comp_ratio: 4 };
  const sslParams = new Map(Object.keys(tables).map((n) => [n, param({ name: n, norm: 0.5 })]));
  const { writes } = planStrip(SSL, sslParams, tables, values);
  const w = Object.fromEntries(writes.map((x) => [x.param, x]));
  assert.equal(w['Dynamics In'].normalized, 1);
  assert.equal(w['Gate Range'].normalized, 0);

  // Reading that SSL back: gate counts as off, compressor as on
  const back = new Map([
    ['Dynamics In', param({ name: 'Dynamics In', norm: 1 })],
    ['Gate Range', param({ name: 'Gate Range', norm: 0 })],
    ['Compressor Ratio', param({ name: 'Compressor Ratio', norm: 0.5 })],
  ]);
  const read = readStrip(SSL, back, tables);
  assert.equal(read.gate_in, 'off');
  assert.equal(read.comp_in, 'on');
});

test('held values survive a round trip unless the user moved them', () => {
  const remembered = { gate_thresh: -44, gate_range: 80, hf_gain: 4 };
  const held = ['gate_thresh', 'gate_range'];
  const heldAt = { gate_thresh: -30, gate_range: 0 };          // what the SSL showed after the swap
  // untouched on the SSL: keep the API's real values
  const a = mergeRemembered(remembered, { gate_thresh: -30, gate_range: 0, hf_gain: 5 }, held, heldAt);
  assert.equal(a.gate_thresh, -44);
  assert.equal(a.gate_range, 80);
  assert.equal(a.hf_gain, 5);                                    // normal values follow the strip
  // the user moved the SSL gate threshold: that wins
  const b = mergeRemembered(remembered, { gate_thresh: -20, gate_range: 0 }, held, heldAt);
  assert.equal(b.gate_thresh, -20);
  assert.equal(b.gate_range, 80);
});

test('planStrip reports values that did not reach the strip', () => {
  const tables = { ...SSL_TABLES, 'Gate Range': [[0, '0.0'], [1, '40.0']], 'Gate Threshold': [[0, '-30.0'], [1, '10.0']] };
  const sslParams = new Map(Object.keys(tables).map((n) => [n, param({ name: n, norm: 0.5 })]));
  const { held } = planStrip(SSL, sslParams, tables, { comp_in: 'on', gate_in: 'off', gate_thresh: -44, gate_range: 80 });
  assert.ok(held.includes('gate_thresh'));   // -44 is below the SSL's range
  assert.ok(held.includes('gate_range'));    // neutralised to 0
});

test('SSL 4K G range switches: the band is read where it really is, and the switch is used only when needed', () => {
  const G = load('com.SSLN.au.aufx_S4KG.json');
  const sw = [[0, 'Off'], [0.45, 'Off'], [0.55, 'On'], [1, 'On']];
  const tables = {
    'HMF Frequency': SSL_TABLES['HMF Frequency'], 'HMF x3': sw,
    'LMF Frequency': [[0, '0.20'], [0.5, '1.00'], [1, '2.50']], 'LMF div3': sw,
  };
  const ps = (o) => new Map(Object.entries(o).map(([name, norm]) => [name, param({ name, norm })]));
  // HMF knob at 3 kHz with x3 on: 9 kHz. LMF at 1 kHz with /3 on: 333 Hz.
  const read = readStrip(G, ps({ 'HMF Frequency': 0.5, 'HMF x3': 1, 'LMF Frequency': 0.5, 'LMF div3': 1 }), tables);
  close(read.hmf_freq, 9000, 1);
  close(read.lmf_freq, 333.3, 0.5);
  const read2 = readStrip(G, ps({ 'HMF Frequency': 0.5, 'HMF x3': 0, 'LMF Frequency': 0.5, 'LMF div3': 0 }), tables);
  close(read2.hmf_freq, 3000, 1);

  const target = ps({ 'HMF Frequency': 0, 'HMF x3': 0, 'LMF Frequency': 0, 'LMF div3': 0 });
  const plan = (values) => planStrip(G, target, tables, values, ['eq']).writes;
  const w = (writes, name) => writes.find((x) => x.param === name);
  // 9 kHz: past the plain HMF range (to 7 kHz), so the knob at 3 kHz and x3 on
  let writes = plan({ hmf_freq: 9000 });
  close(w(writes, 'HMF Frequency').normalized, 0.5);
  close(w(writes, 'HMF x3').normalized, normFor(tablePoints({ states: {} }, sw), 'On'));
  assert.equal(w(writes, 'HMF Frequency').key, 'hmf_freq');
  // 3 kHz fits the plain range: switch off
  writes = plan({ hmf_freq: 3000 });
  close(w(writes, 'HMF x3').normalized, normFor(tablePoints({ states: {} }, sw), 'Off'));
  // 100 Hz: below the plain LMF range (200 Hz), so /3 on and the knob at 300 Hz
  writes = plan({ lmf_freq: 100 });
  assert.ok(w(writes, 'LMF div3').normalized > 0.5);
  // 30 kHz fits neither: not set
  const r = planStrip(G, target, tables, { hmf_freq: 30000 }, ['eq']);
  assert.ok(r.skipped.includes('hmf_freq'));
});

test('SSL 4K B stepped knobs: nearest step, ratio "out" is 1:1, and words without an equivalent stay put', () => {
  const B = load('com.SSLN.au.aufx_S4KB.json');
  const run = (from, to, text) => Array.from({ length: Math.round((to - from) * 100) + 1 }, (_, i) => [+(from + i / 100).toFixed(2), text]);
  const tables = {
    'Compressor Ratio': [...run(0, 0.12, 'out'), ...run(0.13, 0.37, '2:1'), ...run(0.38, 0.62, '4:1'), ...run(0.63, 0.87, '10:1'), ...run(0.88, 1, 'ds')],
    'Compressor Release': [...run(0, 0.09, 'ds'), ...run(0.1, 0.29, '.2s'), ...run(0.3, 0.49, '.4s'), ...run(0.5, 0.69, '.8s'), ...run(0.7, 0.89, '1.6s'), ...run(0.9, 1, 'auto')],
  };
  const ps = new Map(Object.keys(tables).map((name) => [name, param({ name, norm: 0 })]));
  const w = (values) => Object.fromEntries(planStrip(B, ps, tables, values, ['dyn']).writes.map((x) => [x.param, x.normalized]));
  close(w({ comp_ratio: 3 })['Compressor Ratio'], 0.5);         // 4:1, the middle of its run
  close(w({ comp_ratio: 1 })['Compressor Ratio'], 0.06);        // out
  close(w({ comp_release: 0.44 })['Compressor Release'], 0.39); // .4s
  close(w({ comp_release: 'auto' })['Compressor Release'], 0.95);
  assert.ok(planStrip(B, ps, tables, { comp_ratio: 20 }, ['dyn']).skipped.includes('comp_ratio'));   // far past 10:1
  ps.get('Compressor Ratio').normalized.value = 0.06;
  assert.equal(readControl(B, 'comp_ratio', ps.get('Compressor Ratio'), tables['Compressor Ratio']), 1);
});

test('UA stepped knobs that report a step number: values come from the labels, in whatever order', () => {
  const LA = load('uaudio_la_6176.json');
  const stepped = (name, display, labels) => param({ name, display, labels, steps: labels.map((_, i) => i), real: labels.indexOf(display), norm: 0 });
  const lo = stepped('EQ Lo Freq', '100 Hz', ['70 Hz', '200 Hz', '100 Hz']);
  assert.equal(readControl(LA, 'lf_freq', lo, null), 100);                     // not 2, the step number
  close(planControl(LA, 'lf_freq', lo, null, 180).normalized, 0.5);             // 200 Hz is the middle step
  const cut = stepped('Cut Filter', 'Off', ['Off', '75Hz']);
  assert.equal(readControl(LA, 'hpf', cut, null), 'off');
  close(planControl(LA, 'hpf', cut, null, 80).normalized, 1);
  close(planControl(LA, 'hpf', cut, null, 'off').normalized, 0);
  const ratio = stepped('1176 Ratio', 'ALL', ['1:1', '4:1', '8:1', '12:1', '20:1', 'ALL']);
  assert.equal(readControl(LA, 'comp_ratio', ratio, null), Infinity);
  close(planControl(LA, 'comp_ratio', ratio, null, Infinity).normalized, 1);
  close(planControl(LA, 'comp_ratio', ratio, null, 10).normalized, 0.6);       // 10:1 -> 12:1 (log-nearest)
  // a fixed control: a shelf needs nothing set; a bell can't be had, and is remembered
  const ps = new Map([['EQ Lo Freq', lo]]);
  assert.deepEqual(planStrip(LA, ps, {}, { lf_type: 'shelf' }, ['eq']).writes, []);
  assert.ok(planStrip(LA, ps, {}, { lf_type: 'bell' }, ['eq']).held.includes('lf_type'));
  assert.equal(readStrip(LA, ps, {}).lf_type, 'shelf');
});

test('a range switch in a real-mode map (Avalon X10) is used only past the knob\'s recorded ends', () => {
  const AV = structuredClone(load('uaudio_avalon_vt-737sp.json'));
  AV.controls.lmf_freq.ends = [30, 300];
  const ps = new Map([
    ['Lo Mid Freq', param({ name: 'Lo Mid Freq', real: 150, norm: 0.5, display: '150 Hz' })],
    ['Lo Mid X10', param({ name: 'Lo Mid X10', real: 0, norm: 0, display: 'X10', labels: ['Out', 'X10'], steps: [0, 1] })],
  ]);
  assert.equal(readStrip(AV, ps, {}).lmf_freq, 1500);                          // X10 on: the band is at 1.5 kHz
  const w = (v) => Object.fromEntries(planStrip(AV, ps, {}, { lmf_freq: v }, ['eq']).writes.map((x) => [x.param, x.real ?? x.normalized]));
  assert.deepEqual(w(200), { 'Lo Mid Freq': 200, 'Lo Mid X10': 0 });
  assert.deepEqual(w(2000), { 'Lo Mid Freq': 200, 'Lo Mid X10': 1 });
});

test('a filter with its own on switch (88RS HP Enable): off reads as off; setting a frequency turns it on', () => {
  const N = load('com.universal_audio_inc.vst.BBAU.json');
  const sw = [[0, 'Off'], [0.45, 'Off'], [0.55, 'On'], [1, 'On']];
  const tables = { 'HP Freq': [[0, '31.8 Hz'], [0.5, '100 Hz'], [1, '400 Hz']], 'HP Enable': sw };
  const ps = (freq, en) => new Map([['HP Freq', param({ name: 'HP Freq', norm: freq })], ['HP Enable', param({ name: 'HP Enable', norm: en })]]);
  assert.equal(readStrip(N, ps(0.5, 0), tables).hpf, 'off');
  close(readStrip(N, ps(0.5, 1), tables).hpf, 100, 0.5);
  const w = (v) => Object.fromEntries(planStrip(N, ps(0, 0), tables, { hpf: v }, ['eq']).writes.map((x) => [x.param, x.normalized]));
  const on = normFor(tablePoints({ states: {} }, sw), 'On'), off = normFor(tablePoints({ states: {} }, sw), 'Off');
  const r = w(100);
  close(r['HP Freq'], 0.5); close(r['HP Enable'], on);
  assert.deepEqual(w('off'), { 'HP Enable': off });                 // the knob is left where it is
});

test('Harrison 32C low-pass: fully open counts as off, both ways', () => {
  const H = load('com.universal_audio_inc.vst.B7AU.json');
  const tables = { LowPass: [[0, '133 Hz'], [0.5, '1.09 k'], [1, '17.2 k']] };
  const ps = new Map([['LowPass', param({ name: 'LowPass', norm: 0 })]]);
  const w = planStrip(H, ps, tables, { lpf: 'off' }, ['eq']).writes;
  close(w[0].normalized, 1);
  ps.get('LowPass').normalized.value = 1;
  assert.equal(readStrip(H, ps, tables).lpf, 'off');
  ps.get('LowPass').normalized.value = 0.5;
  close(readStrip(H, ps, tables).lpf, 1090, 1);
});

test('graphic EQ (Hitsville): bands go to the nearest graphic band, and the biggest come back as shared bands', () => {
  const H = load('uaudio_hitsville_eq.json');
  const steps = Array.from({ length: 17 }, (_, i) => `${i - 8} dB`);
  const band = (name, gain) => param({ name, display: `${gain} dB`, labels: steps, steps: steps.map((_, i) => i), real: gain, norm: (gain + 8) / 16 });
  const names = ['1-50', '2-130', '3-320', '4-800', '5-2000', '6-5000', '7-12500'];
  const ps = new Map(names.map((n) => [n, band(n, 0)]));
  const w = Object.fromEntries(planStrip(H, ps, {}, { lf_gain: 2, lf_freq: 100, hmf_gain: -3, hmf_freq: 3000, hf_gain: 4, hf_freq: 9000, lmf_gain: 0, lmf_freq: 500 }, ['eq']).writes.map((x) => [x.param, x.normalized]));
  close(w['2-130'], 10 / 16);   // +2
  close(w['5-2000'], 5 / 16);   // -3
  close(w['7-12500'], 12 / 16); // +4
  close(w['4-800'], 0.5);       // unused: flat
  // read back: the boosted and cut bands become shared bands in frequency order
  for (const [n, g] of [['2-130', 2], ['5-2000', -3], ['7-12500', 4]]) ps.set(n, band(n, g));
  const r = readStrip(H, ps, {});
  assert.deepEqual([r.lf_gain, r.lf_freq, r.hmf_gain, r.hmf_freq, r.hf_gain, r.hf_freq, r.lmf_gain], [2, 130, -3, 2000, 4, 12500, 0]);
});

test('flexible bands (Pro-Q 4): another strip goes onto free bands with the right shapes, and reads back the same', () => {
  const PQ = load('com.FabF.au.aumf_FQ4p.json');
  const logPts = Array.from({ length: 101 }, (_, i) => [i / 100, `${(10 * Math.pow(3000, i / 100)).toFixed(2)} Hz`]);
  const tables = {
    'Band 1 Frequency': logPts,
    'Band 1 Gain': Array.from({ length: 61 }, (_, i) => [i / 60, `${i - 30} dB`]),
    'Band 1 Q': Array.from({ length: 101 }, (_, i) => [i / 100, (0.1 + i * 0.099).toFixed(3)]),
  };
  const ps = new Map();
  for (let n = 1; n <= 24; n++) for (const r of ['Used', 'Enabled', 'Frequency', 'Gain', 'Q', 'Shape']) {
    ps.set(`Band ${n} ${r}`, param({ name: `Band ${n} ${r}`, norm: r === 'Enabled' ? 1 : 0 }));
  }
  const src = { hpf: 80, lpf: 'off', lf_gain: 2, lf_freq: 100, lf_type: 'shelf', lmf_gain: -3, lmf_freq: 400, lmf_q: 2,
    hmf_gain: 4, hmf_freq: 3000, hmf_q: 1, hf_gain: 3, hf_freq: 10000, hf_type: 'shelf' };
  const r = planStrip(PQ, ps, tables, src, ['eq']);
  assert.deepEqual(r.skipped, []);
  for (const w of r.writes) ps.get(w.param).normalized.value = w.normalized;
  const used = [...Array(24)].map((_, i) => ps.get(`Band ${i + 1} Used`).normalized.value).filter((v) => v === 1).length;
  assert.equal(used, 5);                                                    // a cut and four bands
  const back = readStrip(PQ, ps, tables);
  close(back.hpf, 80, 2); assert.equal(back.lpf, 'off');
  assert.equal(back.lf_type, 'shelf'); assert.equal(back.hf_type, 'shelf');
  for (const k of ['lf', 'lmf', 'hmf', 'hf']) {
    close(back[`${k}_gain`], src[`${k}_gain`], 0.6);
    close(back[`${k}_freq`] / src[`${k}_freq`], 1, 0.04);
  }
  close(back.lmf_q, 2, 0.1);
});

test('compressors: a limiter setting takes the highest ratio on one without inf; API 2500 "Vari" reads as nothing', () => {
  const lbl = (name, labels, i) => ({ name: { value: name }, discrete: { value: true }, displayValues: { value: labels }, realValues: { value: labels.map((_, k) => k) },
    normalized: { value: i / (labels.length - 1) }, real: { value: i }, display: { value: labels[i] } });
  const m176 = { pluginId: 'u176', name: '176', mode: 'real', controls: { comp_ratio: { param: 'Ratio' } } };
  const p176 = new Map([['Ratio', lbl('Ratio', ['2:1', '4:1', '8:1', '12:1'], 0)]]);
  assert.deepEqual(planStrip(m176, p176, {}, { comp_ratio: Infinity }, ['dyn']).writes.map((w) => w.normalized), [1]);
  const m2500 = { pluginId: 'a2500', name: 'API 2500', mode: 'real', controls: { comp_release: { param: 'Release', texts: { Vari: 'skip' } } } };
  const labels = ['.05 s', '0.1 s', '0.2 s', '0.5 s', '1 s', '2 s', 'Vari'];
  assert.equal(readStrip(m2500, new Map([['Release', lbl('Release', labels, 6)]]), {}).comp_release, undefined);
  assert.equal(readStrip(m2500, new Map([['Release', lbl('Release', labels, 0)]]), {}).comp_release, 0.05);
  const w = planStrip(m2500, new Map([['Release', lbl('Release', labels, 6)]]), {}, { comp_release: 1.8 }, ['dyn']).writes;
  assert.equal(w[0].normalized, 5 / 6);   // 2 s, never Vari
});

test('table knobs: a value just past the measured range goes to the nearer end; one far past is left', () => {
  const map = { pluginId: 'bx', name: 'bx', mode: 'table', controls: { comp_thresh: { param: 'Thr' } } };
  const tbl = { Thr: [[0, '+20.0 dB'], [0.5, '+5.0 dB'], [1, '-10.0 dB']] };
  const ps = new Map([['Thr', { name: { value: 'Thr' }, normalized: { value: 0.5 }, discrete: { value: false } }]]);
  const near = planStrip(map, ps, tbl, { comp_thresh: -12 }, ['dyn']);
  assert.deepEqual(near.writes.map((w) => w.normalized), [1]);
  assert.deepEqual(near.nearest, ['comp_thresh']);
  const far = planStrip(map, ps, tbl, { comp_thresh: -30 }, ['dyn']);
  assert.equal(far.writes.length, 0);
  assert.deepEqual(far.skipped, ['comp_thresh']);
});
