# Generation source

## Tooling

- Generated in Codex with the built-in Image Generation tool.
- Creative Production board: `c902ae12-5745-4b53-8f75-b7f70246319f`.
- Generation date: 2026-08-19.
- Output status: review art only.

## Prompt lineage

The selected direction was derived from two generated contact sheets:

1. A first 8-character cosy/fighting concept sheet.
2. A second pass that pushed the cosy hub-world versions warmer, softer and
   less combat-ready.

The generated master-sheet prompts then asked for:

- Eight original characters.
- Two paired states per character: cosy/default and fighting.
- Four direction rows: down, left, right, up.
- Three animation columns: idle, walk-1, walk-2.
- Historical request at generation time: identical 32x32 logical cells, fixed
  feet anchors and 24x24 collision compatibility.
- No logos, wallet cues, protocol symbols, financial states, route states,
  balances, or UI text.

The live target was later amended to one universal transparent 64x64 logical
canvas per frame, fixed feet point `(32,56)`, small characters retained through
transparent padding, characters 4 and 7 allowed to occupy more of the canvas,
atlas trimming only when preserving `sourceSize` 64x64 and the fixed pivot, and
the runtime-owned 24x24 gameplay/contact body remaining authoritative. The
runtime keys remain opaque `avatar-1` through `avatar-16`; no size, stance,
feet, wallet, account, protocol, financial or route field is encoded in lobby
traffic.

James approved the final export topology separately from the pixels: sixteen
transparent 192x256 PNG sheets, one for each opaque key, laid out as 3 columns
by 4 rows of 64x64 cells, plus one tagged editable Aseprite source. There is no
mega-atlas. Frames contain no baked shadow pixels; World may draw one
consistent shadow separately. The next art handoff is limited to sixteen
true-resolution idle calibrations, followed by user review before movement
prototypes for characters 1, 4, 6 and 7.

## Reference handling

James provided Chrono Trigger screenshots as style and pixel-resolution
references. They were used only as mood references. No third-party pixels,
characters, outfits, silhouettes, palettes, UI, or map elements were copied or
committed.

The committed files in this folder are generated review artifacts, not
third-party source assets.

## Technical issue

The image model returned RGB PNGs with baked backgrounds even when transparency
was requested. A background-extraction edit attempt failed by redrawing the
sheet onto a dark background. Use `master-sheet-clean-review-v1.png` only as
visual source for manual pixel cleanup or redraw.
