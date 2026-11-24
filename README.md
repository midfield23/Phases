<p align="center"><img src="addon-src/icon.png" width="128" alt="Phases icon: a waxing crescent moon"></p>

# Phases

**EQ and compressor favourites for LUNA.** Switch a track's EQ or compressor to another plugin, and your settings come with it.

Phases is a LUNA add-on that brings Rea-Sixty's Favourites workflow from REAPER to LUNA. Pick a short list of EQs and compressors you like, then flip a track between them to hear which one suits it. Gain, frequency, threshold, ratio, attack, release and so on are carried across, so you don't have to dial each plugin in again.

## Install

**[Download the latest release](https://github.com/midfield23/Phases/releases/latest)**, then double-click `Phases-v0.1.1.lunaaddon`. LUNA installs it.

In LUNA, open **Add Ons → Phases**. It opens in the side panel next to the Mixer and Timeline, or in its own window.

Requires LUNA 3.1.2 or later.

## Using it

Phases follows the selected track. It has two rows:

- **EQ** for EQs and filters
- **Compressor** for compressors and gates

Each row has its own insert, its own favourites and its own A/B.

- **Switch:** click a favourite, or step through the row with ‹ ›. The arrow keys step the selected row. Use ↑/↓ or click a row's title to select it.
- **Compare:** ⇄ loads a plugin next to the current one with your settings copied, and you hear it as B. **Flip** switches between A and B instantly. **Keep A** or **Keep B** ends the comparison.
- **Copy or Own:** choose whether a switch copies your settings to the new plugin, or brings each plugin back the way you last left it.
- **Channel strips:** a strip such as an SSL or API strip can serve both rows from one insert. If the other row already has a plugin of its own, Phases switches off that section of the strip, so nothing doubles up. Swap a strip out for an EQ-only plugin and its compressor settings are kept for the Compressor row.
- **Nothing gets lost:** if the new plugin lacks a control, say a high-pass filter, Phases remembers the value for that track and puts it back when you switch to a plugin that has one. Remembered values are saved with the session.

## Supported plugins

72 plugins are mapped, including UAD (1176s, LA-2As, Pultecs, Neve 1073, API and SSL strips, Fairchilds, Manley and more), SSL Native, Brainworx, FabFilter, Soundtoys, Klanghelm, Tokyo Dawn Labs, Harrison, Sonimus and others. See [`maps/`](maps) for the full list.

To pick your favourites, edit `favorites.json` and rebuild (see [Building from source](#building-from-source)). Want a plugin added? [Open an issue](https://github.com/midfield23/Phases/issues).

## How it works

Every plugin has a map in `maps/` that ties its knobs to a shared list of controls (EQ bands, filters, threshold, ratio, attack, release, makeup and so on). The list lives in `lib/controls.mjs` and uses the same control numbers as Rea-Sixty and SSL 360 Link (UC1), so existing Rea-Sixty maps can be imported.

| | Reading the outgoing plugin | Writing the incoming plugin |
|---|---|---|
| UA plugins (`"mode": "real"`) | Real units (Hz, dB, s, ratio), checked against the display | Real units; stepped knobs snap to the nearest step |
| Other plugins (`"mode": "table"`) | 0–1 knob position → measured table → units | Units → table → 0–1 knob position |

Third-party plugins only report a 0–1 knob position, so each one is measured once. A tool sweeps every knob and records what the plugin displays, and Phases converts through that table in both directions.

A value the new plugin can't reach stays at the default, unless it misses the knob's range by no more than 10% of its travel (or 1 dB). Then the knob goes to the end of its range.

## Building from source

You need Node 22 or later and a built clone of [UA's LUNA Builder SDK](https://github.com/uaudio-labs/luna-builder-sdk) in `~/luna-builder-sdk`. Run `git clone` and then `npm install` there. If the SDK is somewhere else, set `export LUNA_SDK=/path/to/luna-builder-sdk`.

```sh
npm test                                              # offline tests of the conversion logic
node tools/build-addon.mjs                            # assemble ./addon from lib/, maps/, tables/, favorites.json
node ~/luna-builder-sdk/dist/cli.js install addon     # once: links ./addon into LUNA's Add Ons
```

Re-run `build-addon` after you measure a table, add a map or edit `favorites.json`, then close and reopen the panel.

### Adding a plugin

1. **Map it** in `maps/<plugin id>.json`. To start from your Rea-Sixty maps, run
   `node tools/import-reasixty.mjs <user_plugins.json>`. The drafts go to `maps/drafts/`. Fill in the TODOs, then move each file up into `maps/`.
2. **Measure it once.** Use a scratch session with the plugin on a track.
   - Table-mode plugins: `node tools/build-table.mjs --track Probe --plugin S4KE`
     prints every switch label it finds. If it says FIX THE MAP, correct the map's `states`.
   - Real-mode plugins: `node tools/measure-ends.mjs --track Probe --plugin API`
     records the ends of each knob's range in the map's `"ends"`, so a value just past a knob's range goes to the nearer end without a search during a swap.
3. **Add it to your favourites** in `favorites.json`. The `eq` and `dyn` (compressor) lists are in cycle order. An older single `cs` list is used for both rows.

### Command-line swaps

Everything the panel does is also available from the Terminal:

```sh
node tools/swap.mjs --track Vox --dry          # show what would carry
node tools/swap.mjs --track Vox                # next favourite
node tools/swap.mjs --track Vox --prev
node tools/swap.mjs --track Vox --to S4KE
node tools/swap.mjs --track Vox --mode own     # each plugin comes back as you left it
node tools/swap.mjs --track Vox --row comp     # the Compressor row (default: the EQ row)
node tools/swap.mjs --track Vox --insert       # no plugin yet: add the first favourite to an empty slot
node tools/swap.mjs --track Vox --compare S4KE # load it alongside (A/B); then --flip, --keep a / --keep b
```

The Terminal tools keep remembered values in `.state/`, separate from the panel's.

## Known limits

- A swap is **two undo steps**: one for loading the plugin, one for setting the values. LUNA groups its updates inside an edit, so Phases can't wait for the new plugin's controls within a single step.
- A compare uses a free insert slot until you keep one.
- Bus compressors aren't covered yet. Rea-Sixty numbers them separately.
- Imported Rea-Sixty drafts: the API Vision map sends the HF/HMF EQ controls to the filter knobs, and the Model N map swaps its filters and points the gate controls at compressor knobs. The importer marks these with CHECK notes.

## Credits

Inspired by Rea-Sixty and its Favourites feature. Built with [UA's LUNA Builder SDK](https://github.com/uaudio-labs/luna-builder-sdk). Made by John Mulholland at [Tobacco Road Studios](https://tobaccoroadstudios.com).
