/**
 * The shared control list every map speaks.
 *
 * Keys are ours; `link` is the matching Rea-Sixty / SSL-Link control index (linkIdx in
 * user_plugins.json), worked out by comparing the AMEK 9099, Focusrite SC, Model N, Neve
 * 1073 and API Vision maps. Controls without a `link` are ones Rea-Sixty carries by
 * meaning (switches, types) rather than through a UC1 pot.
 *
 * Values travel in base units: Hz, dB, seconds, ratio (x:1), percent. Special values:
 *   'off'      a filter switched out / parked fully open
 *   Infinity   a ratio at limit / infinity
 * Switches and choices travel as the strings listed in `states`.
 */
export const CONTROLS = {
  // I/O — always carried (like Rea-Sixty's input trim / polarity)
  in_trim:      { link: 4,  section: 'io',   unit: 'dB' },
  out:          { link: 1,  section: 'io',   unit: 'dB' },
  polarity:     {           section: 'io',   states: ['off', 'on'] },
  dyn_pre_eq:   {           section: 'io',   states: ['off', 'on'] },

  // Filters ride with the EQ, as on an SSL strip
  filters_in:   {           section: 'eq',   states: ['off', 'on'] },
  hpf:          { link: 7,  section: 'eq',   unit: 'Hz', filter: 'hp' },
  lpf:          { link: 6,  section: 'eq',   unit: 'Hz', filter: 'lp' },

  // EQ
  eq_in:        { link: 15, section: 'eq',   states: ['off', 'on'] },
  hf_gain:      { link: 9,  section: 'eq',   unit: 'dB' },
  hf_freq:      { link: 10, section: 'eq',   unit: 'Hz' },
  hf_type:      {           section: 'eq',   states: ['shelf', 'bell'] },
  hmf_gain:     { link: 11, section: 'eq',   unit: 'dB' },
  hmf_freq:     { link: 12, section: 'eq',   unit: 'Hz' },
  hmf_q:        { link: 13, section: 'eq',   unit: 'Q' },
  lmf_gain:     { link: 16, section: 'eq',   unit: 'dB' },
  lmf_freq:     { link: 17, section: 'eq',   unit: 'Hz' },
  lmf_q:        { link: 18, section: 'eq',   unit: 'Q' },
  lf_freq:      { link: 19, section: 'eq',   unit: 'Hz' },
  lf_gain:      { link: 20, section: 'eq',   unit: 'dB' },
  lf_type:      {           section: 'eq',   states: ['shelf', 'bell'] },

  // Compressor
  comp_in:      { link: 22, section: 'dyn',  states: ['off', 'on'] },
  comp_ratio:   { link: 26, section: 'dyn',  unit: 'ratio' },
  comp_thresh:  { link: 27, section: 'dyn',  unit: 'dB' },
  comp_release: { link: 28, section: 'dyn',  unit: 's' },
  comp_fast:    {           section: 'dyn',  states: ['off', 'on'] },
  comp_mix:     {           section: 'dyn',  unit: '%' },
  comp_attack:  {           section: 'dyn',  unit: 's' },

  // Knobs that only mean the same thing within one family of compressors (positions, or
  // drive levels on one gain structure). They carry between members of the family and are
  // kept for later on anything else.
  fet_input:    {           section: 'dyn',  unit: 'dB' },   // 1176 FET, 1176AE, 1176LN Rev E
  fet_output:   {           section: 'dyn',  unit: 'dB' },
  fet_attack:   {           section: 'dyn' },                // knob positions 1-7 (7 fastest)
  fet_release:  {           section: 'dyn' },
  vm_input:     {           section: 'dyn',  unit: 'dB' },   // 175-B, 176
  vm_output:    {           section: 'dyn',  unit: 'dB' },
  vm_attack:    {           section: 'dyn' },                // knob positions 1-7
  vm_release:   {           section: 'dyn' },
  opto_reduction: {         section: 'dyn' },                // LA-2, LA-2A Gray/Silver/Tube: knob positions 0-100
  opto_gain:    {           section: 'dyn' },
  opto_mode:    {           section: 'dyn' },                // 'comp' | 'limit': LA-2A family and LA-3A
  fc_thresh:    {           section: 'dyn' },                // Fairchild 660, 670: threshold knob 0-10
  fc_time:      {           section: 'dyn' },                // time constant 1-6
  sh_opt_thresh:  {         section: 'dyn' },                // Shadow Hills (Class A, Mastering): optical and discrete stage knob positions
  sh_opt_gain:    {         section: 'dyn' },
  sh_disc_thresh: {         section: 'dyn' },
  sh_disc_gain:   {         section: 'dyn' },
  dl_crush:     {           section: 'dyn' },                // Devil-Loc, Devil-Loc Deluxe: knob positions
  dl_crunch:    {           section: 'dyn' },

  // Gate / expander
  gate_in:      {           section: 'gate', states: ['off', 'on'] },
  gate_range:   { link: 29, section: 'gate', unit: 'dB' },
  gate_thresh:  { link: 30, section: 'gate', unit: 'dB' },
  gate_release: { link: 31, section: 'gate', unit: 's' },
  gate_hold:    { link: 32, section: 'gate', unit: 's' },
  gate_exp:     { link: 33, section: 'gate', states: ['gate', 'expander'] },
  gate_fast:    {           section: 'gate', states: ['off', 'on'] },
};

export const SECTIONS = ['io', 'eq', 'dyn', 'gate'];

/** linkIdx -> control key, for importing Rea-Sixty maps. */
export const BY_LINK = Object.fromEntries(
  Object.entries(CONTROLS).filter(([, c]) => c.link != null).map(([k, c]) => [c.link, k]),
);
