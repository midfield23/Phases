/**
 * Pure conversion logic: no LUNA connection here, so it can be tested offline.
 *
 * A "param" is anything shaped like an SDK Control:
 *   { name, discrete, real, normalized, display, displayValues, realValues }
 * each a Prop with `.value`. A "table" is the measured sweep of one parameter:
 *   [[normalized, displayText], ...]  (as tools/build-table.mjs writes it)
 */
import { CONTROLS } from './controls.mjs';

// ---------------------------------------------------------------- display text

/** First number in a display string, in base units when the string names them. */
/**
 * A control's value as a plain number. Right after a write the SDK can hold the wrapped
 * number that was sent (Luna.float) until LUNA reports back; read as-is it isn't a number.
 */
export const num = (v) => (v !== null && typeof v === 'object' && typeof v.value === 'number' ? v.value : v);

export function parseDisplay(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (/^[-−]\s*o+o*\b/i.test(s) || /^[-−]?\s*inf/i.test(s)) return s.startsWith('-') || s.startsWith('−') ? -Infinity : Infinity;
  const m = s.replace('−', '-').match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i);
  if (!m) return null;
  let n = Number(m[0]);
  const rest = s.slice(m.index + m[0].length).trim();
  if (/^k(hz)?\b/i.test(rest)) n *= 1000;
  else if (/^ms\b/i.test(rest)) n /= 1000;
  return n;
}

/** Turn one measured display string into a value, using the map's control definition. */
export function tableValue(def, text) {
  const s = String(text ?? '').trim();
  if (def.offText && s.toUpperCase() === def.offText.toUpperCase()) return 'off';
  if (s === '') {
    if (def.blank === 'inf') return Infinity;
    if (def.blank === '-inf') return -Infinity;
    return undefined;
  }
  if (def.states) return s;                       // a switch: the label is the value
  if (def.texts && s in def.texts) {
    // a word that stands for a value: 4K B ratio "out" = 1:1, 1176 "ALL" = "inf" (JSON has no Infinity)
    const t = def.texts[s];
    // "skip": a position that can't be carried (API 2500 release "Vari"), so nothing is read
    return t === 'inf' ? Infinity : t === '-inf' ? -Infinity : t === 'skip' ? undefined : t;
  }
  // Ratios written the other way round: Material Comp shows 4:1 as "1:4.0"
  if (def.ratioForm === '1:x') {
    const m = s.match(/^1\s*:\s*(\d*\.?\d+)/);
    if (m) return Number(m[1]);
  }
  const n = parseDisplay(s);
  if (n == null) return s;
  return Number.isFinite(n) ? n * (def.scale ?? 1) : n;
}

/** Measured table -> sorted points [{ n, v }]. */
export function tablePoints(def, table) {
  return (table ?? [])
    .map(([n, text]) => ({ n, v: tableValue(def, text) }))
    .filter((p) => p.v !== undefined)
    .sort((a, b) => a.n - b.n);
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Value at a normalized position: interpolate between numbers, else take the nearest. */
export function valueAt(points, norm) {
  if (!points.length) return undefined;
  let best = points[0];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (norm >= a.n && norm <= b.n) {
      if (isNum(a.v) && isNum(b.v) && b.n > a.n) return a.v + (b.v - a.v) * ((norm - a.n) / (b.n - a.n));
      return norm - a.n <= b.n - norm ? a.v : b.v;
    }
  }
  for (const p of points) if (Math.abs(p.n - norm) < Math.abs(best.n - norm)) best = p;
  return best.v;
}

/** Normalized position for a value, or null when the table cannot reach it. */
export function normFor(points, value) {
  if (!points.length) return null;
  if (!isNum(value)) {
    // 'off', ±Infinity or a label: the middle of the run of points that show it
    const run = points.filter((p) => p.v === value);
    return run.length ? run[Math.floor((run.length - 1) / 2)].n : null;
  }
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (!isNum(a.v) || !isNum(b.v)) continue;
    const lo = Math.min(a.v, b.v), hi = Math.max(a.v, b.v);
    if (value >= lo && value <= hi) {
      if (a.v === b.v) return a.n;
      return a.n + (b.n - a.n) * ((value - a.v) / (b.v - a.v));
    }
  }
  return null;
}

function numericRange(points) {
  const nums = points.filter((p) => isNum(p.v));
  if (!nums.length) return null;
  const min = nums.reduce((m, p) => (p.v < m.v ? p : m));
  const max = nums.reduce((m, p) => (p.v > m.v ? p : m));
  return { min, max };
}

// ---------------------------------------------------------------- reading

/** Does this control go through a measured table? All of a table-mode map's do; in a real-mode
 *  map only those marked `table: true` (UA knobs that report 0-32768 instead of units). */
export const usesTable = (map, def) => map.mode === 'table' || !!def?.table;
/** Does this map need a measured table at all? */
export const needsTable = (map) => map.mode === 'table' || Object.values(map.controls ?? {}).some((d) => d.table);

/** Read one mapped control. Returns undefined when it cannot be read meaningfully. */
export function readControl(map, key, param, table) {
  const def = map.controls[key];
  if (def?.fixed !== undefined) return def.fixed;   // a band that is always a shelf, say
  if (!def || !param) return undefined;

  if (usesTable(map, def)) {
    const points = tablePoints(def, table);
    const v = valueAt(points, num(param.normalized.value));
    if (def.states) return stateKey(def, v);
    return v;
  }

  // real mode
  if (def.states) return stateKey(def, param.display.value);
  // A stepped knob: its label is its value (some UA plugins report the step number as `real`)
  if (param.discrete?.value === true) {
    const v = tableValue(def, param.display.value);
    return v === '' ? undefined : v;
  }
  let v = num(param.real.value);
  if (typeof v !== 'number') v = Number(v);
  if (!Number.isFinite(v)) return undefined;
  if (def.infinityAt != null && v >= def.infinityAt) return Infinity;
  // The display is the plugin's own word: if it disagrees with `real` (API Mic Gain at
  // full read real 79.4 but showed 65.0 dB), believe the display.
  const d = parseDisplay(param.display.value);
  if (d === -Infinity || d === Infinity) return d;
  if (isNum(d) && Math.abs(d - v) > 0.02 * Math.max(1, Math.abs(d))) v = d;
  return v;
}

function stateKey(def, label) {
  for (const [k, l] of Object.entries(def.states)) if (l === label) return k;
  return undefined;
}

/** Points of a range switch's measured table: position -> label. */
const switchPoints = (range, tables) => tablePoints({ states: {} }, tables?.[range.param]);

/** Is a control's range switch on? Table mode: by its measured labels. Real mode: by its display. */
function rangeSwitchOn(map, range, paramsByName, tables) {
  const p = paramsByName.get(range.param);
  if (!p) return false;
  if (map.mode === 'table') return valueAt(switchPoints(range, tables), num(p.normalized.value)) === range.on;
  return p.display?.value === range.on;
}

// ---------------------------------------------------------------- writing

/**
 * Plan one write. Returns { normalized } or { real } (with `filter` when a clamp is fine),
 * or null when the value cannot be represented on this plugin (left at its default).
 */
export function planControl(map, key, param, table, value) {
  const def = map.controls[key];
  const meta = CONTROLS[key] ?? {};
  if (!def || !param || value === undefined) return null;

  if (usesTable(map, def)) {
    const points = tablePoints(def, table);
    if (!points.length) return null;
    if (def.states) {
      const label = def.states[value];
      const n = label === undefined ? null : normFor(points, label);
      return n == null ? null : { normalized: n };
    }
    // A stepped knob goes to its nearest step; a stepped filter past its steps falls back to the filter rules
    if (def.stepped && isNum(value)) {
      const step = planTableSteps(meta, points, value);
      if (step || !meta.filter) return step;
    }
    if (meta.filter) return planTableFilter(meta.filter, points, value);
    if (value === Infinity && meta.unit === 'ratio' && !points.some((p) => p.v === Infinity)) {
      const nums = points.filter((p) => isNum(p.v));
      const top = nums.length && nums.reduce((a, b) => (b.v > a.v ? b : a));
      return top && top.v >= 10 ? { normalized: top.n } : null;
    }
    const n = normFor(points, value);
    if (n != null) return { normalized: n };
    // Just past the knob's measured range: the nearer end, as in real mode
    const range = isNum(value) ? numericRange(points) : null;
    if (range && !meta.filter) {
      const lo = Math.min(range.min.v, range.max.v), hi = Math.max(range.min.v, range.max.v);
      const end = Math.abs(value - range.min.v) <= Math.abs(value - range.max.v) ? range.min : range.max;
      if ((value < lo || value > hi) && Math.abs(value - end.v) <= nearEnough(hi - lo, meta.unit)) return { normalized: end.n, nearest: true };
    }
    return null;
  }

  // real mode
  if (def.states) {
    const label = def.states[value];
    const labels = param.displayValues?.value;
    if (label === undefined || !Array.isArray(labels)) return null;
    const i = labels.indexOf(label);
    return i < 0 ? null : { normalized: stepNorm(i, labels.length) };
  }

  const labels = param.discrete?.value ? param.displayValues?.value : null;
  if (Array.isArray(labels) && labels.length > 1) return planLabelSteps(def, meta, labels, value);
  const steps = param.discrete?.value ? param.realValues?.value : null;
  if (Array.isArray(steps) && steps.length > 1) return planSteps(meta, steps, value);

  if (value === 'off') return meta.filter === 'hp' ? { normalized: 0 } : meta.filter === 'lp' ? { normalized: 1 } : null;
  if (value === Infinity) {
    if (def.infinityAt != null) return { real: def.infinityAt };
    // A limiter setting on a ratio knob that tops out at 10:1 or more: the top
    const top = def.ends && Math.max(...def.ends);
    return meta.unit === 'ratio' && top >= 10 ? { real: top } : null;
  }
  if (!isNum(value)) return null;
  const past = pastEnd(def.ends, meta, value);
  if (past !== undefined) return past;
  return { real: value, filter: !!meta.filter };
}

/** How near the end of a knob a value must be to go to that end: 10% of the travel, or 1 dB. */
export const nearEnough = (span, unit) => Math.max(0.1 * Math.abs(span), unit === 'dB' ? 1 : 0);

/**
 * With a knob's recorded ends ([real at 0, real at 1], from tools/measure-ends.mjs): a value past
 * an end. A filter goes to that end (fully open); anything else goes there only if it's near
 * (and is marked `nearest`), else it can't be set (null). undefined: within range, or no ends.
 */
function pastEnd(ends, meta, value) {
  if (!Array.isArray(ends) || ends.length !== 2 || !ends.every(isNum)) return undefined;
  const lo = Math.min(...ends), hi = Math.max(...ends);
  if (value >= lo && value <= hi) return undefined;
  const end = Math.abs(value - ends[0]) <= Math.abs(value - ends[1]) ? 0 : 1;
  if (meta.filter) return { normalized: end };
  return Math.abs(value - ends[end]) <= nearEnough(hi - lo, meta.unit) ? { normalized: end, nearest: true } : null;
}

function planTableFilter(kind, points, value) {
  const off = normFor(points, 'off');
  const range = numericRange(points);
  const open = () => (off != null ? { normalized: off }
    : range ? { normalized: kind === 'hp' ? range.min.n : range.max.n } : null);
  if (value === 'off') return open();
  if (!isNum(value) || !range) return null;
  // Below an HPF's lowest corner (or above an LPF's highest) the filter is effectively out.
  if (kind === 'hp' && value < range.min.v) return open();
  if (kind === 'lp' && value > range.max.v) return open();
  const n = normFor(points, value);
  if (n != null) return { normalized: n };
  // inside the overall range but between disjoint runs: take the nearest end
  return { normalized: kind === 'hp' ? range.max.n : range.min.n };
}

/**
 * A stepped knob in real mode, by its labels ("70 Hz", "-4.5 dB", "Off", "ALL"): labels can be
 * in any order (LA-6176 lows: 70 / 200 / 100 Hz), so each step's place is its index.
 */
function planLabelSteps(def, meta, labels, value) {
  const vals = labels.map((l) => tableValue(def, l));
  const at = (i) => (i < 0 ? null : { normalized: stepNorm(i, labels.length) });
  const idx = vals.map((v, i) => [v, i]).filter(([v]) => isNum(v));
  if (!isNum(value)) {
    const exact = vals.findIndex((v) => v === value);   // 'off', Infinity, a word
    // A limiter setting (inf:1) on a compressor without one: its highest ratio, if that's 10:1 or more
    if (exact < 0 && value === Infinity && meta.unit === 'ratio' && idx.length) {
      const top = idx.reduce((a, b) => (b[0] > a[0] ? b : a));
      if (top[0] >= 10) return at(top[1]);
    }
    return at(exact);
  }
  if (!idx.length) return null;
  const nums = idx.map(([v]) => v);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  if (value < lo || value > hi) {
    // near the end: within 1.25x for a frequency, else within nearEnough
    const near = meta.unit === 'Hz' ? value > 0 && (value < lo ? lo / value : value / hi) <= 1.25
      : Math.abs(value - (value < lo ? lo : hi)) <= nearEnough(hi - lo, meta.unit);
    if (!near) return null;
  }
  const logScale = value > 0 && lo > 0 && meta.unit !== 'dB';
  const dist = (a) => (logScale ? Math.abs(Math.log(a / value)) : Math.abs(a - value));
  let best = idx[0];
  for (const e of idx) if (dist(e[0]) < dist(best[0])) best = e;
  return at(best[1]);
}

function planSteps(meta, steps, value) {
  const nums = steps.map(Number);
  const lo = Math.min(...nums), hi = Math.max(...nums);
  if (value === 'off') {
    if (meta.filter === 'hp') return { normalized: stepNorm(nums.indexOf(lo), nums.length) };
    if (meta.filter === 'lp') return { normalized: stepNorm(nums.indexOf(hi), nums.length) };
    return null;
  }
  if (!isNum(value)) return null;
  if (!meta.filter && (value < lo - 1e-9 || value > hi + 1e-9)) {
    // a little past the end is still the end step; far past it is not representable
    const slack = meta.unit === 'Hz' ? 1.25 : 0;
    const near = meta.unit === 'Hz'
      ? value >= lo / slack && value <= hi * slack
      : Math.abs(value - (value < lo ? lo : hi)) <= 1;
    if (!near) return null;
  }
  const dist = (a) => (meta.unit === 'Hz' ? Math.abs(Math.log(a / value)) : Math.abs(a - value));
  let best = 0;
  nums.forEach((s, i) => { if (dist(s) < dist(nums[best])) best = i; });
  return { normalized: stepNorm(best, nums.length) };
}

const stepNorm = (i, count) => (count > 1 ? i / (count - 1) : 0);

// ---------------------------------------------------------------- whole strips

/** Is a section active on this plugin right now (map.when)? */
export function sectionActive(map, section, paramsByName) {
  const w = map.when?.[section];
  if (!w) return true;
  const p = paramsByName.get(w.param);
  return !!p && p.display.value === w.is;
}

/** Read every mapped control. Returns { key: value } for the controls that could be read. */
export function readStrip(map, paramsByName, tables = {}) {
  const out = {};
  for (const key of Object.keys(map.controls)) {
    const section = CONTROLS[key]?.section;
    if (!sectionActive(map, section, paramsByName)) continue;
    const def = map.controls[key];
    if (def.graphic || def.flex) continue;   // read with the graphic / flexible bands below
    let v = readControl(map, key, paramsByName.get(def.param), tables[def.param]);
    // A range switch (SSL 4K G HMF x3): the knob reads 3 kHz but the band is at 9 kHz
    if (isNum(v) && def.range && rangeSwitchOn(map, def.range, paramsByName, tables)) v *= def.range.by;
    // ...and one whose middle position takes the band out (Massive Passive CUT / OUT / BOOST)
    if (isNum(v) && def.range?.zero && paramsByName.get(def.range.param)?.display?.value === def.range.zero) v = 0;
    // A filter with no OUT position (Harrison 32C low-pass): parked fully open counts as off
    if (def.openIsOff && isNum(v)) {
      const pts = tablePoints(def, tables[def.param]).filter((p) => isNum(p.v)).map((p) => p.v);
      const filter = CONTROLS[key]?.filter;
      if (pts.length && ((filter === 'lp' && v >= Math.max(...pts) * 0.99) || (filter === 'hp' && v <= Math.min(...pts) * 1.01))) v = 'off';
    }
    // A filter with its own on switch (88RS HP Enable): off when the switch is
    // ...or a band with its own in switch (Bettermaker EQ1 IN): its gain reads 0 when out (offValue)
    if (def.enable && v !== undefined && !rangeSwitchOn(map, def.enable, paramsByName, tables)) v = def.enable.offValue ?? 'off';
    if (v !== undefined) out[key] = v;
  }
  // A section that shares its on-switch counts as off when it is neutralised (SSL gate range 0)
  for (const [key, def] of Object.entries(map.controls)) {
    if (out[key] !== 'on' || !def.offIf) continue;
    if (Object.entries(def.offIf).every(([k, v]) => near(out[k], v))) out[key] = 'off';
  }
  if (map.graphic && sectionActive(map, 'eq', paramsByName)) Object.assign(out, readGraphic(map.graphic, paramsByName));
  if (map.flex && sectionActive(map, 'eq', paramsByName)) Object.assign(out, readFlex(map.flex, paramsByName, tables));
  return out;
}

// ---------------------------------------------------------------- graphic EQs
//
// A graphic EQ (Hitsville) has fixed bands where other strips have four sweepable ones.
// map.graphic.bands: [{ gain: "1-50", freq: 50 }] or, for a band with a choice of frequency
// and a dip/peak switch, { gain: "L1-Gain", freq: "L1-Freq", sign: { param: "L1-Dip/Pk", neg: "Dip", pos: "Peak" } }.

const SHARED_BANDS = ['lf', 'lmf', 'hmf', 'hf'];
const BAND_REGION = { lf: [0, 250], lmf: [250, 1000], hmf: [1000, 4000], hf: [4000, Infinity] };
const labelsOf = (p) => (Array.isArray(p?.displayValues?.value) ? p.displayValues.value : []);
const octaves = (a, b) => Math.abs(Math.log2(a / b));

function graphicBandState(band, paramsByName) {
  const g = paramsByName.get(band.gain);
  const gain = g ? tableValue({}, g.display.value) : undefined;
  const fp = typeof band.freq === 'string' ? paramsByName.get(band.freq) : null;
  const freq = fp ? tableValue({}, fp.display.value) : band.freq;
  const neg = band.sign && paramsByName.get(band.sign.param)?.display?.value === band.sign.neg;
  return { gain: isNum(gain) ? (neg ? -gain : gain) : undefined, freq };
}

/** The graphic's boosted and cut bands, as up to four shared bands (by frequency). */
function readGraphic(graphic, paramsByName) {
  const active = graphic.bands.map((b) => graphicBandState(b, paramsByName))
    .filter((b) => isNum(b.gain) && isNum(b.freq) && Math.abs(b.gain) >= 0.25);
  const chosen = active.sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).slice(0, 4).sort((a, b) => a.freq - b.freq);
  const out = {};
  const free = [...SHARED_BANDS];
  for (const b of chosen) {
    // its own region if free, else the nearest free band in frequency order
    let k = free.find((x) => b.freq >= BAND_REGION[x][0] && b.freq < BAND_REGION[x][1]);
    if (!k) k = free.reduce((best, x) => (Math.abs(SHARED_BANDS.indexOf(x) - regionIndex(b.freq)) < Math.abs(SHARED_BANDS.indexOf(best) - regionIndex(b.freq)) ? x : best));
    free.splice(free.indexOf(k), 1);
    out[`${k}_gain`] = b.gain;
    out[`${k}_freq`] = b.freq;
  }
  for (const k of free) out[`${k}_gain`] = 0;
  return out;
}
const regionIndex = (f) => SHARED_BANDS.findIndex((k) => f >= BAND_REGION[k][0] && f < BAND_REGION[k][1]);

// ---------------------------------------------------------------- flexible bands
//
// EQs whose bands go anywhere with any shape (Pro-Q 4, smart:EQ4, smart:Chain, AirEQ).
// map.flex: {
//   bands:  [{ used?, on?, freq, gain?, q?, shape? }]   parameter names of each band
//   tables: { freq, gain, q, shape }                     the band whose measured tables all bands share
//   shapes: { bell, lowShelf, highShelf, lowCut, highCut } -> a label, or a step index with shapeSteps
//   cuts:   false when the plugin's filters are mapped as ordinary controls instead
// }
// Reading: bands in use become hpf / lpf (cut shapes) and up to four shared bands (biggest gains).
// Writing: each of another strip's bands takes a free band that can have its shape; the rest go off.

const EQ_SHAPES = ['bell', 'lowShelf', 'highShelf'];

function flexPoints(flex, band, role, tables) {
  const own = band[role] && tables?.[band[role]];
  const t = own ?? (flex.tables?.[role] ? tables?.[flex.tables[role]] : undefined);
  return t ? tablePoints(role === 'shape' ? { states: {} } : {}, t) : null;
}
function flexValue(flex, band, role, paramsByName, tables) {
  const p = paramsByName.get(band[role]);
  const pts = p && flexPoints(flex, band, role, tables);
  return pts ? valueAt(pts, num(p.normalized.value)) : undefined;
}
const flexOn = (paramsByName, name) => !name || num(paramsByName.get(name)?.normalized?.value) >= 0.5;
// A band can carry its own shape labels (AirEQ: band 1's "Shelf" is a low shelf, band 5's a high shelf)
const flexLabels = (flex, band) => band.labels ?? flex.shapes ?? {};
const flexAllowed = (flex, band) => (band.shape ? Object.keys(flexLabels(flex, band)) : ['bell']);

function flexShape(flex, band, paramsByName, tables) {
  if (!band.shape) return 'bell';
  const p = paramsByName.get(band.shape);
  if (!p) return undefined;
  const n = num(p.normalized.value);
  if (flex.shapeSteps) {
    const i = Math.round(n * (flex.shapeSteps - 1));
    return Object.keys(flex.shapes).find((k) => flex.shapes[k] === i);
  }
  const pts = flexPoints(flex, band, 'shape', tables);
  const label = pts ? valueAt(pts, n) : p.display?.value;
  const labels = flexLabels(flex, band);
  return Object.keys(labels).find((k) => labels[k] === label);
}

function readFlex(flex, paramsByName, tables) {
  const active = [];
  for (const b of flex.bands) {
    if (!flexOn(paramsByName, b.used) || !flexOn(paramsByName, b.on)) continue;
    const shape = flexShape(flex, b, paramsByName, tables);
    const freq = flexValue(flex, b, 'freq', paramsByName, tables);
    if (!shape || !isNum(freq)) continue;   // a shape the shared list has no place for (notch, tilt...)
    active.push({ shape, freq, gain: flexValue(flex, b, 'gain', paramsByName, tables), q: flexValue(flex, b, 'q', paramsByName, tables) });
  }
  const out = {};
  if (flex.cuts !== false) {
    const lows = active.filter((b) => b.shape === 'lowCut').map((b) => b.freq);
    const highs = active.filter((b) => b.shape === 'highCut').map((b) => b.freq);
    out.hpf = lows.length ? Math.max(...lows) : 'off';
    out.lpf = highs.length ? Math.min(...highs) : 'off';
  }
  const eq = active.filter((b) => EQ_SHAPES.includes(b.shape) && isNum(b.gain) && Math.abs(b.gain) >= 0.25)
    .sort((a, b) => Math.abs(b.gain) - Math.abs(a.gain)).slice(0, 4).sort((a, b) => a.freq - b.freq);
  const free = [...SHARED_BANDS];
  for (const b of eq) {
    // a low shelf is the low band and a high shelf the high band if they are free; else by region
    let k = b.shape === 'lowShelf' && free.includes('lf') ? 'lf' : b.shape === 'highShelf' && free.includes('hf') ? 'hf'
      : free.find((x) => b.freq >= BAND_REGION[x][0] && b.freq < BAND_REGION[x][1]);
    if (!k) k = free.reduce((best, x) => (Math.abs(SHARED_BANDS.indexOf(x) - regionIndex(b.freq)) < Math.abs(SHARED_BANDS.indexOf(best) - regionIndex(b.freq)) ? x : best));
    free.splice(free.indexOf(k), 1);
    out[`${k}_gain`] = b.gain;
    out[`${k}_freq`] = b.freq;
    if ((k === 'lmf' || k === 'hmf') && isNum(b.q)) out[`${k}_q`] = b.q;
    if (k === 'lf' || k === 'hf') out[`${k}_type`] = b.shape === 'bell' ? 'bell' : 'shelf';
  }
  for (const k of free) out[`${k}_gain`] = 0;
  return out;
}

/** Position for a value on a measured knob, held at the knob's ends. */
function normClamp(pts, v) {
  if (!pts || !isNum(v)) return null;
  const n = normFor(pts, v);
  if (n != null) return n;
  const nums = pts.filter((p) => isNum(p.v));
  if (!nums.length) return null;
  const lo = nums.reduce((a, b) => (b.v < a.v ? b : a)), hi = nums.reduce((a, b) => (b.v > a.v ? b : a));
  return v < lo.v ? lo.n : hi.n;
}

function planFlex(flex, paramsByName, tables, values) {
  const want = [];
  if (flex.cuts !== false) {
    if (isNum(values.hpf)) want.push({ keys: ['hpf'], shape: 'lowCut', freq: values.hpf });
    if (isNum(values.lpf)) want.push({ keys: ['lpf'], shape: 'highCut', freq: values.lpf });
  }
  for (const k of SHARED_BANDS) {
    const g = values[`${k}_gain`], f = values[`${k}_freq`];
    if (!isNum(g) || !isNum(f) || Math.abs(g) < 0.25) continue;
    const shelf = values[`${k}_type`] === 'shelf';
    const shape = k === 'lf' && shelf ? 'lowShelf' : k === 'hf' && shelf ? 'highShelf' : 'bell';
    want.push({ keys: [`${k}_gain`, `${k}_freq`], typeKey: `${k}_type`, qKey: `${k}_q`, shape, freq: f, gain: g, q: values[`${k}_q`] });
  }
  // shelves and cuts first, so they get the bands that can take their shape
  want.sort((a, b) => (a.shape === 'bell') - (b.shape === 'bell'));
  const free = flex.bands.map((b) => b);
  const writes = [], skipped = [];
  const pick = (shape) => free.filter((b) => flexAllowed(flex, b).includes(shape))
    .sort((a, b) => flexAllowed(flex, a).length - flexAllowed(flex, b).length)[0];
  for (const w of want) {
    let shape = w.shape;
    let band = pick(shape);
    if (!band && shape !== 'bell' && EQ_SHAPES.includes(shape)) {   // no shelf to be had: a bell, and the type is remembered
      shape = 'bell';
      band = pick('bell');
      if (band) skipped.push(w.typeKey);
    }
    if (!band) { skipped.push(...w.keys); continue; }
    const key = w.keys[0];
    const out = [];
    const nFreq = normClamp(flexPoints(flex, band, 'freq', tables), w.freq);
    if (nFreq == null) { skipped.push(...w.keys); continue; }
    if (band.used) out.push({ param: band.used, key, normalized: 1 });
    if (band.on) out.push({ param: band.on, key, normalized: 1 });
    if (band.shape) {
      const s = flex.shapeSteps ? flex.shapes[shape] : flexLabels(flex, band)[shape];
      const n = flex.shapeSteps ? s / (flex.shapeSteps - 1) : normFor(flexPoints(flex, band, 'shape', tables) ?? [], s);
      if (n == null) { skipped.push(...w.keys); continue; }
      out.push({ param: band.shape, key, normalized: n });
    }
    out.push({ param: band.freq, key, normalized: nFreq });
    if (band.gain && EQ_SHAPES.includes(shape)) {
      const n = normClamp(flexPoints(flex, band, 'gain', tables), w.gain);
      if (n != null) out.push({ param: band.gain, key, normalized: n });
    }
    if (band.q && isNum(w.q)) {
      const n = normClamp(flexPoints(flex, band, 'q', tables), w.q);
      if (n != null) out.push({ param: band.q, key: w.qKey, normalized: n });
    } else if (w.qKey && isNum(w.q)) skipped.push(w.qKey);
    free.splice(free.indexOf(band), 1);
    writes.push(...out);
  }
  // bands nobody uses go off
  for (const b of free) {
    if (b.used) writes.push({ param: b.used, normalized: 0 });
    else if (b.on) writes.push({ param: b.on, normalized: 0 });
  }
  return { writes, skipped };
}

/** Another strip's bands, each onto the graphic band (and frequency choice) nearest to it. */
function planGraphic(graphic, paramsByName, values) {
  const options = graphic.bands.map((b) => {
    const fp = typeof b.freq === 'string' ? paramsByName.get(b.freq) : null;
    const freqs = fp ? labelsOf(fp).map((l) => tableValue({}, l)) : [b.freq];
    return { band: b, freqs, total: 0, freqIndex: null, keys: [] };
  });
  for (const k of SHARED_BANDS) {
    const gain = values[`${k}_gain`], freq = values[`${k}_freq`];
    if (!isNum(gain) || !isNum(freq) || freq <= 0 || Math.abs(gain) < 0.25) continue;
    let best = null;
    for (const o of options) {
      o.freqs.forEach((f, i) => {
        if (!isNum(f)) return;
        // a band whose frequency is already chosen keeps it
        if (o.freqIndex !== null && i !== o.freqIndex) return;
        const d = octaves(f, freq);
        if (!best || d < best.d) best = { o, i, d };
      });
    }
    if (!best) continue;
    best.o.total += gain;
    best.o.freqIndex = best.i;
    best.o.keys.push(`${k}_gain`);
  }
  const writes = [];
  for (const o of options) {
    const { band } = o;
    const g = paramsByName.get(band.gain);
    if (!g) continue;
    const key = o.keys[0];
    const signed = !!band.sign;
    const mag = signed ? Math.abs(o.total) : o.total;
    const labels = labelsOf(g);
    const vals = labels.map((l) => tableValue({}, l));
    let bi = -1;
    vals.forEach((v, i) => { if (isNum(v) && (bi < 0 || Math.abs(v - mag) < Math.abs(vals[bi] - mag))) bi = i; });   // nearest step, clamped
    if (bi >= 0) writes.push({ param: band.gain, key, normalized: stepNorm(bi, labels.length) });
    if (signed && o.total !== 0) {
      const sp = paramsByName.get(band.sign.param);
      const i = labelsOf(sp).indexOf(o.total < 0 ? band.sign.neg : band.sign.pos);
      if (i >= 0) writes.push({ param: band.sign.param, key, normalized: stepNorm(i, labelsOf(sp).length) });
    }
    if (o.freqIndex !== null && typeof band.freq === 'string') {
      writes.push({ param: band.freq, key, normalized: stepNorm(o.freqIndex, o.freqs.length) });
    }
  }
  return writes;
}

const near = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 0.05 : a === b);

/**
 * Plan writes for a target strip. `values` are control values; `sections` limits what
 * carries ('io' always carries). Controls that share one parameter (SSL 'Dynamics In'
 * for compressor and gate) are combined: a switch is on if any of them is on.
 * Returns { writes: [{ param, key, normalized?|real?, filter? }], skipped: [key], held: [key] }.
 * `held` lists controls whose real value did NOT reach this strip (left at default, or
 * neutralised): the caller should keep remembering their real value.
 */
/**
 * A stepped knob in a measured table (4K B ratio 2:1 / 4:1 / 10:1): the step nearest the value,
 * at the middle of the positions that show it. A value past the last step goes there only if
 * it's near (nearEnough), else it can't be set.
 */
function planTableSteps(meta, points, value) {
  const runs = new Map();
  for (const p of points) if (isNum(p.v)) (runs.get(p.v) ?? runs.set(p.v, []).get(p.v)).push(p.n);
  const steps = [...runs.keys()];
  if (!steps.length) return null;
  const lo = Math.min(...steps), hi = Math.max(...steps);
  if (value < lo || value > hi) {
    const end = value < lo ? lo : hi;
    // near the end: within 1.25x for a frequency, else within nearEnough
    const near = meta.unit === 'Hz' ? value > 0 && (value < lo ? lo / value : value / hi) <= 1.25
      : Math.abs(value - end) <= nearEnough(hi - lo, meta.unit);
    if (!near) return null;
  }
  const logScale = value > 0 && lo > 0 && meta.unit !== 'dB';
  const dist = (a) => (logScale ? Math.abs(Math.log(a / value)) : Math.abs(a - value));
  const best = steps.reduce((a, b) => (dist(b) < dist(a) ? b : a));
  const ns = runs.get(best);
  return { normalized: ns[Math.floor((ns.length - 1) / 2)] };
}

/**
 * A control with a range switch (4K G HMF x3, Avalon mids X10, Helios mid Peak/Trough as x -1):
 * [knob write, switch write], or null. The plain range if the value fits it, else the switched
 * one, else the plain range's nearest end if that's near.
 */
function planRanged(map, key, paramsByName, tables, value) {
  const def = map.controls[key];
  const param = paramsByName.get(def.param);
  const tbl = tables?.[def.param];
  const inEnds = (v) => !Array.isArray(def.ends) || (v >= Math.min(...def.ends) && v <= Math.max(...def.ends));
  const fits = (v) => {
    const p = planControl(map, key, param, tbl, v);
    return p && !p.nearest && (usesTable(map, def) || inEnds(v)) ? p : null;
  };
  let plan = fits(value), on = false;
  if (!plan) { plan = fits(value / def.range.by); on = !!plan; }
  if (!plan) plan = planControl(map, key, param, tbl, value);
  if (!plan) return null;
  // A switch with a position that takes the band out (Massive Passive OUT): used for 0 dB
  const label = def.range.zero && value === 0 ? def.range.zero : on ? def.range.on : def.range.off;
  const n = switchNorm(map, def.range, paramsByName.get(def.range.param), tables, label);
  if (n == null) return null;
  return [{ param: def.param, ...plan }, { param: def.range.param, normalized: n }];
}

/** Where a range switch sits for one of its labels: by its table, or by its step labels. */
function switchNorm(map, range, p, tables, label) {
  if (map.mode === 'table') return normFor(switchPoints(range, tables), label);
  const labels = p?.displayValues?.value;
  const i = Array.isArray(labels) ? labels.indexOf(label) : -1;
  return i < 0 ? null : stepNorm(i, labels.length);
}

export function planStrip(map, paramsByName, tables, values, sections = ['io', 'eq', 'dyn', 'gate']) {
  const allowed = new Set([...sections, 'io']);
  // A section that is off but shares its on-switch with one that is on gets neutralised
  // instead (SSL: one Dynamics In for compressor and gate).
  values = { ...values };
  const overridden = [];
  for (const [key, def] of Object.entries(map.controls)) {
    if (values[key] !== 'off' || !def.whenOff) continue;
    const shared = Object.entries(map.controls).some(([k, d]) => k !== key && d.param === def.param && values[k] === 'on');
    if (shared) { Object.assign(values, def.whenOff); overridden.push(...Object.keys(def.whenOff)); }
  }
  const byParam = new Map();
  const skipped = [];
  for (const [key, def] of Object.entries(map.controls)) {
    const section = CONTROLS[key]?.section;
    if (!allowed.has(section) || !(key in values)) continue;
    if (!sectionActive(map, section, paramsByName)) { skipped.push(key); continue; }
    // A fixed control (a band that is always a shelf): nothing to set; anything else can't be
    if (def.fixed !== undefined) { if (values[key] !== def.fixed) skipped.push(key); continue; }
    if (def.graphic || def.flex) continue;   // planned with the graphic / flexible bands below
    const list = byParam.get(def.param) ?? [];
    list.push(key);
    byParam.set(def.param, list);
  }

  const writes = [];
  for (const [paramName, keys] of byParam) {
    const param = paramsByName.get(paramName);
    if (!param) { skipped.push(...keys); continue; }
    let key = keys[0];
    let value = values[key];
    if (keys.length > 1) {
      // shared switch: on if any is on
      const on = keys.find((k) => values[k] === 'on');
      if (on) { key = on; value = 'on'; }
    }
    const def = map.controls[key];
    if (def.enable) {
      // A filter with its own on switch: 'off' turns the switch off and leaves the knob alone.
      // A band with its own in switch (offValue 0): 0 dB takes the band out.
      const sw = (label) => switchNorm(map, def.enable, paramsByName.get(def.enable.param), tables, label);
      if (value === (def.enable.offValue ?? 'off')) {
        const n = sw(def.enable.off);
        if (n == null) skipped.push(...keys);
        else writes.push({ param: def.enable.param, key, normalized: n });
        continue;
      }
      const plan = planControl(map, key, param, tables?.[paramName], value);
      const n = sw(def.enable.on);
      if (plan && n != null) writes.push({ param: paramName, key, ...plan }, { param: def.enable.param, normalized: n });
      else skipped.push(...keys);
      continue;
    }
    if (def.range && isNum(value)) {
      // A range switch (x3, /3, X10): the plain range if the value fits, else the switched one
      const plan = planRanged(map, key, paramsByName, tables, value);
      if (plan) writes.push(...plan.map((w) => (w.param === paramName ? { key, ...w } : w)));
      else skipped.push(...keys);
      continue;
    }
    const plan = planControl(map, key, param, tables?.[paramName], value);
    if (plan) writes.push({ param: paramName, key, ...plan });
    else skipped.push(...keys);
  }
  if (map.graphic && allowed.has('eq') && sectionActive(map, 'eq', paramsByName)) {
    writes.push(...planGraphic(map.graphic, paramsByName, values));
  }
  if (map.flex && allowed.has('eq') && sectionActive(map, 'eq', paramsByName)) {
    const f = planFlex(map.flex, paramsByName, tables, values);
    writes.push(...f.writes);
    skipped.push(...f.skipped);
  }
  // Set to the nearest end: keep the exact value remembered for a strip that can take it
  const nearest = writes.filter((w) => w.nearest).map((w) => w.key);
  return { writes, skipped, nearest, held: [...new Set([...skipped, ...overridden, ...nearest])] };
}

/**
 * Merge what a strip reads now into what the track remembers. A control in `held` never
 * really reached that strip, so its reading is the strip's stand-in, not the user's value:
 * keep the remembered one, unless the reading changed since the swap (the user moved it).
 */
export function mergeRemembered(remembered, read, held = [], heldAt = {}) {
  const out = { ...remembered };
  for (const [k, v] of Object.entries(read)) {
    const standIn = held.includes(k) && k in remembered && (!(k in heldAt) || near(v, heldAt[k]));
    if (!standIn) out[k] = v;
  }
  return out;
}
