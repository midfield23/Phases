# Phases: channel strip, EQ and compressor favourites for LUNA (prototype)

Swap the channel strip on a LUNA track for another one and carry the settings across.

## Setup

Needs your built SDK clone (`git clone … && npm install` in `~/luna-builder-sdk`).
Elsewhere? `export LUNA_SDK=/path/to/luna-builder-sdk`. Nothing to install here.

```sh
npm test                     # offline tests of the conversion logic
```

## How it works

| | Read outgoing strip | Write incoming strip |
|---|---|---|
| UA plugins (`"mode": "real"`) | `real` (Hz, dB, s, ratio), checked against the display | write `real`; stepped knobs snap to the nearest step |
| Others (`"mode": "table"`) | 0–1 position → measured table → units | units → table → 0–1 position |

Both sides speak the shared control list in `lib/controls.mjs`, which matches Rea-Sixty's
UC1 / SSL-Link control numbers (linkIdx). A value a strip can't represent is left at its
default, unless it misses a knob's range by no more than 10% of its travel (or 1 dB): then it goes to that end; a control a strip doesn't have is remembered per track and comes back later.

## Workflow

1. **Map the plugin.** `maps/<plugin id>.json`. Two are done: API Vision (real) and SSL 4K E
   (table). To start from your Rea-Sixty maps: `node tools/import-reasixty.mjs <user_plugins.json>`
   → `maps/drafts/`, then fill in the TODOs and move the file up into `maps/`.
2. **Table-mode plugins: measure once** (scratch session, plugin on a track):
   `node tools/build-table.mjs --track Probe --plugin S4KE`
   It prints every switch label it finds. If it says FIX THE MAP, correct the map's `states`.
   **Real-mode plugins: record the knob ends once** (same kind of session):
   `node tools/measure-ends.mjs --track Probe --plugin API`
   Writes `"ends"` into the map, so a value just past a knob's range goes to the nearer end
   without the panel searching for it during a swap.
3. **List favourites** in `favorites.json`: `eq` and `dyn` (compressor) lists, in cycle order.
   An older single `cs` list is used for both.
4. **Swap:**
   ```sh
   node tools/swap.mjs --track Vox --dry          # show what would carry
   node tools/swap.mjs --track Vox                # next favourite
   node tools/swap.mjs --track Vox --prev
   node tools/swap.mjs --track Vox --to S4KE
   node tools/swap.mjs --track Vox --mode own     # each strip comes back as you left it
   node tools/swap.mjs --track Vox --row comp     # the Compressor row (default: the EQ row)
   node tools/swap.mjs --track Vox --insert       # no strip yet: add the first favourite to an empty slot
   node tools/swap.mjs --track Vox --compare S4KE # load it alongside (A/B); then --flip, --keep a / --keep b
   ```

## The LUNA panel

A LUNA add-on that does all of this with the mouse, in the side panel next to the Mixer and
Timeline (or in its own window). It follows the selected track.

```sh
node tools/build-addon.mjs                              # assemble ./addon from lib/, maps/, tables/, favorites.json
node ~/luna-builder-sdk/dist/cli.js install addon      # once: links ./addon into LUNA's Add Ons
```

Then in LUNA: the Add Ons menu → Phases. Re-run `build-addon` after measuring a table,
adding a map or editing favorites.json, then close and reopen the panel.

Two rows, each with its own insert, favourites and A/B: **EQ** (EQ and filters) and
**Compressor** (compressor and gate). Each row remembers its own settings, trims included.

- Click a favourite to switch that row to it; ‹ › step through the row's favourites. The arrow
  keys step the selected row (↑/↓ or click a row's title to select it).
- A channel strip can serve both rows from one insert. If the other row already has a plugin of
  its own, the strip's section for that row is switched off (its EQ and filters, or its
  compressor and gate). Swapping a strip out for an EQ-only plugin keeps its compressor settings
  for the Compressor row, which is then empty until you pick one.
- ⇄ loads that plugin next to the current one with your settings copied, and you hear it (B).
  Flip A/B switches instantly; Keep A or Keep B ends the comparison. Comparing EQs on a strip
  that also compresses switches only the strip's EQ, so the compression stays in.
- On switch: copy my settings, or each plugin as you left it.
- Remembered values are saved in the session, per track. The Terminal tools keep theirs in
  `.state/`, so the two don't share memory.

## Known limits

- A swap is **two undo steps** (load plugin, then values). LUNA holds its updates inside a grouped
  edit, so the new plugin's controls can't be waited for within one.
- SSL 4K E switch labels are confirmed (table built 2026-11-22). New table-mode maps: build-table checks their labels.
- The panel hasn't been run inside LUNA yet; the engine is tested against a stand-in for LUNA (`npm test`).
- A compare uses a free insert slot until you keep one.
- Bus compressors aren't covered yet (Rea-Sixty numbers them separately).
- Rea-Sixty drafts: the API Vision map sends HF/HMF EQ controls to the filter knobs, and the
  Model N map swaps its filters and points gate controls at compressor knobs. The importer flags
  these as CHECK notes.
