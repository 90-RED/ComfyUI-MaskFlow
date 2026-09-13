/**
 * ComfyUI-MaskFlow frontend (v3)
 *
 * The control panel lives ON THE NODE (a DOM widget), not inside the editor
 * dialog. When draw_mask=ON and the node runs, the backend tells the panel
 * "opening editor"; the panel shows:
 *   - live countdown (editor auto-saves at 0 via clicking the official Save)
 *   - capture status: waiting -> captured (bytes) -> submitted / failed
 *   - a Cancel button (cancels the pending run)
 *
 * Mask capture still uses the window.fetch hook on the official editor's
 * clipspace-mask-*.png upload (observed only; the editor READS BACK the
 * upload so intercepting it corrupts the mask).
 */
import { app, ComfyApp } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const API = {
    submit: (body) => fetch("/maskflow/submit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
};


/* styles injected once */
const _css = document.createElement("style");
_css.textContent = `
/* countdown: text breathes green -> white -> green */
@keyframes maskflowCdBreath { 0%,100% { color:#2ecc71; } 50% { color:#ffffff; } }
.maskflow-cd { animation: maskflowCdBreath 1.6s ease-in-out infinite; }
/* Done (mask captured): the theme ships a rule
   button,.primary.comfyui-button { background-color: var(--primary-bg) !important }
   and CSS animations can NEVER override an !important declaration - that is why
   animating background/color showed nothing. So paint the breathing fill with an
   INSET box-shadow (not overridden) and the glyphs with -webkit-text-fill-color
   (a separate property): green -> white -> green, filled, no glow/radius change. */
@keyframes maskflowDoneBreath {
  0%,100% { box-shadow: inset 0 0 0 999px #27ae60; -webkit-text-fill-color:#ffffff; }
  50%     { box-shadow: inset 0 0 0 999px #ffffff; -webkit-text-fill-color:#1b1b1b; }
}
button.maskflow-ready { animation: maskflowDoneBreath 1.6s ease-in-out infinite; }
@keyframes maskflowBadgeBreath { 0%,100% { border-color: rgba(46,204,113,.95); color: #2ecc71; } 50% { border-color: rgba(255,255,255,.85); color: #fff; } }
.maskflow-cdbadge { position:fixed; top:12px; right:16px; z-index:99999; background:rgba(0,0,0,.75); font:600 15px/1 system-ui,sans-serif; padding:8px 14px; border-radius:8px; border:2px solid rgba(46,204,113,.95); pointer-events:none; animation: maskflowBadgeBreath 1.6s ease-in-out infinite; }
`;
document.head.appendChild(_css);

/* floating countdown badge visible INSIDE the mask editor overlay.
   Shows only the countdown digits (user asked: no extra words). */
let _cdBadge = null;
function cdBadgeShow(seconds) {
    cdBadgeHide();
    _cdBadge = document.createElement("div");
    _cdBadge.className = "maskflow-cdbadge";
    _cdBadge.textContent = `⏱ ${seconds}s`;
    document.body.appendChild(_cdBadge);
}
function cdBadgeSet(seconds) { if (_cdBadge) _cdBadge.textContent = `⏱ ${seconds}s`; }
function cdBadgeHide() { _cdBadge?.remove(); _cdBadge = null; }

/* ---------- official mask editor helpers (1.24 - 1.5x compatible) ---------- */

function editorShowing() {
    const el = document.getElementById("maskEditor");
    if (el && el.style.display !== "none") return true;
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const c of document.querySelectorAll("canvas")) {
        const r = c.getBoundingClientRect();
        if (r.width > vw * 0.6 && r.height > vh * 0.6) {
            if (c.id === "graph-canvas" || c.closest("#graph-canvas-container")) continue;
            return true;
        }
    }
    return false;
}

function editorButtons() {
    // 1.51.x: Save/Cancel are PrimeVue <Button> — Save holds <i class="pi pi-check">,
    // Cancel <i class="pi pi-times">. No stable ids in this frontend.
    const visible = Array.from(document.querySelectorAll("button"))
        .filter(b => b.offsetParent !== null);
    const byIcon = cls => visible.find(b => b.querySelector(`i.${cls}`));
    return {
        save: byIcon("pi-check") || visible.find(b => (b.innerText || "").trim().toLowerCase() === "save"),
        cancel: byIcon("pi-times") || visible.find(b => (b.innerText || "").trim().toLowerCase() === "cancel"),
    };
}

async function uploadTemp(dataUrl, name) {
    const blob = await (await fetch(dataUrl)).blob();
    const fd = new FormData();
    fd.append("image", blob, name);
    fd.append("type", "temp");
    fd.append("overwrite", "true");
    const r = await fetch("/upload/image", { method: "POST", body: fd });
    return r.json();
}

function openOfficialEditor(node, imageDataUrl, maskDataUrl) {
    // cg-image-filter's route: give the NODE an images/imgs list (what
    // copyToClipspace reads), then run the official flow.
    const setup = async () => {
        const up = await uploadTemp(imageDataUrl, `maskflow_${node.id}.png`);
        node.images = [{ type: "temp", subfolder: up.subfolder || "", filename: up.name }];
        node.imgs = [new Image()];
        node.imgs[0].src = api.apiURL(`/view?filename=${encodeURIComponent(up.name)}&type=temp${up.subfolder ? `&subfolder=${up.subfolder}` : ""}`);
        node.imageIndex = 0;
        if (maskDataUrl) {
            const mup = await uploadTemp(maskDataUrl, `maskflow_${node.id}_mask.png`);
            node.images.push({ type: "temp", subfolder: mup.subfolder || "", filename: mup.name });
        }
        ComfyApp.copyToClipspace(node);
        ComfyApp.clipspace_return_node = node;
        ComfyApp.open_maskeditor();
    };
    return setup();
}

/* ---------- mask capture via fetch interception (observe only) ---------- */

let _capturedMask = null;
let _capturedBytes = 0;
let _maskHookInstalled = false;
let _captureListener = null; // called on capture

function installMaskCaptureHook() {
    _capturedMask = null;
    _capturedBytes = 0;
    if (_maskHookInstalled) return;
    _maskHookInstalled = true;
    const origFetch = window.fetch;
    window.fetch = function (input, init) {
        try {
            const url = (typeof input === "string") ? input : (input?.url || "");
            const body = init?.body;
            if (url.includes("/upload/image") && body instanceof FormData) {
                // The editor uploads four layers per Save; only the maskedImage
                // (clipspace-mask-*.png) carries source + mask-in-alpha. Frontend
                // 1.52 appends a Blob WITH a filename (reads back as a File), so
                // match on the NAME rather than on the entry type.
                let cands = [];
                try { cands = body.getAll("image"); } catch (e) { const one = body.get("image"); if (one) cands = [one]; }
                for (const f of cands) {
                    const name = f && f.name ? String(f.name) : "";
                    // The editor names its four layers clipspace-mask-<ts>.png,
                    // -paint-, -painted-, -painted-masked-. Only the "mask" layer is
                    // source+mask-in-alpha (painted* are different composites), so
                    // match loosely on "clipspace" + "mask" and exclude "painted":
                    // a future rename of the timestamp/separator still matches, and
                    // the folder it lands in is irrelevant - we take the bytes.
                    const lower = name.toLowerCase();
                    if (!lower.startsWith("clipspace") || !lower.includes("mask") || lower.includes("painted")) continue;
                    // observe only: the editor READS BACK what it uploads;
                    // intercepting breaks the alpha composite (all-black masks).
                    _capturedBytes = f.size || 0;
                    _captureListener?.(_capturedBytes);
                    f.arrayBuffer().then(buf => {
                        let bin = "";
                        const bytes = new Uint8Array(buf);
                        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
                        _capturedMask = "data:image/png;base64," + btoa(bin);
                        _captureListener?.(-1); // -1 = full capture ready
                    }).catch(err => {
                        console.warn("[MaskFlow] could not read the captured upload:", err);
                    });
                    break;
                }
            }
        } catch (e) { /* ignore */ }
        return origFetch.call(this, input, init);
    };
}

function getCapturedMask() { return _capturedMask; }
function clearCapturedMask() { _capturedMask = null; _capturedBytes = 0; }

/* ---------- ON-NODE control panel (DOM widget) ---------- */
/* Two display modes:
   - IDLE  (draw_mask OFF or run finished): info text only — current source,
           archived version, mask size. No buttons, no countdown.
   - DRAW  (draw_mask ON and editor open): countdown + ✓ Done + ✖ Cancel.
   Both boxes are their own DOM widgets and never overlay the preview: the
   Opacity controls row is parked immediately above the info box (i.e. between
   the preview image at the top and the info box at the bottom). */

let _doneHandler = null; // set while a draw run is waiting for user confirmation
let _backHandler = null; // set while a draw run is waiting: re-open the editor

/* ---- DOM-widget sizing (frontend 1.5x) -----------------------------------
   The node layout engine sizes a DOM widget from the ELEMENT's CSS vars
   (--comfy-widget-min-height / --comfy-widget-max-height / --comfy-widget-height,
   read in DOMWidgetImpl.computeLayoutSize) and falls back to a 50px default when
   they are missing. A 5-line info panel in a too-small slot overflows downward
   and paints over the NEXT widget — that is what put the tint row on top of the
   info box. So: measure the real content and push it into those vars, then
   re-arrange the node.
   IMPORTANT: never set widget.computeSize here. An own computeSize property takes
   precedence in _arrangeWidgets(), the CSS vars are then ignored, and the height
   is frozen at whatever was measured while the element was still detached.
--------------------------------------------------------------------------- */
/* The height of what the panel actually CONTAINS, never the height its container
   gave it. scrollHeight is useless here: the container stretches the element to
   the size we reported, so scrollHeight >= box height, and a panel that gets
   stretched once during a node drag reports the inflated value forever (measured
   live: mode=wide, correct width, panelH=120 for content that needs ~40px - the
   rows then spread apart and every control looks misaligned).
   A grid is measured from its resolved row tracks (with align-content:start the
   rows are content-sized, so the tracks are the truth); anything else from its
   children's own boxes. Both are unscaled document-space numbers, so a zoomed
   canvas cannot corrupt them the way getBoundingClientRect would. */
function mfContentHeight(el) {
    try {
        // An element that is not laid out yet (detached / display:none / width 0
        // during the workflow load) has no usable width: a long unbreakable token
        // like a Windows path then wraps per character, "measuring" hundreds of
        // pixels of text that will need two lines once the node has its real
        // width - the engine believes that number, grows the node to it and never
        // shrinks back. Refuse to report anything at all in that state.
        // 40px, not 0: during a load the info panel was measured at 14px wide, and
        // a long path then wrapped one character per line - a "content height" of
        // 725px for text that needs 30px. The node was grown to it (+80 every
        // arrange) and locked tall. Anything narrower than this is not a layout.
        if ((el.offsetWidth || el.clientWidth || 0) < 40) return 0;
        const cs = getComputedStyle(el);
        if (String(cs.display).indexOf("grid") !== -1) {
            const rows = String(cs.gridTemplateRows || "").trim();
            if (rows && rows !== "none") {
                const parts = rows.split(/\s+/);
                let total = 0;
                for (const part of parts) {
                    const v = parseFloat(part);
                    if (isFinite(v)) total += v;
                }
                const gap = parseFloat(cs.rowGap) || 0;
                total += Math.max(0, parts.length - 1) * gap;
                total += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
                if (total > 0) return total;
            }
        }
        if (el.style && (!el.style.position || el.style.position === "static")) {
            el.style.position = "relative";   // so the children's offsetTop is ours
        }
        let bottom = 0;
        for (const child of Array.from(el.children || [])) {
            const b = (child.offsetTop || 0) + (child.offsetHeight || 0);
            if (b > bottom) bottom = b;
        }
        if (bottom > 0) return bottom + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    } catch (e) { /* fall through */ }
    // Nothing measurable (element not laid out yet): report NOTHING and let the
    // caller's minimum stand. Falling back to scrollHeight here is what stretched
    // a freshly loaded node: an unlaid-out element can report a container-inflated
    // scrollHeight once, the engine then GROWS the node to it (distributeSpace ->
    // setSize) and never shrinks it back, so the node stayed ~1075px tall.
    return 0;
}

function sizeDomBox(node, el, pad = 8, min = 24, widget = null) {
    // The frontend puts a DOM widget inside a floating box sized as
    //     height = computedHeight - 4 - (2*margin - 4),   width = nodeWidth - 2*margin
    // (GraphView.getWidgetBounding), i.e. THE MARGIN IS TAKEN OUT of whatever we
    // report back. Measured on a real node: margin 10, we reported 48 and the
    // element only got 28 - the panel's content then overflowed the box it was
    // given (the user saw "half a row missing"). Report the compensated height so
    // the element ends up exactly as tall as the panel needs.
    const m = (widget && typeof widget.margin === "number") ? widget.margin : 0;
    const apply = () => {
        // ONLY the CONTENT may be measured - never scrollHeight/offsetHeight, both
        // of which include whatever height the container gave the element. The
        // container stretches the element to the size we reported, so any
        // self-measure is a one-way ratchet: one transient stretch during a node
        // drag (or a constant added on top) leaves the panel permanently too tall
        // and its rows spread apart. h = content + 2*margin is the only fixed point
        // that self-heals after a stretch.
        const h = Math.max(mfContentHeight(el), min, pad) + m * 2;
        // Two mechanisms, both set:
        //   frontend >= 1.52 - DOMWidgetImpl.computeLayoutSize() reads
        //     options.getMinHeight/getMaxHeight/getHeight FIRST;
        //   frontend <= 1.51 - it only reads the --comfy-widget-* CSS vars below.
        // Setting both keeps the height right on either version.
        if (widget) {
            const opt = (widget.options = widget.options || {});
            opt.getMinHeight = () => h;
            opt.getMaxHeight = () => h;
            opt.getHeight = () => h;
        }
        updateProcLayout(node);            // clamp + reflow + park, before the arrange
        // ...and before every arrange the engine runs on its own (resize, load,
        // widget changes), so the parked rows never go stale.
        if (!node._maskflowParkHooked && typeof node.arrange === "function") {
            node._maskflowParkHooked = true;
            const origArrange = node.arrange;
            node.arrange = function () {
                updateProcLayout(node);
                return origArrange.apply(this, arguments);
            };
        }
        // Dragging a node's size goes through onResize, NOT necessarily arrange:
        // without this the panel kept the layout it had and a narrowed node
        // clipped the wide panel (the "half row missing" report).
        if (!node._maskflowResizeHooked && typeof node.onResize === "function") {
            node._maskflowResizeHooked = true;
            const origResize = node.onResize;
            node.onResize = function () {
                const r = origResize.apply(this, arguments);
                updateProcLayout(node);
                setTimeout(() => updateProcLayout(node), 60);
                setTimeout(() => updateProcLayout(node), 240);
                return r;
            };
        }
        const cur = parseInt(el.style.getPropertyValue("--comfy-widget-height"), 10) || 0;
        if (h === cur) return;
        el.style.setProperty("--comfy-widget-min-height", `${h}px`);
        el.style.setProperty("--comfy-widget-max-height", `${h}px`);
        el.style.setProperty("--comfy-widget-height", `${h}px`);
        try { node.arrange?.(); } catch (e) { /* ignore */ }
        app.graph.setDirtyCanvas(true, false);
    };
    apply();
    requestAnimationFrame(apply); // the element may still be detached right now
    setTimeout(apply, 80);
    setTimeout(apply, 400);
    if (!el._maskflowRO && typeof ResizeObserver !== "undefined") {
        el._maskflowRO = new ResizeObserver(apply);
        el._maskflowRO.observe(el);
    }
}

const PANEL = { node: null, els: null, remaining: 0, timer: null, countdown: 0, nodeId: null };

function ensurePanel(node) {
    if (node.maskflowPanel) return node.maskflowPanel;
    const box = document.createElement("div");
    box.style.cssText = "border:1px solid var(--border-color,#444);border-radius:6px;margin:2px 4px;padding:4px 6px;font-size:11px;background:var(--comfy-menu-bg,#222);display:flex;flex-direction:column;gap:4px;";

    const status = document.createElement("div");
    // pre-line wraps at spaces/newlines, but a Windows path is one long token with
    // no break opportunity - it then paints past the node's right edge. overflow-wrap
    // (with the legacy word-break fallback) lets that token break mid-path, and
    // min-width:0 lets this flex child shrink below its own content width.
    status.style.cssText = "white-space:pre-line;line-height:1.35;overflow-wrap:anywhere;word-break:break-word;min-width:0;";

    // the countdown gets its OWN line; the buttons go on the line below
    const cdRow = document.createElement("div");
    cdRow.style.cssText = "display:none;"; // hidden in IDLE
    const cd = document.createElement("span");
    cd.className = "maskflow-cd";        // green -> white -> green breathing
    cd.style.cssText = "font-weight:600;font-size:16px;";   // +20%
    cdRow.append(cd);

    // line 2: Done on its OWN line (+20% = 16px). Native border/radius kept, so
    // it keeps the same rounded shape as the other buttons.
    const doneRow = document.createElement("div");
    doneRow.style.cssText = "display:none;gap:6px;align-items:center;flex-wrap:wrap;"; // hidden in IDLE
    const DONE_CSS = "font-size:16px;padding:3px 14px;cursor:pointer;font-weight:600;";

    // The theme's `button{background-color/color: ..!important}` beats plain
    // inline styles and even CSS animations, so every colour we want MUST be set
    // as inline !important (setProperty(..., "important")).
    const doneBtn = document.createElement("button");
    doneBtn.textContent = "✓ Done";
    doneBtn.title = "Finish: submit the captured mask (click the editor's Save first)";
    doneBtn.style.cssText = DONE_CSS;
    doneBtn.style.setProperty("border-radius", "6px", "important");
    doneRow.append(doneBtn);

    // line 3: Continue (blue) + Cancel (red) - NOT enlarged
    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:none;gap:6px;align-items:center;flex-wrap:wrap;"; // hidden in IDLE
    const SUB_CSS = "font-size:9px;padding:2px 8px;cursor:pointer;";   // ~30% smaller

    const backBtn = document.createElement("button");
    backBtn.textContent = "↩ Continue Drawing";
    backBtn.title = "re-open the mask editor with the current mask and keep drawing";
    backBtn.style.cssText = SUB_CSS;
    backBtn.style.setProperty("border-radius", "6px", "important");
    backBtn.style.setProperty("background-color", "#2f6fdb", "important");   // blue
    backBtn.style.setProperty("border-color", "#2f6fdb", "important");
    backBtn.style.setProperty("color", "#ffffff", "important");
    btnRow.append(backBtn);

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "✖ Cancel";
    cancelBtn.title = "cancel the WHOLE workflow run (interrupt), not just this mask";
    cancelBtn.style.cssText = SUB_CSS;
    cancelBtn.style.setProperty("border-radius", "6px", "important");
    cancelBtn.style.setProperty("background-color", "#c0392b", "important"); // red
    cancelBtn.style.setProperty("border-color", "#c0392b", "important");
    cancelBtn.style.setProperty("color", "#ffffff", "important");
    btnRow.append(cancelBtn);

    box.append(status, cdRow, doneRow, btnRow);
    const w = node.addDOMWidget("maskflow_panel", "MaskFlow", box);
    node.maskflowPanel = { box, status, cdRow, doneRow, btnRow, cd, doneBtn, backBtn, cancelBtn, widget: w };
    box.style.width = "100%";
    box.style.height = "auto";
    // size from the element's own CSS vars (see sizeDomBox). No computeSize here:
    // that property would beat the CSS vars and freeze a stale (detached) height.
    node.maskflowPanel.resize = () => sizeDomBox(node, box, 8, 24, node.maskflowPanel?.widget);
    node.maskflowPanel.resize();
    return node.maskflowPanel;
}

/* Park the plugin's DOM rows in a fixed order immediately ABOVE the info box
   (see parkRows): preview tint controls, then the permanent Edge blur / Noise
   / grain rows. At widget index 0 they would render above the preview image. */
function parkTintRow(node) {
    parkRows(node);
}

function panelIdle(node, text) {
    const p = ensurePanel(node);
    p.status.textContent = text;
    p.cdRow.style.display = "none";   // hide countdown line
    p.doneRow.style.display = "none"; // hide Done line
    p.btnRow.style.display = "none";  // hide Continue/Cancel line
    if (PANEL.timer) { clearInterval(PANEL.timer); PANEL.timer = null; }
    parkTintRow(node);
    // re-measure: the info text just changed height
    p.resize?.();
    setTimeout(() => p.resize?.(), 80);
}

function panelSet(node, text, countdown = null) {
    if (!node) return;
    const p = ensurePanel(node);
    p.status.textContent = text;
    if (countdown !== null) p.cd.textContent = countdown > 0 ? `⏱ ${countdown}s` : "⏱ off";
    p.resize?.(); // text length (and therefore the panel height) may have changed
}

function panelDrawMode(node) {
    const p = ensurePanel(node);
    p.cdRow.style.display = "block"; // countdown line
    p.doneRow.style.display = "flex"; // Done line
    p.btnRow.style.display = "flex";  // Continue/Cancel line (wraps if narrow)
    p.resize?.();
}

function panelStart(node, nodeId, countdown, sourceName) {
    if (PANEL.timer) clearInterval(PANEL.timer);
    PANEL.node = node; PANEL.nodeId = nodeId;
    panelDrawMode(node);
    panelSet(node,
        `MaskFlow — Drawing mask for: ${sourceName}\nStatus: Editor open, waiting for Save...`,
        countdown);
    PANEL.els = ensurePanel(node);
    PANEL.els.doneBtn.onclick = () => {
        PANEL.els.doneBtn.classList.remove("maskflow-ready");
        if (_doneHandler) _doneHandler();
    };
    PANEL.els.backBtn.onclick = () => { if (_backHandler) _backHandler(); };
    // Cancel = cancel the WHOLE workflow run, not merely the mask: unblock the
    // backend right away AND raise ComfyUI's global interrupt (the backend also
    // raises InterruptProcessingException on action=cancel).
    PANEL.els.cancelBtn.onclick = () => {
        console.log("[MaskFlow] Cancel pressed on the node panel -> interrupting the whole run");
        _doneHandler = null;
        _backHandler = null;
        panelStop(node, "MaskFlow — ✖ Cancelled (workflow interrupted)");
        API.submit({ node_id: nodeId, action: "cancel" });
        try { api.interrupt().catch(() => {}); } catch (e) { /* ignore */ }
    };
    armDrawRun(node, sourceName, countdown);
}

/* (Re)arm one editor session: capture listener, badge watcher and auto-save
   countdown. Called when a draw run starts AND when "↩ Continue Drawing"
   re-opens the editor, so the countdown restarts for the new session. */
function armDrawRun(node, sourceName, seconds) {
    if (PANEL.timer) { clearInterval(PANEL.timer); PANEL.timer = null; }
    if (PANEL._saveWatch) { clearInterval(PANEL._saveWatch); PANEL._saveWatch = null; }
    PANEL.countdown = seconds; PANEL.remaining = seconds;

    // capture status listener: highlight Done with a green breathing glow
    // once a mask upload has actually been observed
    _captureListener = (n) => {
        if (n >= 0) { panelSet(node, `MaskFlow — ${sourceName}\nStatus: Mask upload seen (${(n/1024).toFixed(0)} KB) — processing...`); }
        else {
            panelSet(node, `MaskFlow — ${sourceName}\nStatus: ✓ Mask captured — press ✓ Done to submit`);
            PANEL.els.doneBtn.classList.add("maskflow-ready");
        }
    };
    // hide the countdown badge as soon as the user saves inside the editor:
    // observe the Save button click (the same click triggers the upload)
    const saveWatch = setInterval(() => {
        if (!PANEL.node) { clearInterval(saveWatch); return; }
        const { save } = editorButtons();
        if (save && !save.dataset.maskflowWatch) {
            save.dataset.maskflowWatch = "1";
            save.addEventListener("click", () => setTimeout(cdBadgeHide, 800), { once: true });
        }
    }, 400);
    PANEL._saveWatch = saveWatch;
    // countdown: at 0 we CLICK the editor's Save for the user, but we NEVER
    // submit the mask ourselves — submission happens only on "✓ Done".
    // The floating badge floats above the editor overlay so it stays visible
    // while the user is drawing.
    cdBadgeShow(seconds);
    PANEL.timer = setInterval(() => {
        PANEL.remaining -= 1;
        if (PANEL.remaining >= 0) {
            panelSet(node, PANEL.els.status.textContent.split("\nStatus:")[0] + `\nStatus: Editor open, waiting for Save...`, PANEL.remaining);
            cdBadgeSet(Math.max(PANEL.remaining, 0));
        }
        if (PANEL.remaining <= 0) {
            clearInterval(PANEL.timer); PANEL.timer = null;
            cdBadgeHide();
            autoSaveThenSubmit(node, sourceName);
        }
    }, 1000);
}

/* Countdown hit 0: click the editor's Save for the user, wait for the upload to be
   captured, then submit automatically ("auto-Done"). If nothing lands within the
   timeout we leave the manual ✓ Done button in charge instead of killing the run. */
function autoSaveThenSubmit(node, sourceName) {
    const submitWhenCaptured = () => {
        const t0 = Date.now();
        const wait = setInterval(() => {
            if (!PANEL.node) { clearInterval(wait); return; }   // cancelled meanwhile
            if (getCapturedMask()) {
                clearInterval(wait);
                console.log("[MaskFlow] countdown done - auto-submitting the captured mask");
                panelSet(node, `MaskFlow — ${sourceName}\nStatus: Countdown done - submitting...`);
                _doneHandler?.();
            } else if (Date.now() - t0 > 10000) {
                clearInterval(wait);
                console.log("[MaskFlow] countdown done - nothing captured in 10s, waiting for ✓ Done");
                panelSet(node, `MaskFlow — ${sourceName}\nStatus: Countdown done - press ✓ Done to submit`);
            }
        }, 200);
    };
    if (getCapturedMask()) { submitWhenCaptured(); return; }     // already have one
    const { save } = editorButtons();
    if (editorShowing() && save) {
        console.log("[MaskFlow] countdown hit 0 - clicking editor Save, then auto-submitting");
        panelSet(node, `MaskFlow — ${sourceName}\nStatus: Countdown done - auto-saving and submitting...`);
        save.click();
        submitWhenCaptured();
    } else {
        console.log("[MaskFlow] countdown hit 0 - editor not open, waiting for ✓ Done");
        panelSet(node, `MaskFlow — ${sourceName}\nStatus: Countdown done - press ✓ Done to submit`);
    }
}

function panelStop(node, finalText = null) {
    if (PANEL.timer) { clearInterval(PANEL.timer); PANEL.timer = null; }
    if (PANEL._saveWatch) { clearInterval(PANEL._saveWatch); PANEL._saveWatch = null; }
    cdBadgeHide();
    _captureListener = null;
    _backHandler = null;
    // a stopped session leaves no controls behind: hide the countdown + buttons
    if (node && node.maskflowPanel) {
        node.maskflowPanel.cdRow.style.display = "none";
        node.maskflowPanel.doneRow.style.display = "none";
        node.maskflowPanel.btnRow.style.display = "none";
    }
    if (node && node.maskflowPanel && finalText) {
        node.maskflowPanel.status.textContent = finalText;
        node.maskflowPanel.resize?.();   // a long "File:" path changes the height
    }
    const keep = node && finalText;
    PANEL.node = null; PANEL.nodeId = null; PANEL.els = null;
    if (node && !keep && node.maskflowPanel) node.maskflowPanel.cd.textContent = "";
}

/* ---------- message handling ---------- */

app.api.addEventListener("maskflow_open_editor", async ({ detail }) => {
    console.log("[MaskFlow] open editor for node", detail.node_id, "source:", detail.source_name);
    const node = app.graph._nodes_by_id[detail.node_id];
    if (!node) {
        API.submit({ node_id: detail.node_id, action: "cancel" });
        return;
    }
    panelStart(node, detail.node_id, detail.countdown ?? 30, detail.source_name);
    try {
        await openOfficialEditor(node, detail.image_b64, detail.mask_b64);
    } catch (e) {
        throw e;
    }
    installMaskCaptureHook();
    /* cg-style confirmation: WE DO NOT watch the editor or auto-submit.
       The user draws, clicks the official editor Save (upload is observed),
       then clicks "✓ Done" on the node panel to submit. Cancel any time. */
    /* / Done: submit the captured mask.
       / Never fails silently: the upload's base64 conversion is ASYNC (an editor
       / PNG is a megabyte or two), so a Done pressed a moment after Save used to
       / find nothing captured, cancel the WHOLE run and null the handler - after
       / which every later press did nothing at all (the reported symptom).
       / Now: wait for an in-flight capture; if there is really nothing, say so
       / and KEEP the session so Save + Done can be retried. */
    _doneHandler = () => {
        const submit = (b64) => {
            clearCapturedMask();
            _doneHandler = null;
            _backHandler = null;
            console.log("[MaskFlow] submitting captured mask");
            panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: Submitting captured mask...`);
            API.submit({ node_id: detail.node_id, action: "save", mask_b64: b64 })
                .then(async (r) => {
                    if (r && !r.ok) {
                        const t = await r.text().catch(() => "");
                        console.warn("[MaskFlow] submit rejected:", r.status, t);
                        panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: ✗ Submit failed (HTTP ${r.status}) ${String(t).slice(0, 90)}`);
                    } else {
                        panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: ✓ Mask submitted — the backend is resuming`);
                    }
                })
                .catch((e) => {
                    console.warn("[MaskFlow] submit error:", e);
                    panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: ✗ Submit error: ${e}`);
                });
        };
        const ready = getCapturedMask();
        if (ready) { submit(ready); return; }
        // Nothing captured yet. If the editor is still open, Done is the user
        // asking "finish this for me" - click the editor's own Save (exactly what
        // the countdown does and what uploads the mask), then submit when the
        // upload lands. Only if that never arrives do we ask them to do it.
        const { save } = editorButtons();
        if (editorShowing() && save) {
            console.log("[MaskFlow] Done pressed with nothing captured - clicking editor Save");
            panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: Saving the editor and submitting...`);
            save.click();
        } else {
            console.log("[MaskFlow] Done pressed - waiting for the upload to finish");
            panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: Waiting for the mask upload to finish...`);
        }
        const t0 = Date.now();
        const wait = setInterval(() => {
            const b64 = getCapturedMask();
            if (b64) { clearInterval(wait); submit(b64); return; }
            if (Date.now() - t0 > 10000) {
                clearInterval(wait);
                console.warn("[MaskFlow] Done pressed but nothing was captured - session kept open");
                panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: ✗ Nothing captured yet — click Save in the editor, then ✓ Done`);
            }
        }, 150);
    };
    /* "↩ Continue Drawing": re-open the official editor with the mask painted so
       far pre-loaded, so the user keeps painting instead of losing the work.
       KEEP the capture - it is the starting point - only the Done highlight is
       cleared until the next Save uploads a fresh one. */
    _backHandler = async () => {
        // The editor seeds its starting mask from the ALPHA channel of the image it
        // loads (frontend 1.51.10: useMaskEditorLoader -> loadImageLayer(url,"a"),
        // mask = 1 - alpha). The captured upload IS the source image with the mask
        // in its alpha channel, so re-open with THAT as the image and the previous
        // work comes straight back. Nothing captured yet in this session -> use the
        // backend's continue image (mask input, else the newest archived mask).
        const base = getCapturedMask() || detail.continue_b64 || detail.image_b64;
        console.log("[MaskFlow] continue drawing - re-opening the editor with",
                    getCapturedMask() ? "this session's capture" : "the archived mask");
        panelSet(node, `MaskFlow — ${detail.source_name}\nStatus: Re-opening the editor with the current mask...`);
        PANEL.els?.doneBtn.classList.remove("maskflow-ready");
        await openOfficialEditor(node, base, null);
        armDrawRun(node, detail.source_name, detail.countdown ?? 60);
    };
});

/* load mode has no node preview: render the mask overlay sent by the backend
   into a controls row parked between the preview image and the info box.
   No temp files are written — the overlay travels over the websocket as base64
   and lives only in memory. */
const PREVIEW_COLORS = ["#e74c3c", "#ffffff", "#000000", "#808080", "#3498db", "#2ecc71", "#f1c40f"];

function ensurePreviewPanel(node) {
    if (node.maskflowPrev) return node.maskflowPrev;
    // Controls row only. The composed preview image goes into node.imgs —
    // the SAME built-in slot the draw-mode preview uses — so both modes
    // share one identical preview position.
    const box = document.createElement("div");
    box.style.cssText = "margin:0;padding:2px 4px;background:transparent;border:none;font-size:11px;line-height:18px;width:100%;box-sizing:border-box;";
    box.style.display = "inline-block";
    box.style.whiteSpace = "normal";  // wrap onto a 2nd line rather than stick out
    box.style.textAlign = "center";   // child controls are inline-block -> centred

    const lbl = document.createElement("span");
    lbl.textContent = "Opacity";
    lbl.title = "mask overlay opacity";
    lbl.style.cssText = "opacity:.7;display:inline-block;vertical-align:middle;margin-right:6px;";
    box.append(lbl);

    const opacity = document.createElement("input");
    opacity.type = "number"; opacity.min = "0"; opacity.max = "100"; opacity.step = "5"; opacity.value = "80";
    opacity.title = "opacity % (0-100)";
    opacity.style.cssText = "width:46px;padding:1px 2px;display:inline-block;vertical-align:middle;margin-right:2px;height:18px;";
    box.append(opacity);

    const pct = document.createElement("span");
    pct.textContent = "%";
    pct.style.cssText = "opacity:.7;display:inline-block;vertical-align:middle;margin-right:6px;";
    box.append(pct);

    const swatches = document.createElement("div");
    swatches.style.cssText = "display:inline-block;vertical-align:middle;margin-right:6px;";
    let color = "#000000";
    for (const c of PREVIEW_COLORS) {
        const b = document.createElement("button");
        b.dataset.c = c;
        b.style.cssText = `width:14px;height:14px;border-radius:3px;cursor:pointer;border:2px solid ${c === color ? "#fff" : "transparent"};background:${c};`;
        b.onclick = () => {
            color = c;
            swatches.querySelectorAll("button").forEach(x => x.style.borderColor = x.dataset.c === c ? "#fff" : "transparent");
            redraw();
        };
        swatches.append(b);
    }
    box.append(swatches);

    const bwBtn = document.createElement("button");
    bwBtn.textContent = "B/W";
    bwBtn.title = "toggle: plain black / white mask instead of the tinted overlay";
    // A bare <button> in a node keeps the BROWSER's native look: a 2px OUTSET
    // border (that is the "raised edge" the user saw) and its own corner radius,
    // so an inline fill read as a protruding square block and pinning 4px made
    // the radius change on highlight. Give it a flat themed base ONCE - the
    // radius/border live here, not in the highlighted state - so switching it on
    // can be nothing but a colour swap.
    bwBtn.style.cssText = "font-size:11px;padding:0 6px;cursor:pointer;display:inline-block;vertical-align:middle;"
                        + "height:18px;box-sizing:border-box;border:1px solid var(--border-color,#555);"
                        + "border-radius:4px;background-color:var(--comfy-input-bg,#1b1b1b);color:var(--input-text,#ddd);";
    let bw = false;
    // Active = ONLY the two colours (fill + border so no rim shows). The radius,
    // the border width and the box sizing are never touched, so the shape is
    // byte-identical in both states. Off restores the base values - NOT
    // removeProperty, which would also drop the base fill written above and let
    // the browser's native look come back.
    bwBtn.onclick = () => {
        bw = !bw;
        if (bw) {
            bwBtn.style.setProperty("background-color", "#27ae60", "important");
            bwBtn.style.setProperty("border-color", "#27ae60", "important");
        } else {
            bwBtn.style.setProperty("background-color", "var(--comfy-input-bg, #1b1b1b)");
            bwBtn.style.setProperty("border-color", "var(--border-color, #555)");
        }
        redraw();
    };
    box.append(bwBtn);

    const w = node.addDOMWidget("maskflow_preview", "MaskFlowTint", box);
    // No computeSize: the layout engine reads this element's CSS vars instead
    // (see sizeDomBox) — a computeSize property would override them.
    sizeDomBox(node, box, 6, 22, w);

    let base = null, mask = null;
    function redraw() {
        if (!base || !mask) return;
        const cv = document.createElement("canvas");
        cv.width = base.naturalWidth; cv.height = base.naturalHeight;
        const ctx = cv.getContext("2d");
        if (bw) {
            ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
            ctx.drawImage(mask, 0, 0, cv.width, cv.height);
        } else {
            ctx.drawImage(base, 0, 0, cv.width, cv.height);
            const a = (parseFloat(opacity.value) || 80) / 100;
            const r0 = parseInt(color.slice(1, 3), 16), g0 = parseInt(color.slice(3, 5), 16), b0 = parseInt(color.slice(5, 7), 16);
            const m = document.createElement("canvas"); m.width = cv.width; m.height = cv.height;
            const mc = m.getContext("2d");
            mc.drawImage(mask, 0, 0, cv.width, cv.height);
            const id = mc.getImageData(0, 0, cv.width, cv.height);
            const d = id.data;
            for (let i = 0; i < d.length; i += 4) {
                const lum = d[i] / 255;
                d[i] = r0; d[i + 1] = g0; d[i + 2] = b0;
                d[i + 3] = Math.round(lum * a * 255);
            }
            mc.putImageData(id, 0, 0);
            ctx.drawImage(m, 0, 0, cv.width, cv.height);
        }
        // SAME slot as draw mode: node.imgs is drawn by ComfyUI at the node top
        const img = new Image();
        img.onload = () => {
            node.imgs = [img];
            node.imageIndex = 0;
            app.graph.setDirtyCanvas(true, true);
        };
        img.src = cv.toDataURL("image/png");
    }

    node.maskflowPrev = { box, widget: w, resize: () => sizeDomBox(node, box, 6, 22, w), set: (baseB64, maskB64) => {
        base = new Image(); base.onload = redraw; base.src = baseB64;
        mask = new Image(); mask.onload = redraw; mask.src = maskB64;
    }};
    return node.maskflowPrev;
}

app.api.addEventListener("maskflow_preview", ({ detail }) => {
    const node = app.graph._nodes_by_id[detail.node_id];
    if (!node || !detail.base_b64 || !detail.mask_b64) return;
    // two-mode rule: composed preview goes into node.imgs (the built-in slot)
    // only when draw_mask is OFF; the controls row shows only in load mode.
    const dm = (node.widgets || []).find(w => w.name === "draw_mask");
    const drawOn = !dm || dm.value === true || dm.value === "true";
    if (drawOn) return;
    const p = ensurePreviewPanel(node);
    p.set(detail.base_b64, detail.mask_b64);
    setOurPreviewVisible(node, true);
});

app.api.addEventListener("maskflow_info", ({ detail }) => {
    const node = app.graph._nodes_by_id[detail.node_id];
    if (!node) return;
    // backend ran (idle or load mode): show what it actually used — IDLE layout
    panelIdle(node,
        `MaskFlow — Using archived mask\n` +
        `Source: ${detail.source}\n` +
        `Version used: ${detail.version ?? "latest"}\n` +
        `Mask size: ${detail.w}x${detail.h}\n` +
        `File: ${detail.path}`);
});

/* draw run finished: report + prompt to flip the toggle manually */
app.api.addEventListener("maskflow_saved", ({ detail }) => {
    const node = app.graph._nodes_by_id[detail.node_id];
    if (node) panelIdle(node, "MaskFlow — ✓ Mask saved (new version archived)\n(Turn draw_mask OFF to reuse it)");
});

/* ---------- MaskFlow process panel: switches + preview + numbers ----------
   ONE DOM widget holds the whole thing as a CSS grid with EVERY item placed
   explicitly (grid-area), so nothing can drift:

       +--------+---+-------+-----------------------------------------+
       |        | []| Edge  | [ ... ] px                              |
       | 38x38  | []| Noise | Blur [ .. ]px  Amt [..]%  Size [..]px   |
       +--------+---+-------+-----------------------------------------+
            ^     ^     ^     ^ row 1's field sits on the SAME track as row 2's
            |     |     |       first field, so the Edge field and the Blur
            |     |     |       field line up.
            |     |     +-- one NAMED switch per row, right of the thumbnail
            |     +-- the on/off checkbox
            +-- the noise thumbnail (2 rows tall)

   The thumbnail doubles as the style selector: click it to step through the
   styles ("none" is not in the cycle - the row switch is the way to turn the
   noise off). Nothing is ever squeezed: the label tracks are max-content and
   the node is grown once if the panel needs more room than it has.

   The blur / noise_* inputs stay declared in the BACKEND (INPUT_TYPES) so their
   values still reach the node at execution time and still live in
   widgets_values. Their NATIVE widgets are hidden (widget.hidden = true) and
   driven from this panel, exactly like the tint row. Verified against frontend
   1.51.10:
     - graphToPrompt skips a widget only when `options.serialize === false`
       (settingStore bundle) - `hidden` is not consulted, so hidden widgets
       still submit their value as a node input.
     - node.serialize skips only `widget.serialize === false`, so hidden
       widgets still write into widgets_values (the value survives save/load).
     - getLayoutWidgets()/isWidgetVisible()/drawWidgets()/getWidgetOnPos() all
       test `widget.hidden`, so a hidden native widget takes no row, is not
       drawn and cannot be clicked.
   The panel is PERMANENT (both draw and load mode) and parked immediately above
   the info box. English labels to match the existing controls row.

   The preview draws the real mask cross-section - the black->white transition
   at its actual width for the current Edge Blur - with the selected noise on
   top. There is NO band control: the noise weight is a PLATEAU across the
   mask's own soft band (see nodes.py edge_noise_weight), so the grain fills the
   whole blurred edge and a hard edge gets none.
--------------------------------------------------------------------------- */
const PROCESS_HIDDEN = ["blur_on", "blur", "noise_on", "noise_kind", "noise_amount", "noise_size", "noise_blur"];
/* MUST match NOISE_KINDS in nodes.py byte for byte - the value is submitted as
   the node's COMBO input. Clicking the thumbnail cycles exactly this list; the
   row switch is what turns the noise off, so there is no "none" entry. */
const NOISE_KINDS = ["film grain", "shadow grain", "digital grain", "cloud fbm"];
const NOISE_SHORT = { "film grain": "film", "shadow grain": "shadow", "digital grain": "digital", "cloud fbm": "cloud" };
const PARK_ORDER = ["maskflow_preview", "maskflow_proc"];
const PREV_PX = 38;   // = two widget rows (18px + 3px gap + 18px) -> square preview

const _procCss = document.createElement("style");
/* Column templates - the SINGLE source of truth for both the CSS and the two
   minimum widths below. No `fr` anywhere: the fields must keep one width whether
   the node is narrow or wide, and the whole group is centred in the node. */
const PROC_WIDE_COLS   = "42px max-content 14px max-content 42px 14px max-content 42px 14px max-content 42px 14px";
// narrow: [label][switch/field][unit][gap] twice - the label column is what every
// row of a group starts with, and the switch sits in the same column as the
// fields beneath it, so a switch is always directly above its own number.
const PROC_NARROW_COLS = "max-content 34px 14px 8px max-content 34px 14px 8px";
const PROC_GAP = 2, PROC_PAD = 8;
function procTrackSum(tpl) {
    const parts = tpl.trim().split(/\s+/);
    return parts.reduce((n, t) => n + (t.endsWith("px") ? parseFloat(t) : 30), 0) + (parts.length - 1) * PROC_GAP;
}
const PROC_MIN = {
    wide: Math.ceil(procTrackSum(PROC_WIDE_COLS)) + PROC_PAD,
    narrow: Math.ceil(procTrackSum(PROC_NARROW_COLS)) + PROC_PAD,
};

_procCss.textContent = `
.mf-proc{display:grid;grid-template-columns:${PROC_WIDE_COLS};align-items:center;align-content:start;column-gap:${PROC_GAP}px;row-gap:3px;width:max-content;margin:0 auto;box-sizing:border-box;font-size:11px;line-height:16px;/* no clip: a layout problem stays visible instead of being hidden */}
/* narrow (node dragged in): one control per line, nothing can stick out. */
/* Narrow: line 1 = the noise preview across the top, line 2 = Edge (left) and
   Noise (right) groups, lines 3-4 = Amt/Size under the Noise side. Fields keep a
   FIXED 40px so they never stretch long; only the spinners go (13px each). */
.mf-proc.mf-narrow{grid-template-columns:${PROC_NARROW_COLS};}
.mf-proc.mf-narrow input.mf-num{min-width:32px;width:34px;}
.mf-proc.mf-narrow .mf-lbl{text-align:left;}   /* one left edge with the switch's name */
.mf-proc.mf-narrow canvas.mf-prev{margin-left:auto;margin-right:auto;}
.mf-proc.mf-narrow input.mf-num::-webkit-inner-spin-button,
.mf-proc.mf-narrow input.mf-num::-webkit-outer-spin-button{-webkit-appearance:none;appearance:none;margin:0;}
.mf-proc .mf-lbl{text-align:right;opacity:.7;white-space:nowrap;}
.mf-proc .mf-unit{opacity:.55;text-align:left;font-size:9px;white-space:nowrap;}
.mf-proc input.mf-num{width:100%;min-width:38px;height:18px;font-size:11px;padding:1px 1px 1px 2px;box-sizing:border-box;}
.mf-proc input.mf-sw{width:14px;height:14px;margin:0;padding:0;justify-self:start;cursor:pointer;}
.mf-proc .mf-swlbl{opacity:.85;white-space:nowrap;cursor:pointer;text-align:left;}
.mf-proc canvas.mf-prev{width:${PREV_PX}px;height:${PREV_PX}px;display:block;margin-left:auto;border:1px solid var(--border-color,#555);border-radius:3px;background:#000;image-rendering:pixelated;cursor:pointer;}
`;
document.head.appendChild(_procCss);

function findNativeWidget(node, name) {
    return (node.widgets || []).find(w => w.name === name);
}

/* ComfyUI booleans arrive as a real boolean, but a string "false" is truthy in
   JS - never let that turn a switch on by accident */
function nativeBool(node, name, def = true) {
    const w = findNativeWidget(node, name);
    if (!w) return def;
    const v = w.value;
    if (v === undefined || v === null) return def;
    return v === true || v === 1 || v === "1" || v === "true" || v === "True";
}

function currentKind(node) {
    const w = findNativeWidget(node, "noise_kind");
    return (w && NOISE_KINDS.includes(w.value)) ? w.value : NOISE_KINDS[0];
}

function nextKind(kind) {
    const i = NOISE_KINDS.indexOf(kind);
    return NOISE_KINDS[(i + 1) % NOISE_KINDS.length];
}

/* the native widgets stay in node.widgets (values must keep flowing) but take
   no space and are never drawn/clicked */
function hideProcessWidgets(node) {
    for (const name of PROCESS_HIDDEN) {
        const w = findNativeWidget(node, name);
        if (w) w.hidden = true;
    }
}

/* Which panel row each replaced widget's connection dot belongs to
   (row 0 = Edge, row 1 = Noise). */
const PROC_ROW = { blur_on: 0, blur: 0, noise_on: 1, noise_kind: 1, noise_amount: 1, noise_size: 1, noise_blur: 1 };

/* Park the connection dots of the widgets the panel replaces.
   Hiding a native widget takes it OUT of the layout loop - the frontend's
   arrange() only walks VISIBLE widgets - so a hidden widget's y is never
   refreshed and that input's dot is parked from a stale/undefined value, while
   its hover box is computed from the same value later: the dot you see and the
   dot that grows under the cursor end up in different places. Writing an
   explicit y makes the engine's own _arrangeWidgetInputSlots()
   (input.pos = [SLOT/2, widget.y + SLOT/2]) put each dot exactly on the panel
   row that drives it, and keeps it there through every later arrange. */
function parkProcessWidgetRows(node) {
    try {
        // the PROCESS panel (grid + its own DOM widget): the status panel below it
        // sits at a different y and would leave every dot visibly off
        const proc = node.maskflowProc;
        const grid = proc && proc.grid;
        const pw = proc && proc.widget;
        if (!grid || !pw || typeof pw.y !== "number") return;
        // wide = 2 rows (Edge row, Noise row); narrow = 5 (preview / switches /
        // blur fields / Amt / Size) with the switch row being the SECOND one
        const narrow = grid.classList.contains("mf-narrow");
        const rows = narrow ? 5 : 2;
        const rowH = Math.max(8, Math.round((grid.offsetHeight || rows * 22) / rows));
        for (const w of node.widgets || []) {
            if (!w.hidden) continue;
            const r = PROC_ROW[w.name];
            if (r === undefined) continue;
            w.y = pw.y + (r + (narrow ? 1 : 0)) * rowH + 3;
        }
    } catch (e) { /* cosmetic only - never break the panel */ }
}

function setNativeValue(node, name, value) {
    const w = findNativeWidget(node, name);
    if (!w) return;
    w.value = value;
    try { w.callback?.(value); } catch (e) { /* ignore */ }
    try { app.graph.setDirtyCanvas(true, false); } catch (e) { /* ignore */ }
    try { app.graph.change(); } catch (e) { /* ignore */ }  // marks the workflow changed
}

/* ---------- preview: 38x38 mask-edge cross-section -------------------------
   Same recipe as the backend (reduced-res random field upsampled bilinearly /
   nearest, fbm = 4 octaves, PLATEAU weight across the soft band, shadow grain
   weighted by (1-mask)) plus the Edge blur, drawn at its real width. The field
   of view never magnifies: a soft edge zooms out up to 2x so the edge stays
   readable while the grain keeps its true size on screen. Deterministic per
   kind/size (own PRNG) - no flicker between redraws.
--------------------------------------------------------------------------- */
function mfRng(seedStr) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return function () {
        h = (h + 0x6D2B79F5) >>> 0;
        let t = h;
        t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function mfGauss(r) {
    let u = 0, v = 0;
    while (!u) u = r();
    while (!v) v = r();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mfNormalize(a) {
    let m = 0;
    for (let i = 0; i < a.length; i++) m += a[i];
    m /= a.length;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    s = Math.sqrt(s / a.length) || 1;
    for (let i = 0; i < a.length; i++) a[i] = (a[i] - m) / s;
    return a;
}
function mfOctave(n, sizePx, blocky, rng) {
    const cells = Math.max(2, Math.round(n / Math.max(1, sizePx)));
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = mfGauss(rng);
    const cl = v => Math.min(cells - 1, Math.max(0, v));
    const out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            const fx = ((x + 0.5) / n) * cells - 0.5;
            const fy = ((y + 0.5) / n) * cells - 0.5;
            if (blocky) {
                out[y * n + x] = g[cl(Math.round(fy)) * cells + cl(Math.round(fx))];
            } else {
                const x0 = Math.floor(fx), y0 = Math.floor(fy);
                const tx = fx - x0, ty = fy - y0;
                const a = g[cl(y0) * cells + cl(x0)], b = g[cl(y0) * cells + cl(x0 + 1)];
                const c = g[cl(y0 + 1) * cells + cl(x0)], d = g[cl(y0 + 1) * cells + cl(x0 + 1)];
                out[y * n + x] = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
            }
        }
    }
    return mfNormalize(out);
}
function mfNoiseField(n, sizePx, kind) {
    const rng = mfRng(kind + "|" + sizePx);
    if (kind === "cloud fbm") {
        const out = new Float32Array(n * n);
        let amp = 1, norm = 0, s = Math.max(2, sizePx * 4);
        for (let o = 0; o < 4; o++) {
            const f = mfOctave(n, s, false, rng);
            for (let i = 0; i < out.length; i++) out[i] += amp * f[i];
            norm += amp; amp *= 0.5; s = Math.max(1, s * 0.5);
        }
        for (let i = 0; i < out.length; i++) out[i] /= norm;
        return mfNormalize(out);
    }
    return mfOctave(n, Math.max(1, sizePx), kind === "digital grain", rng);
}
function mfBoxBlur(a, n, r) {
    if (r <= 0) return a;
    const tmp = new Float32Array(n * n), out = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            let s = 0, c = 0;
            for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < n) { s += a[y * n + xx]; c++; } }
            tmp[y * n + x] = s / c;
        }
    }
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            let s = 0, c = 0;
            for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < n) { s += tmp[yy * n + x]; c++; } }
            out[y * n + x] = s / c;
        }
    }
    return out;
}
function drawNoisePreview(node) {
    const p = node.maskflowProc;
    if (!p || !p.cv) return;
    const cv = p.cv;
    const n = PREV_PX;
    const kind = currentKind(node);
    const noiseOn = nativeBool(node, "noise_on", true);
    const num = (name, def) => {
        const el = p.nums[name];
        const v = el ? parseInt(el.value, 10) : NaN;
        return isNaN(v) ? def : v;
    };
    const sizePx = Math.max(1, Math.min(200, num("noise_size", 1)));
    const amt = Math.max(0, Math.min(100, num("noise_amount", 50)));
    const nblur = Math.max(0, Math.min(200, num("noise_blur", 0)));
    const eblur = nativeBool(node, "blur_on", true) ? Math.max(0, Math.min(1000, num("blur", 5))) : 0;

    // field of view: 1:1 while the edge fits the square, zooming OUT up to 2x
    // for very soft edges - never magnifying, so the grain keeps its true size
    const cropPx = Math.max(n, Math.min(n * 2, eblur * 2));
    const zoom = n / cropPx;
    const edgeW = Math.min(n, eblur * 2 * zoom);   // transition width, screen px

    let field = null;
    if (noiseOn && amt > 0 && edgeW > 0.5) {
        field = mfNoiseField(n, Math.max(1, sizePx * zoom), kind);
        if (nblur > 0) field = mfNormalize(mfBoxBlur(field, n, Math.min(Math.round(nblur * zoom), 10)));
    }

    const mid = n / 2;
    const img = new ImageData(n, n);
    for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
            // mask cross-section: a hard step with no blur, an actual-width
            // smoothstep ramp once Edge Blur is set
            let m;
            if (edgeW <= 0.5) {
                m = x < mid ? 0 : 1;
            } else {
                const t = Math.min(1, Math.max(0, (x - (mid - edgeW / 2)) / edgeW));
                m = t * t * (3 - 2 * t);
            }
            let v = m;
            if (field) {
                // same rule as the backend: a PLATEAU across the mask's soft band
                // (tapering only in its outer 10%), so a wide blurred edge shows a
                // wide grainy band instead of one thin line down its middle
                const soft = Math.min(1, Math.min(m, 1 - m) / 0.10);
                const w = kind === "shadow grain" ? soft * (1 - m) : soft;
                v = m + field[y * n + x] * w * (amt / 100) * 0.5;
            }
            const g = Math.round(Math.max(0, Math.min(1, v)) * 255);
            const i = (y * n + x) * 4;
            img.data[i] = g; img.data[i + 1] = g; img.data[i + 2] = g; img.data[i + 3] = 255;
        }
    }
    const tmp = document.createElement("canvas");
    tmp.width = n; tmp.height = n;
    tmp.getContext("2d").putImageData(img, 0, 0);
    const ctx = cv.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(tmp, 0, 0, n, n, 0, 0, cv.width, cv.height);

    // the style name flashes over the thumbnail right after a click
    if (p.flashUntil && Date.now() < p.flashUntil) {
        ctx.save();
        ctx.globalAlpha = 0.78;
        ctx.fillStyle = "#000";
        ctx.fillRect(0, cv.height - 11, cv.width, 11);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#8fe08f";
        ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(NOISE_SHORT[kind] || kind, cv.width / 2, cv.height - 5);
        ctx.restore();
    }
    cv.title = `Noise: ${kind}${noiseOn ? "" : "  (switched OFF)"}  (click to switch to the next style)\n`
             + `${NOISE_KINDS.join("  /  ")}  -  use the switch in front of the row to turn the noise off\n`
             + `Preview = a slice of the mask edge: the black-to-white band, drawn at its real `
             + `width for the current Edge Blur (1:1, zooming out up to 2x for very soft edges).\n`
             + `The grain fills that whole soft band - a hard edge (no edge blur) means no noise.`;
}

/* one named on/off switch: the checkbox plus its own label track. Clicking the
   name toggles the box as well. */
function mfSwitch(node, grid, o, out, onChange) {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.className = "mf-sw";
    el.title = o.title || "";
    // label-first: the switch sits to the RIGHT of its own name, so the name
    // column is the one every row of that group starts with
    const boxCol = o.labelFirst ? o.col + 1 : o.col;
    const lblCol = o.labelFirst ? o.col : o.col + 1;
    el.style.gridArea = `${o.row} / ${boxCol} / ${o.row + 1} / ${boxCol + 1}`;
    const lbl = document.createElement("span");
    lbl.className = "mf-swlbl";
    lbl.textContent = o.label;
    lbl.title = o.title || "";
    lbl.style.gridArea = `${o.row} / ${lblCol} / ${o.row + 1} / ${lblCol + 1}`;
    const flip = () => { el.checked = !el.checked; setNativeValue(node, o.widgetName, !!el.checked); onChange?.(); };
    el.addEventListener("change", () => { setNativeValue(node, o.widgetName, !!el.checked); onChange?.(); });
    lbl.addEventListener("click", flip);
    out[o.widgetName] = el;
    grid.append(el, lbl);
    return el;
}

/* one label + int field + unit on three neighbouring explicit tracks (label on
   `col`, field on col+1, unit on col+2); the typed value is clamped and pushed
   into the (hidden) native widget the backend actually receives */
function mfNumField(node, grid, o, nums, onChange) {
    const fcol = o.col + 1;
    const lbl = document.createElement("span");
    lbl.className = "mf-lbl"; lbl.textContent = o.label || ""; lbl.title = o.title || "";
    lbl.style.gridArea = `${o.row} / ${o.col} / ${o.row + 1} / ${fcol}`;
    const el = document.createElement("input");
    el.type = "number"; el.className = "mf-num";
    el.min = String(o.min); el.max = String(o.max); el.step = "1"; el.value = String(o.def);
    el.title = o.title || "";
    el.style.gridArea = `${o.row} / ${fcol} / ${o.row + 1} / ${fcol + 1}`;
    const u = document.createElement("span");
    u.className = "mf-unit"; u.textContent = o.unit;
    u.style.gridArea = `${o.row} / ${fcol + 1} / ${o.row + 1} / ${fcol + 2}`;
    const push = () => {
        let v = parseInt(el.value, 10);
        if (isNaN(v)) v = o.def;
        v = Math.max(o.min, Math.min(o.max, v));
        el.value = String(v);
        setNativeValue(node, o.widgetName, v);
        onChange?.();
    };
    el.addEventListener("change", push);
    el.addEventListener("blur", push);
    nums[o.widgetName] = el;
    grid.append(lbl, el, u);
    return el;
}

/* ---- narrow reflow (node dragged in) ------------------------------------
   Hiding the panel's native widgets is not enough: the panel itself has a
   minimum width (max-content labels + 38px fields with spinner arrows) and
   ComfyUI does NOT clip DOM-widget content, so a node dragged narrower than the
   panel painted the overflow outside its own border. In narrow mode every
   control gets its own line, so panel and node shrink together. Keyed by the
   WIDE gridArea the builders assign. Narrow layout: the noise preview across
   the top line, Edge (switch + field) on the left of line 2, Noise on the right
   with Amt/Size below it, fixed-width fields (they must not stretch long), the
   spinner arrows dropped (~13px each) and the two labels the switches already
   name hidden. */
const NARROW_CELLS = {
    // line 1: the noise preview across the whole width
    "1 / 1 / 3 / 2": { area: "1 / 1 / 2 / 9" },
    // line 2: each switch AFTER its own name ("Edge [x]  Noise [x]"), sitting in
    // the same column as that group's number fields below it
    "1 / 2 / 2 / 3": { area: "2 / 1 / 3 / 2" },   // "Edge"
    "1 / 3 / 2 / 4": { area: "2 / 2 / 3 / 3" },   // the Edge switch
    "2 / 2 / 3 / 3": { area: "2 / 5 / 3 / 6" },   // "Noise"
    "2 / 3 / 3 / 4": { area: "2 / 6 / 3 / 7" },   // the Noise switch
    // line 3: the blur fields, each under its own switch
    "1 / 4 / 2 / 5": { area: "3 / 1 / 4 / 2", text: "Blur" },
    "1 / 5 / 2 / 6": { area: "3 / 2 / 4 / 3" },
    "1 / 6 / 2 / 7": { area: "3 / 3 / 4 / 4" },
    "2 / 4 / 3 / 5": { area: "3 / 5 / 4 / 6" },
    "2 / 5 / 3 / 6": { area: "3 / 6 / 4 / 7" },
    "2 / 6 / 3 / 7": { area: "3 / 7 / 4 / 8" },
    // lines 4-5: Amt and Size under the Noise side
    "2 / 7 / 3 / 8": { area: "4 / 5 / 5 / 6" },
    "2 / 8 / 3 / 9": { area: "4 / 6 / 5 / 7" },
    "2 / 9 / 3 / 10": { area: "4 / 7 / 5 / 8" },
    "2 / 10 / 3 / 11": { area: "5 / 5 / 6 / 6" },
    "2 / 11 / 3 / 12": { area: "5 / 6 / 6 / 7" },
    "2 / 12 / 3 / 13": { area: "5 / 7 / 6 / 8" },
};

function applyProcMode(proc, narrow) {
    const mode = narrow ? "narrow" : "wide";
    if (!proc || proc._mode === mode) return;
    proc._mode = mode;
    const grid = proc.grid;
    grid.classList.toggle("mf-narrow", narrow);
    for (const el of Array.from(grid.children)) {
        const wide = el.dataset ? el.dataset.mfWide : null;
        if (!wide) continue;
        const spec = narrow ? NARROW_CELLS[wide] : null;
        el.style.display = spec && spec.hide ? "none" : "";
        el.style.gridArea = (spec && spec.area) ? spec.area : wide;
        // (labels are no longer renamed: the narrow layout keeps "Edge"/"Noise")
        if (spec && spec.text !== undefined) {
            if (el.dataset.mfText === undefined) el.dataset.mfText = el.textContent;
            el.textContent = spec.text;
        } else if (el.dataset.mfText !== undefined) {
            el.textContent = el.dataset.mfText;
        }
    }
    try { proc.resize?.(); } catch (e) { /* ignore */ }
}

/* Wide while the node can hold the wide layout, narrow below that. Compared
   against the measured minimums above - never the panel's own scroll width, since
   the panel is now a centred group of fixed width and no longer reports how much
   room the node has. */
function syncProcMode(node) {
    const proc = node && node.maskflowProc;
    if (!proc || !proc.grid) return;
    const procW = proc.widget;
    const m = (procW && typeof procW.margin === "number") ? procW.margin : 0;
    const avail = (node.size && node.size[0] ? node.size[0] : 0) - PROC_PAD - 4 - m * 2;
    if (!avail) return;
    applyProcMode(proc, avail < PROC_MIN.wide);
}

/* one entry point so every path (sizing, arrange, resize) does the same checks */
function updateProcLayout(node) {
    syncProcMode(node);
    parkProcessWidgetRows(node);
}

function ensureProcessPanel(node) {
    if (node.maskflowProc) return node.maskflowProc;
    const grid = document.createElement("div");
    grid.className = "mf-proc";
    const nums = {}, sw = {};
    const proc = { grid, nums, sw, flashUntil: 0, _flashT: null };
    const redraw = () => drawNoisePreview(node);

    // column 1: the thumbnail (both rows); then a named switch per row
    mfSwitch(node, grid, {
        row: 1, col: 2, labelFirst: true, label: "Edge", widgetName: "blur_on",
        title: "Edge on/off: turn the mask edge feather off to leave the edge hard",
    }, sw, redraw);
    mfSwitch(node, grid, {
        row: 2, col: 2, labelFirst: true, label: "Noise", widgetName: "noise_on",
        title: "Noise on/off: turn the edge grain off without losing the style you picked",
    }, sw, redraw);

    const cv = document.createElement("canvas");
    cv.className = "mf-prev"; cv.width = PREV_PX; cv.height = PREV_PX;
    cv.style.gridArea = "1 / 1 / 3 / 2";
    cv.addEventListener("click", (ev) => {
        ev?.stopPropagation?.();                 // do not drag/select the node
        const kw = findNativeWidget(node, "noise_kind");
        // from a value the list does not contain, the first click lands ON a
        // style instead of stepping past it
        const next = (kw && NOISE_KINDS.includes(kw.value)) ? nextKind(kw.value) : NOISE_KINDS[0];
        setNativeValue(node, "noise_kind", next);
        proc.flashUntil = Date.now() + 1300;     // name flashes over the thumbnail
        clearTimeout(proc._flashT);
        proc._flashT = setTimeout(redraw, 1350);
        redraw();
    });
    grid.append(cv);
    proc.cv = cv;

    // row 1 - mask edge blur, its field on the SAME track as row 2's first field
    mfNumField(node, grid, {
        row: 1, col: 4, label: "Blur", widgetName: "blur",
        min: 0, max: 1000, def: 5, unit: "px",
        title: "Mask edge feather radius in px (a Photoshop-style blur). "
             + "0 = hard edge: no transition band, so there is no noise either.",
    }, nums, redraw);

    // row 2 - Noise Blur first, then Amt, then Size, all on one row
    mfNumField(node, grid, {
        row: 2, col: 4, label: "Blur", widgetName: "noise_blur", min: 0, max: 200, def: 0, unit: "px",
        title: "Blur applied to the noise itself, in px - softens the grain.",
    }, nums, redraw);
    mfNumField(node, grid, {
        row: 2, col: 7, label: "Amt", widgetName: "noise_amount", min: 0, max: 100, def: 50, unit: "%",
        title: "Noise strength / opacity in %. The grain fills the soft (blurred) edge "
             + "and never touches the flat black or white areas.",
    }, nums, redraw);
    mfNumField(node, grid, {
        row: 2, col: 10, label: "Size", widgetName: "noise_size", min: 1, max: 200, def: 1, unit: "px",
        title: "Noise grain size in px - bigger means coarser blobs.",
    }, nums, redraw);

    // remember each element's WIDE placement: the narrow reflow is keyed by it
    for (const el of Array.from(grid.children)) el.dataset.mfWide = el.style.gridArea;
    proc._mode = "wide";
    proc.widget = node.addDOMWidget("maskflow_proc", "MaskFlowProc", grid);
    proc.resize = () => sizeDomBox(node, grid, 8, 40, proc.widget);
    node.maskflowProc = proc;
    proc.resize();
    redraw();
    // One-time safeguard: the labels are max-content and the fields keep room for
    // their spin buttons, so a node narrower than the panel needs would push the
    // grid outside the node. Grow the node (never shrink it) instead of showing
    // squeezed fields.
    setTimeout(() => {
        try {
            const need = grid.scrollWidth, have = grid.clientWidth;
            if (need > have + 4 && typeof node.setSize === "function") {
                const w = Math.round(node.size[0] + (need - have) + 6);
                node.setSize([w, node.size[1]]);
                proc.resize();
                console.log(`[MaskFlow] node widened to ${w}px so the process panel fits`);
            }
        } catch (e) { /* ignore */ }
    }, 120);
    return proc;
}

/* pull the live widget values into the panel: called at creation AND after a
   workflow load (configure) so the panel never disagrees with what will run */
function syncProcessRows(node) {
    const p = node.maskflowProc;
    if (!p) return;
    for (const [name, el] of Object.entries(p.nums)) {
        const w = findNativeWidget(node, name);
        if (!w || !el) continue;
        const v = parseInt(w.value, 10);
        if (!isNaN(v)) el.value = String(v);
    }
    for (const name of ["blur_on", "noise_on"]) {
        const el = p.sw?.[name];
        if (el) el.checked = nativeBool(node, name, true);
    }
    p.resize?.();
    drawNoisePreview(node);
}

/* Park the plugin's DOM widgets in a fixed order (tint controls, then the
   process panel) immediately above the info box. The tint row is hidden in draw
   mode; the process panel is permanent. */
function parkRows(node) {
    const wdg = node.widgets || [];
    const rows = [];
    for (const name of PARK_ORDER) {
        const i = wdg.findIndex(w => w.name === name);
        if (i >= 0) rows.push(wdg.splice(i, 1)[0]);
    }
    if (!rows.length) return;
    const info = wdg.findIndex(w => w.name === "maskflow_panel");
    wdg.splice(info >= 0 ? info : wdg.length, 0, ...rows);
}

function setOurPreviewVisible(node, visible) {
    const p = node.maskflowPrev;
    if (!p) return;
    // A DOM widget's layout slot is freed ONLY by the widget property `hidden`.
    // Verified against frontend 1.51.10: _arrangeWidgets()/getLayoutWidgets() and
    // isWidgetVisible() all test widget.hidden and never the element's CSS, so
    // the old display:"none" left a ~24-28px blank band under the info panel in
    // draw mode. Set both: hidden frees the slot, display keeps it invisible
    // whatever the DOM layer does.
    if (p.widget) p.widget.hidden = !visible;
    p.box.style.display = visible ? "" : "none";
    // re-measure + re-arrange: the tint row is the widget that must sit directly
    // under the info panel, so its slot has to be recomputed on every toggle
    p.resize?.();
    try { node.arrange?.(); } catch (e) { /* ignore */ }
    app.graph.setDirtyCanvas(true, false);
}

app.registerExtension({
    name: "MaskFlow",
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "MaskFlow") return;
        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const n = this;
            panelIdle(n, "MaskFlow — Idle\nRun to see status (or archived-mask info)");
            // two-mode preview switch driven by the draw_mask toggle:
            //   ON  -> old built-in preview visible (editor flow uses it), our panel hidden
            //   OFF -> built-in hidden, our tint-controls panel is THE preview
            ensurePreviewPanel(n);
            // permanent Edge blur / Noise / grain rows: their native widgets are
            // hidden and these rows are what the user actually touches
            ensureProcessPanel(n);
            hideProcessWidgets(n);
            syncProcessRows(n);
            parkTintRow(n);
            const applyMode = () => {
                const dm = (n.widgets || []).find(w => w.name === "draw_mask");
                const on = !dm || dm.value === true || dm.value === "true";
                setOurPreviewVisible(n, !on);
            };
            applyMode();
            const dmw = (n.widgets || []).find(w => w.name === "draw_mask");
            if (dmw) {
                const origCb = dmw.callback;
                dmw.callback = function (v) {
                    const out = origCb?.apply(this, arguments);
                    setTimeout(applyMode, 0);
                    return out;
                };
                const desc = Object.getOwnPropertyDescriptor(dmw, "value");
                if (desc && desc.set) {
                    Object.defineProperty(dmw, "value", {
                        get: desc.get,
                        set(v) { desc.set.call(this, v); setTimeout(applyMode, 0); },
                        configurable: true,
                    });
                }
            }
            return r;
        };
        // After a workflow is loaded the widget values arrive from widgets_values
        // (positionally / by name), so the rows must re-read them - otherwise the
        // rows would show defaults while the backend runs the saved values.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            const r = onConfigure?.apply(this, arguments);
            const n = this;
            setTimeout(() => {
                ensureProcessPanel(n);
                hideProcessWidgets(n);
                syncProcessRows(n);
                parkTintRow(n);
                try { n.arrange?.(); } catch (e) { /* ignore */ }
                try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* ignore */ }
            }, 0);
            return r;
        };
    },
});
