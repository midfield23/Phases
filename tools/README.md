# LUNA strip favourites (prototype)

Swap the channel strip on a LUNA track for another one and carry the settings across, the way
Rea-Sixty's Favourites does in REAPER. Command-line tools for now; the logic is meant to move
into a LUNA add-on panel once it holds up.

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
default; a control a strip doesn't have is remembered per track and comes back later.

## Workflow

1. **Map the plugin.** `maps/<plugin id>.json`. Two are done: API Vision (real) and SSL 4K E
   (table). To start from your Rea-Sixty maps: `node tools/import-reasixty.mjs <user_plugins.json>`
   → `maps/drafts/`, then fill in the TODOs and move the file up into `maps/`.
2. **Table-mode plugins: measure once** (scratch session, plugin on a track):
   `node tools/build-table.mjs --track Probe --plugin S4KE`
   It prints every switch label it finds. If it says FIX THE MAP, correct the map's `states`.
3. **List favourites** in `favorites.json` (`cs`, in cycle order).
4. **Swap:**
   ```sh
   node tools/swap.mjs --track Vox --dry          # show what would carry
   node tools/swap.mjs --track Vox                # next favourite
   node tools/swap.mjs --track Vox --prev
   node tools/swap.mjs --track Vox --to S4KE
   node tools/swap.mjs --track Vox --mode own     # each strip comes back as you left it
   node tools/swap.mjs --track Vox --sections eq  # carry EQ only (I/O always carries)
   node tools/swap.mjs --track Vox --insert       # no strip yet: add the first favourite to an empty slot
   ```

## Known limits

- A swap is **two undo steps** (load plugin, then values). LUNA holds its updates inside a grouped
  edit, so the new plugin's controls can't be waited for within one.
- SSL 4K E switch labels are confirmed (table built 2026-11-22). New table-mode maps: build-table checks their labels.
- Remembered values live in `.state/tracks.json` on this machine, not in the session.
- Bus compressors aren't covered yet (Rea-Sixty numbers them separately).
- Rea-Sixty drafts: the API Vision map sends HF/HMF EQ controls to the filter knobs, and the
  Model N map swaps its filters and points gate controls at compressor knobs. The importer flags
  these as CHECK notes.
