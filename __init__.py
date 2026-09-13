"""ComfyUI-MaskFlow: file-versioned mask editor node.

Borrows ComfyUI's official MaskEditor UI (no custom painting UI). Adds:
- countdown auto-save and a file-versioned mask archive under
  output/MaskFlow/<source image name>/vNNNNN.png (the source name is resolved
  backend-side from the executing prompt graph)
- mode switch: "draw mask" (opens the editor) vs "load from output"
- post-processing on the node itself: invert, an edge feather (Edge Blur) and a
  switchable edge-noise style (grayscale; the grain fills the soft band, so a
  hard edge gets none)
- cache via fingerprint_inputs returning the mask file mtime (ComfyUI-native
  semantics)
- the node panel is one web extension: web/maskflow.js

The node is registered through comfy_entrypoint (the V3 node API), so there is
deliberately no NODE_CLASS_MAPPINGS here: ComfyUI's loader tests that mapping
first and would take the older V1 registration path instead.
"""

VERSION = "1.0.0"
WEB_DIRECTORY = "./web"
__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]

from comfy_api.latest import ComfyExtension, io

from .nodes import MaskFlow


class MaskFlowExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [MaskFlow]


async def comfy_entrypoint() -> ComfyExtension:
    return MaskFlowExtension()
