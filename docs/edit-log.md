# Edit log format

Edits made in the claude-as-cad editor are **reference-only**: they are never written into your
CAD files. Clicking **Save to edit log** appends one record to the edits directory
(`CAD_EDITOR_EDITS_DIR`, default `~/cad_editor_edits`):

```
EDIT_LOG.md                              # readable index, newest entry at the bottom
<model>__<YYYYMMDD-HHMMSS>.json          # one record per save, exact transforms
```

Each `EDIT_LOG.md` entry names the model, links its JSON record, and repeats the human-readable
summary (the same text as **Copy edits**). An agent such as Claude Code reads the entry and
decides how to realize it in your generator scripts or URDF.

## Record fields

```jsonc
{
  "format": "cad_editor.edits/v1",
  "reference_only": true,
  "urdf": "robots/arm.urdf",
  "model_path": "/abs/path/to/robots/arm.urdf",   // added by the server
  "logged_at": "2026-10-09T18:03:22.000Z",
  "summary_text": "MOVE …\nCUBE …",
  "frame": "world",                               // link whose frame the readable fields use
  "joints_at_save": { "j1": 0, "j2": 15 },        // pose the readable fields were taken at
  "conventions": { … },                           // these definitions, embedded in every record
  "parts":  [ … ],
  "cubes":  [ … ],
  "copies": [ … ]
}
```

All matrices are **row-major 4×4** arrays of 16 numbers.

An agent that has applied a record may add `"realized": "<ISO time>"` to it as bookkeeping. The editor itself
doesn't rely on this: open drafts pause automatically when the model changes on disk (see the README).

### `parts[]` — edits to existing parts

| Field | Meaning |
| --- | --- |
| `key` | Stable part id: `link\|mesh.stl\|occurrence` |
| `link`, `mesh` | Parent link and STL file name |
| `stl_delta` | Transform in the **STL's own frame, in mm**: `new_vertex = stl_delta · old_vertex`. Pose-independent, so it follows the part's link. |
| `deleted` | `true` if the part was removed from the view |
| `location_mm`, `rotation_deg`, `scale`, `original_center_mm` | Readable values in `frame` at `joints_at_save` |

### `cubes[]` — boxes added in the editor

| Field | Meaning |
| --- | --- |
| `name`, `link` | Box name and the link it is attached to |
| `link_local` | Places a **1 m unit cube centered at its origin** in the parent link's frame (meters). The box size is carried in the scale. |
| `location_mm`, `rotation_deg`, `size_mm` | Readable values in `frame` at `joints_at_save` |

### `copies[]` — duplicated parts (⌘C / ⌘V)

| Field | Meaning |
| --- | --- |
| `name` | Copy name, e.g. `holder_2` |
| `source.mesh`, `source.key` | The STL that was duplicated |
| `link` | The link the copy is attached to |
| `link_placement` | STL (mm) → parent-link frame (m) |
| `stl_delta` | Further STL-local edit (mm) |

World placement of a copy: `world = link_world · link_placement · stl_delta`.

## Conventions

- `rotation_deg` is fixed-axis X, then Y, then Z — the same order as URDF `rpy` (and Blender's XYZ Euler).
- `scale` is applied along the frame's axes before rotation, pivoting on the part's geometry center.
- `frame` names the link whose frame the readable fields use: the URDF root link (**World** mode, Z-up) or the base link (**Base** mode).
