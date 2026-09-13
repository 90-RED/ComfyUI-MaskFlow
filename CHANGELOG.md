# Changelog

## 1.0.4

- README: smaller node screenshot and a cleaner title.
- Squashed the repository history.

## 1.0.3

- README: smaller node screenshot, title, and a credit note.

## 1.0.2

- Give the node icon as a full URL, so the registry can display it.

## 1.0.1

- CI: the publish workflow no longer uses the deprecated Node 20 action versions
  (now `actions/checkout@v5` and `actions/setup-python@v6`), so a release run is
  warning-free.

## 1.0.0

First public release. Node defined with the V3 schema (`comfy_api.latest`),
registered through `comfy_entrypoint`.

- Draw or load: one node, two modes (`draw_mask` switch).
- File-versioned mask archive: every capture is written to
  `output/MaskFlow/<source>/vNNNNN.png` and selectable via `use_version`.
- Panel on the node: switches, blur / amount / size fields, live thumbnail,
  countdown, Save / Continue / Cancel.
- Edge blur: feather the mask edge (px radius).
- Edge noise: four grain styles that fill only the soft edge band, with a live
  38×38 preview; click the thumbnail to change style.
- Invert, optional external mask input, `if_no_mask` behaviour.
- Cache signature from the mask file's modification time, so runs are not
  repeated needlessly.
