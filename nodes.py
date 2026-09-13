"""MaskFlow backend: one node, file-versioned masks, graph-derived naming.

Design (v2, simplified)
-----------------------
- SINGLE SOURCE OF TRUTH: the executing prompt graph. When MaskFlow runs, the
  backend reads ComfyUI's own prompt JSON for THIS execution and walks the
  IMAGE input links upstream to the LoadImage node, taking its widget value
  as the archive folder name. No frontend involvement, no timing races.
- Fallbacks, in order: manual `source_name` widget -> graph-derived name ->
  node_id (always unique, never collides).
- Masks are archived as black/white PNGs:
      ComfyUI/output/MaskFlow/<name>/vN.png
- Node definition: the V3 API (comfy_api.latest) - one io.ComfyNode subclass
  registered through comfy_entrypoint in __init__.py.
- Cache: fingerprint_inputs (V3's IS_CHANGED) returns the mtime of the newest
  archived mask (plus the mode/use_version identity). ComfyUI skips the node - and therefore all
  downstream sampling - while nothing changed. "Newest" is NUMERIC (v10 > v9):
  lexicographic sorting silently pinned it to v9 once 10+ versions existed.
  No custom memory cache needed for correctness across restarts.
- Interrupt-safe: the editor wait polls in short slices and calls
  comfy.model_management.throw_exception_if_processing_interrupted(), so
  ComfyUI's own Cancel button stops the run instead of hanging the queue.
- Editor roundtrip: backend waits on a threading.Event in 0.25s slices (so an
  interrupt still cancels); the frontend opens the OFFICIAL MaskEditor
  (clipspace route) and posts the mask the editor uploads
  (clipspace-mask-*.png, mask stored in the alpha channel).
"""

from __future__ import annotations

import base64
import hashlib
from io import BytesIO
import threading
import time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

import comfy.model_management

from comfy_api.latest import ComfyExtension, io  # noqa: F401  (V3 node API)
import folder_paths
import server
from aiohttp import web


class _Submission:
    """One pending editor submission (frontend -> node)."""

    __slots__ = ("event", "payload", "node_id")

    def __init__(self, node_id):
        self.node_id = node_id
        self.event = threading.Event()
        self.payload = None


class _State:
    def __init__(self):
        self.pending: dict[str, _Submission] = {}
        self.lock = threading.Lock()


STATE = _State()

# ---------------------------------------------------------------- endpoints


async def maskflow_submit(request):
    """Frontend posts the drawn mask (PNG blob, base64) here."""
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"error": "bad json"}, status=400)

    node_id = str(body.get("node_id", ""))
    action = body.get("action", "save")  # save | cancel
    if not node_id or node_id not in STATE.pending:
        return web.json_response({"error": "no pending request for this node"}, status=404)

    sub = STATE.pending[node_id]
    sub.payload = {"action": action, "mask_b64": body.get("mask_b64")}
    sub.event.set()
    return web.json_response({"ok": True})


# Routes registered via decorator at import time - the ONLY reliable way.
# ComfyUI creates PromptServer BEFORE importing custom nodes, so
# PromptServer.instance.routes (a RouteTableDef) is live and gets batched
# into the app with all other routes. Identical to cg-image-filter's pattern.
try:
    _routes = server.PromptServer.instance.routes

    @_routes.post("/maskflow/submit")
    async def _submit_route(request):
        return await maskflow_submit(request)

    print("[MaskFlow] routes added to server route table")
except Exception as e:
    print(f"[MaskFlow] route registration failed (server not up yet?): {e}")

def maskflow_root() -> Path:
    return Path(folder_paths.get_output_directory()) / "MaskFlow"


def _safe(name: str) -> str:
    keep = "".join(c if (c.isalnum() or c in "-_ .") else "_" for c in name)
    return (keep or "unknown").strip().rstrip(".")[:120]


def _version_files(folder: Path) -> list[tuple[int, Path]]:
    """Archived masks sorted NUMERICALLY: v10 comes after v9, not after v1.
    Lexicographic sorting made latest_version() return v9 for good once a 10th
    version existed (measured: 27 archived versions resolved to v9)."""
    out = []
    for p in folder.glob("v*.png"):
        digits = p.stem[1:]
        if digits.isdigit():
            out.append((int(digits), p))
    out.sort(key=lambda t: t[0])
    return out


def tensor_to_png_bytes(mask: torch.Tensor) -> bytes:
    """[..., H, W] float 0..1 -> 8-bit grayscale PNG."""
    while mask.ndim > 2:
        mask = mask[0]
    arr = (mask.detach().cpu().numpy().clip(0, 1) * 255).astype(np.uint8)
    img = Image.fromarray(arr, mode="L")
    buf = BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def png_bytes_to_tensor(data: bytes, device=None):
    """Decode a mask PNG. The official editor uploads RGBA PNGs with the mask
    in the ALPHA channel (painted region transparent) -> mask = 1 - alpha
    (same semantics as ComfyUI's LoadImage mask output). Plain grayscale
    (L-mode) masks pass through as-is."""
    img = Image.open(BytesIO(data))
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        # Any RGBA upload is the editor's composite: the mask lives in the ALPHA
        # channel (painted = transparent) -> mask = 1 - alpha, ALWAYS. The old
        # "uniformly opaque alpha means a luminance mask" fallback was dangerous:
        # an editor save with nothing painted is fully opaque, so it turned the
        # SOURCE IMAGE's brightness into a mask. An empty upload = an empty mask.
        arr = np.asarray(img.convert("RGBA"), dtype=np.float32)
        alpha = arr[..., 3] / 255.0
        if alpha.min() > 0.99:
            print("[MaskFlow] uploaded mask has no painted pixels (alpha fully opaque) -> blank mask")
        mask = 1.0 - alpha
    else:
        # Plain L-mode PNG: the format this node itself archives.
        mask = np.asarray(img.convert("L"), dtype=np.float32) / 255.0
    t = torch.from_numpy(np.ascontiguousarray(mask))
    return t.to(device) if device is not None else t


def save_version(mask: torch.Tensor, source_name: str) -> Path:
    folder = maskflow_root() / _safe(source_name)
    folder.mkdir(parents=True, exist_ok=True)
    existing = _version_files(folder)
    n = (existing[-1][0] + 1) if existing else 1  # max+1: never reuse a deleted number
    # 5-digit zero pad: v00001. Fixed width makes plain lexicographic order equal
    # numeric order, so the folder sorts correctly in any file browser too. Old
    # unpadded files (v1..v30) keep working - _version_files() sorts numerically
    # and max+1 continues the same sequence (v30 -> v00031).
    path = folder / f"v{n:05d}.png"
    path.write_bytes(tensor_to_png_bytes(mask))
    return path


def latest_version(source_name: str) -> Path | None:
    """Newest archived version, ordered NUMERICALLY (v10 > v9)."""
    folder = maskflow_root() / _safe(source_name)
    if not folder.is_dir():
        return None
    versions = _version_files(folder)
    return versions[-1][1] if versions else None


def latest_mask_tensor(source_name: str, device=None, look_back: int = 10):
    """Newest archived mask that actually HAS painted pixels, as a [H, W] tensor.

    Blank versions are skipped (walking back up to `look_back` files): a countdown
    auto-save on an untouched editor can archive an empty mask, and "continue
    drawing" must restore what the user really drew, not the newest empty file."""
    files = _version_files(maskflow_root() / _safe(source_name))
    for _n, p in reversed(files[-look_back:] if look_back else files):
        try:
            t = png_bytes_to_tensor(p.read_bytes(), device=device)
        except Exception as e:
            print(f"[MaskFlow] could not read archived mask {p}: {e}")
            continue
        if float(t.max()) > 0.0:
            return t
    return None


def newest_archive() -> Path | None:
    """Newest archived mask file across ALL source folders (or None).

    IS_CHANGED cannot resolve the source name (see MaskFlow.IS_CHANGED), so
    it watches whatever mask was saved last: an idle queue keeps the signature
    stable, a fresh save invalidates it."""
    root = maskflow_root()
    if not root.is_dir():
        return None
    newest, newest_t = None, -1.0
    for sub in root.iterdir():
        if not sub.is_dir():
            continue
        for _n, p in _version_files(sub):
            try:
                t = p.stat().st_mtime
            except OSError:
                continue
            if t > newest_t:
                newest_t, newest = t, p
    return newest


def gaussian_blur_mask(mask: torch.Tensor, radius: int) -> torch.Tensor:
    if radius <= 0:
        return mask
    k = radius * 2 + 1
    sigma = max(radius / 2.0, 0.6)
    ax = torch.arange(k, dtype=torch.float32, device=mask.device) - radius
    g = torch.exp(-(ax**2) / (2 * sigma**2))
    g = g / g.sum()
    # Two 1D passes instead of one k*k kernel (at radius 50: 2*101 taps instead
    # of 101*101), with replicate padding so the mask edge is not darkened at the
    # image border (zero padding pulled border values toward 0).
    orig = mask.shape
    m = mask.reshape(1, 1, orig[-2], orig[-1])
    m = torch.nn.functional.pad(m, (radius, radius, radius, radius), mode="replicate")
    m = torch.nn.functional.conv2d(m, g.view(1, 1, k, 1))
    m = torch.nn.functional.conv2d(m, g.view(1, 1, 1, k))
    return m.reshape(orig)


# ---- noise (soft-edge treatment) -----------------------------------------
# All mono/grayscale: the target is a MASK, not a picture, so a chroma variant
# would be meaningless here. `size_px` = grain blob size (same unit as the blur
# radius). WHERE the noise lands is NOT a setting: the weight is the mask's own
# soft band (see edge_noise_weight), so the noise simply follows the Edge blur
# and fills the whole blurred edge.

NOISE_KINDS = ["film grain", "shadow grain", "digital grain", "cloud fbm"]

# Fraction of the soft band at each end where the noise amplitude tapers to 0.
# 0.10 = full noise across the central 80% of the blurred edge, so a wide soft
# edge gets a wide grainy band instead of one thin line down its middle.
EDGE_NOISE_TAPER = 0.10


def _unit_noise(h: int, w: int, size_px: float, seed: int, blocky: bool = False) -> torch.Tensor:
    """Zero-mean unit-variance noise field at `size_px`-sized blobs. Generated at
    a reduced resolution and upsampled: that IS the grain-size control."""
    gen = torch.Generator(device="cpu")
    gen.manual_seed(int(seed) % (2**31))
    ch = max(2, int(round(h / max(1.0, float(size_px)))))
    cw = max(2, int(round(w / max(1.0, float(size_px)))))
    n = torch.randn((1, 1, ch, cw), generator=gen)
    mode = "nearest" if blocky else "bilinear"
    kw = {} if blocky else {"align_corners": False}
    n = torch.nn.functional.interpolate(n, size=(h, w), mode=mode, **kw)[0, 0]
    s = float(n.std())
    if s > 1e-6:
        n = (n - n.mean()) / s
    return n


def _fbm_noise(h: int, w: int, size_px: float, seed: int, octaves: int = 4) -> torch.Tensor:
    """Multi-octave (fractal) cloud noise - the coarsest octave spans ~4x size_px."""
    total = torch.zeros((h, w))
    amp, norm, s = 1.0, 0.0, max(2.0, float(size_px) * 4.0)
    for i in range(octaves):
        total += amp * _unit_noise(h, w, s, seed + 1013 * i)
        norm += amp
        amp *= 0.5
        s = max(1.0, s * 0.5)
    total = total / max(norm, 1e-6)
    st = float(total.std())
    if st > 1e-6:
        total = (total - total.mean()) / st
    return total


def edge_noise_weight(mask: torch.Tensor) -> torch.Tensor:
    """WHERE the noise is allowed - derived from the mask itself, NO setting.

    A PLATEAU across the mask's soft (blurred) band, not a spike: full strength
    wherever the mask sits away from the flat ends and a short taper only in the
    outer EDGE_NOISE_TAPER of the band. The old tent profile (1 - |2m - 1|)
    peaked in the middle of the band and fell off fast, so a wide blurred edge
    showed the grain as a single thin line along its centre - the noise has to
    fill the whole soft edge instead.

    A hard mask (blur = 0, values only 0/1) has min(m, 1-m) == 0 everywhere, so
    it still gets no noise: the grain simply follows the blur.
    """
    near = torch.minimum(mask, 1.0 - mask)
    return (near / EDGE_NOISE_TAPER).clamp(0.0, 1.0)


def apply_mask_noise(mask: torch.Tensor, kind: str, amount: int,
                     size_px: int, noise_blur: int, seed: int = 0) -> torch.Tensor:
    """Perturb the mask along its soft (blurred) edge so the transition reads
    organic instead of ruler-straight. Deterministic: same seed + same
    settings + same image = same mask, so the execution cache stays useful."""
    if kind not in NOISE_KINDS or float(amount) <= 0:
        return mask
    weight = edge_noise_weight(mask)
    if float(weight.max()) <= 0.0:
        return mask  # hard mask, no transition anywhere -> nothing to roughen
    h, w = mask.shape[-2], mask.shape[-1]
    if kind == "cloud fbm":
        field = _fbm_noise(h, w, float(size_px), seed)
    elif kind == "digital grain":
        field = _unit_noise(h, w, float(size_px), seed, blocky=True)  # blocky clumps
    else:  # film grain / shadow grain: smooth blend of blobs
        field = _unit_noise(h, w, float(size_px), seed)
    if noise_blur > 0:
        field = gaussian_blur_mask(field, int(noise_blur))
        s = float(field.std())
        if s > 1e-6:
            field = field / s  # keep the strength independent of the blur amount
    if kind == "shadow grain":
        # film look: grain lives on the dark side of the transition
        weight = weight * (1.0 - mask)
    amp = (amount / 100.0) * 0.5
    return (mask + field.to(mask.device) * weight * amp).clamp(0.0, 1.0)


def image_hash(img: torch.Tensor) -> str:
    h = hashlib.sha256()
    h.update(str(tuple(img.shape)).encode())
    h.update(img.detach().cpu().numpy().tobytes())
    return h.hexdigest()


# ---- graph-derived source name: walk the executing prompt's IMAGE link ----
# up to the LoadImage node. Called by _resolve_name() with the hidden PROMPT.


def _walk_to_loadimage(graph: dict, node: dict, input_name: str, seen=None) -> str | None:
    """node['inputs'] maps input names to either widgets or links
    '[origin_node_id, origin_slot]' (old format) or nested dicts."""
    if seen is None:
        seen = set()
    inputs = node.get("inputs", {})
    for iname, ival in inputs.items():
        if isinstance(ival, list) and len(ival) == 2:
            origin_id, _slot = ival
            if str(origin_id) in seen:
                continue
            seen.add(str(origin_id))
            upstream = graph.get(str(origin_id))
            if not upstream:
                continue
            ctype = upstream.get("class_type", "")
            if ctype == "LoadImage":
                wv = upstream.get("inputs", {}).get("image", "")
                if wv:
                    return str(wv).rsplit(".", 1)[0]
            # keep walking through image-passing nodes
            if ctype.endswith("Image") or "image" in " ".join(upstream.get("inputs", {}).keys()).lower():
                found = _walk_to_loadimage(graph, upstream, iname, seen)
                if found:
                    return found
        elif isinstance(ival, dict) and "link" in str(ival):
            # v3 nested format - handle gracefully
            pass
    return None


# ---------------------------------------------------------------- node


class MaskFlow(io.ComfyNode):
    """Draw or load a mask for one image and shape its edge.

    V3 node definition (comfy_api.latest): the schema below is what ComfyUI
    turns into this node's inputs, widgets and outputs. The class-level
    `hidden` holder carries UNIQUE_ID / PROMPT / EXTRA_PNGINFO at execution
    time (ComfyUI fills it in for both `execute` and `fingerprint_inputs`).
    """

    @classmethod
    def define_schema(cls) -> io.Schema:
        # Chronological order, NEWEST LAST, with 'latest' at the very end: the
        # combo's little arrows step one entry at a time and STOP at the first
        # entry, so a leading 'latest' (the default value) left the left arrow
        # with nowhere to go - you could not step back into the archive. With
        # 'latest' last, left goes to the newest archived version and on back
        # through history. The list refreshes whenever ComfyUI rebuilds node
        # definitions (F5), so freshly saved versions appear.
        archived = []
        try:
            root = maskflow_root()
            if root.is_dir():
                names = set()
                for sub in root.iterdir():
                    if sub.is_dir():
                        names.update(p.stem for _n, p in _version_files(sub))
                archived = sorted(names, key=lambda s: int(s[1:]))
        except Exception:
            pass
        versions = archived + ["latest"]
        return io.Schema(
            node_id="MaskFlow",
            display_name="MaskFlow",
            category="MaskFlow",
            description=("Draw a mask in ComfyUI's mask editor (or load an archived one), keep "
                         "every capture as a numbered file, and shape the mask edge."),
            hidden=[io.Hidden.unique_id, io.Hidden.prompt, io.Hidden.extra_pnginfo],
            # NOTE: blur / noise_* are declared as real inputs so their values still
            # travel to the backend and into widgets_values; the web extension HIDES
            # the native widgets and drives them from the panel on the node
            # (the frontend skips only widget.serialize === false).
            inputs=[
                io.Image.Input("image"),
                io.Boolean.Input("draw_mask", default=True,
                                 label_on="draw mask (open editor)", label_off="load from output",
                                 tooltip="ON: open the mask editor. OFF: use the newest (or chosen) archived mask, no editor"),
                io.Int.Input("countdown_seconds", default=60, min=0, max=3600,
                             tooltip="Editor auto-saves after this many seconds (0 = wait for manual close). Only in draw mode"),
                io.Boolean.Input("invert", default=False,
                                 tooltip="Invert the mask (white <-> black)"),
                io.Boolean.Input("blur_on", default=False, label_on="ON", label_off="OFF",
                                 tooltip="Feather the mask edge. The switch at the front of the Edge Blur row on the node drives this"),
                io.Int.Input("blur", default=5, min=0, max=1000,
                             tooltip="Mask edge feather radius in px (a Photoshop-style blur). 0 = hard edge (and then the noise has no soft band to sit on)"),
                io.Boolean.Input("noise_on", default=False, label_on="ON", label_off="OFF",
                                 tooltip="Apply the edge noise. The switch at the front of the noise row on the node drives this"),
                io.Combo.Input("noise_kind", options=NOISE_KINDS, default="film grain",
                               tooltip="Edge-noise style (grayscale - this is a mask). Click the thumbnail on the node to switch style. The grain fills the soft (blurred) edge and leaves the flat areas alone"),
                io.Int.Input("noise_amount", default=50, min=0, max=100,
                             tooltip="Noise strength / opacity in %"),
                io.Int.Input("noise_size", default=1, min=1, max=200,
                             tooltip="Grain size in px (bigger = coarser blobs)"),
                io.Int.Input("noise_blur", default=0, min=0, max=200,
                             tooltip="Blur applied to the noise itself, in px (softens the grain)"),
                io.Combo.Input("use_version", options=versions, default="latest",
                               tooltip="Which archived mask version to use (load mode). 'latest' = newest"),
                io.String.Input("source_name", default="",
                                tooltip="Archive folder name. EMPTY = auto-derive from the connected LoadImage node. Type a name to override"),
                io.Combo.Input("if_no_mask", options=["send blank", "cancel"], default="send blank"),
                io.Mask.Input("mask", optional=True,
                              tooltip="Optional external mask to start from"),
            ],
            outputs=[io.Image.Output("image"), io.Mask.Output("mask")],
        )

    @classmethod
    def fingerprint_inputs(cls, image=None, draw_mask=True, use_version="latest", source_name="",
                           unique_id=None, **kwargs):
        """Return the archived mask file's path+mtime as the change signature.

        MUST NOT depend on `prompt`. ComfyUI evaluates this hook with CONSTANTS
        ONLY: execution.py calls get_input_data(node["inputs"], class_def, node_id,
        None), so dynprompt is None and the hidden PROMPT arrives as {} - the
        graph-derived source name is simply not available here. Deriving it anyway
        made the lookup fall back to 'node_<id>', find no archive and return NaN,
        and a NaN in a node's signature stops EVERY downstream node (sampler
        included) from ever cache-hitting - the whole workflow re-sampled on each
        queue with nothing changed, even with everything upstream bypassed.
        """
        if unique_id is None:  # V3 hands hidden values over on cls.hidden
            unique_id = getattr(getattr(cls, "hidden", None), "unique_id", None)
        if draw_mask:
            return float("nan")  # draw mode must always run (re-open the editor)

        name = _safe(source_name.strip()) if (source_name or "").strip() else ""
        watched = None
        if name:
            if use_version == "latest":
                watched = latest_version(name)
            else:
                p = maskflow_root() / name / f"{use_version}.png"
                watched = p if p.exists() else None
        if watched is None:
            watched = newest_archive()  # name unknown here: watch the last save
        if watched is None:
            return float("nan")  # nothing archived yet: must run (editor)
        # A plain string, not hash(): Python's str hash is salted per process.
        return f"{watched}:{watched.stat().st_mtime}:{draw_mask}:{use_version}"

    # The defaults here MUST mirror the schema: ComfyUI normally hands execute()
    # the widget values, but a direct/API call falls back to these - and they
    # used to disagree (switches True here, False in the schema).
    @classmethod
    def execute(cls, image, draw_mask=True, countdown_seconds=60, invert=False, blur_on=False, blur=5,
                noise_on=False, noise_kind="film grain", noise_amount=50, noise_size=1, noise_blur=0,
                use_version="latest", source_name="", if_no_mask="send blank",
                mask=None, unique_id=None, prompt=None) -> io.NodeOutput:
        hidden = getattr(cls, "hidden", None)
        if unique_id is None:
            unique_id = getattr(hidden, "unique_id", None)
        if prompt is None:
            prompt = getattr(hidden, "prompt", None)
        node_id = str(unique_id)
        img_hash = image_hash(image)
        # Grab the optional external MASK input before the working variable below
        # shadows the name 'mask'.
        mask_input = mask

        # ---- resolve name (widget override -> graph -> node_id)
        name = _resolve_name(node_id, source_name, prompt, image)

        mask = None
        path = None

        # ---- load from output
        if not draw_mask:
            if use_version == "latest":
                target = latest_version(name)
            else:
                p = maskflow_root() / _safe(name) / f"{use_version}.png"
                target = p if p.exists() else None
            if target is not None:
                mask = png_bytes_to_tensor(target.read_bytes(), device=image.device)
                path = target
                used_version = target.stem
                _publish_info(node_id, name, str(path), tuple(mask.shape), version=used_version)

        # ---- draw mask (or load found nothing)
        if mask is None:
            if not draw_mask and if_no_mask == "cancel":
                print(f"[MaskFlow] no archived mask for '{name}' -> cancelling run")
                raise comfy.model_management.InterruptProcessingException()
            mask = cls._editor_roundtrip(node_id, image, mask_input, countdown_seconds, name)
            if mask is None:
                if if_no_mask == "cancel":
                    print("[MaskFlow] no mask drawn -> cancelling run")
                    raise comfy.model_management.InterruptProcessingException()
                mask = torch.zeros(image.shape[1], image.shape[2], dtype=torch.float32, device=image.device)
                path = None
            elif float(mask.max()) > 0.0:
                path = save_version(mask, name)
                _publish_info(node_id, name, str(path), tuple(mask.shape))
                # notify frontend (info label only; user switches the toggle manually)
                try:
                    server.PromptServer.instance.send_sync("maskflow_saved", {
                        "node_id": node_id,
                    })
                except Exception:
                    pass
            else:
                # An untouched editor (or a blank draw) submits an all-zero mask.
                # Do NOT burn a version number on it: the archive is the user's
                # version history and "continue drawing" reads it back.
                print("[MaskFlow] mask is empty - not archiving a new version")
                _publish_info(node_id, name, "", tuple(mask.shape),
                              version="(empty - not archived)")

        # ---- post-process once
        ih, iw = image.shape[1], image.shape[2]
        h, w = mask.shape[-2], mask.shape[-1]
        if (h, w) != (ih, iw):
            mask = torch.nn.functional.interpolate(
                mask[None, None, ...], size=(ih, iw), mode="nearest-exact")[0, 0]
        if invert:
            mask = 1.0 - mask
        if blur_on and blur > 0:
            mask = gaussian_blur_mask(mask, blur)
            # the separable float32 convolution can overshoot 1.0 by ~1e-7 at a
            # fully-white plateau (kernel row sums 1.00000008); snap it back so a
            # MASK output is always strictly inside [0,1] for downstream nodes
            mask = mask.clamp(0.0, 1.0)
        if noise_on and noise_kind in NOISE_KINDS and noise_amount > 0:
            # the noise follows the blurred edge by itself (no band control):
            # with blur = 0 the mask has no transition, so there is nothing to
            # roughen and apply_mask_noise returns it untouched
            mask = apply_mask_noise(mask, noise_kind, noise_amount,
                                    noise_size, noise_blur, seed=int(img_hash[:8], 16))
        mask = mask.contiguous()
        if mask.ndim == 2:
            mask = mask[None]  # ComfyUI MASK type is [B, H, W]

        # UI-only preview: base image + raw mask as base64 over the websocket.
        # In-memory only. Only in load mode - draw mode uses the built-in
        # node preview (editor flow needs it).
        if not draw_mask:
            _publish_preview(node_id, image[0], mask[0])

        return io.NodeOutput(image, mask)

    # ---- editor interaction ---------------------------------------------

    @classmethod
    def _editor_roundtrip(cls, node_id, image, start_mask, countdown_seconds, source_name):
        sub = _Submission(node_id)
        with STATE.lock:
            STATE.pending[node_id] = sub
        try:
            # The official editor takes its starting mask from the ALPHA channel of
            # the image it loads (frontend 1.51.x/1.52.x: the mask editor loads the
            # image as alpha, mask = 1 - alpha; painted = transparent).
            # So both payloads are composites, not plain images:
            #   image_b64    - source image + the `mask` input (blank when unconnected)
            #   continue_b64 - ... + the newest ARCHIVED mask, i.e. what the user
            #                  drew last time; used by the "Continue drawing" button
            #                  when this session has no capture yet.
            cont_mask = start_mask
            if cont_mask is None:
                cont_mask = latest_mask_tensor(source_name, device=image.device)
            payload = {
                "node_id": node_id,
                "image_b64": _composite_data_url(image[0], start_mask),
                "continue_b64": _composite_data_url(image[0], cont_mask),
                "countdown": int(countdown_seconds),
                "source_name": source_name,
            }
            _push_progress(node_id, payload)
            # Poll in short slices so ComfyUI's own Cancel / interrupt still works:
            # a single long wait() kept the execution queue blocked for the whole
            # timeout because the interrupt flag is only checked between nodes.
            deadline = time.monotonic() + max(600, countdown_seconds + 120)
            got = False
            while True:
                if sub.event.wait(0.25):
                    got = True
                    break
                comfy.model_management.throw_exception_if_processing_interrupted()
                if time.monotonic() >= deadline:
                    print("[MaskFlow] editor wait timed out - continuing without a mask")
                    break
            if not got or sub.payload is None:
                return None
            if sub.payload.get("action") == "cancel":
                # Cancel on the node panel means "cancel the WHOLE run", not just
                # this mask: raise ComfyUI's interrupt instead of falling through
                # to the if_no_mask policy (which would continue with a blank mask).
                print("[MaskFlow] cancel requested -> interrupting the run")
                raise comfy.model_management.InterruptProcessingException()
            if sub.payload.get("action") != "save":
                return None
            data = sub.payload.get("mask_b64")
            if not data:
                return None
            blob = base64.b64decode(data.split(",", 1)[-1])
            return png_bytes_to_tensor(blob, device=image.device)
        finally:
            with STATE.lock:
                STATE.pending.pop(node_id, None)



def _resolve_name(node_id: str, source_name: str, prompt: dict | None, image: torch.Tensor) -> str:
    """widget override -> graph-derived LoadImage name -> node_id."""
    manual = (source_name or "").strip()
    if manual:
        return _safe(manual)
    if prompt:
        node = prompt.get(node_id)
        if node:
            found = _walk_to_loadimage(prompt, node, "image")
            if found:
                return _safe(found)
    return f"node_{node_id}"


# ---- frontend bridge ------------------------------------------------------


def _composite_data_url(image_t: torch.Tensor, mask_t: torch.Tensor | None = None) -> str:
    """Source image with a starting mask baked into the ALPHA channel (painted =
    transparent) - the exact format the official mask editor reads its mask from.
    A None mask means "nothing painted" (fully opaque alpha)."""
    arr = (image_t.detach().cpu().numpy().clip(0, 1) * 255).astype(np.uint8)
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    arr = np.ascontiguousarray(arr[..., :3])
    h, w = arr.shape[:2]
    alpha = np.full((h, w), 255, dtype=np.uint8)
    if mask_t is not None:
        m = mask_t
        while m.ndim > 2:
            m = m[0]
        m = m.detach().cpu().numpy().astype(np.float32)
        if m.shape != (h, w):
            m = torch.nn.functional.interpolate(
                torch.from_numpy(m)[None, None], size=(h, w), mode="nearest-exact")[0, 0].numpy()
        alpha = (255.0 - np.clip(m, 0.0, 1.0) * 255.0).astype(np.uint8)
    buf = BytesIO()
    Image.fromarray(np.dstack([arr, alpha]), mode="RGBA").save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def _push_progress(node_id, payload):
    try:
        server.PromptServer.instance.send_sync("maskflow_open_editor", payload)
    except Exception:
        pass


def _publish_preview(node_id, image_t, mask_t):
    """Send base image + raw mask as base64 PNGs over the websocket.
    In-memory only: nothing touches the temp/ or input/ folders."""
    try:
        def to_b64(t2, color=False):
            arr = t2.cpu().numpy()
            if color:
                arr = (arr * 255.0).clip(0, 255).astype(np.uint8)  # [H,W,3]
                img = Image.fromarray(arr, mode="RGB")
            else:
                arr = (arr * 255.0).clip(0, 255).astype(np.uint8)  # [H,W]
                img = Image.fromarray(arr, mode="L")
            buf = BytesIO()
            img.save(buf, format="PNG")
            return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

        server.PromptServer.instance.send_sync("maskflow_preview", {
            "node_id": node_id,
            "base_b64": to_b64(image_t, color=True),
            "mask_b64": to_b64(mask_t),
        })
    except Exception as e:
        print(f"[MaskFlow] preview skipped: {e}")


def _publish_info(node_id, source_name, path, shape, version="latest"):
    try:
        server.PromptServer.instance.send_sync("maskflow_info", {
            "node_id": node_id, "source": source_name, "path": path,
            "w": int(shape[-1]), "h": int(shape[-2]), "version": version,
        })
    except Exception:
        pass


WEB_DIRECTORY = "./web"
