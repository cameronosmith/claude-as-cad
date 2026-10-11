# claude-as-cad

A browser viewer and editor for robot CAD, built to work alongside Claude Code.

You point at things in 3D; Claude writes the CAD. Click a surface and Claude gets its exact
coordinates. Block out a change by moving parts or dropping in boxes right in the browser, and
keep your design notes next to the CAD so Claude remembers what you've learned. The browser never edits your CAD — every
edit is a reference that your agent turns into real geometry.

claude-as-cad is a fork of the CAD Viewer from
[earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) (MIT), with a reference
editor, an edit log, and click-to-reference added for agent-driven robot design.

## The three ingredients

### 1. Click to reference

Click any object and its 3D point, mesh face, and object ID are copied to your clipboard:

```
[holder.stl in link_5 @ (76.0, 107.2, 48.3)mm | local (12.3, -4.5, 8.1)mm n(0.00, 0.00, -1.00) tri 1423, -X side face]
```

That's the point in the robot's base frame, the same point in the STL's own frame, the face normal,
and the triangle index. Paste it into Claude Code instead of describing "the face on the left
side of the holder."

![Click to reference](docs/media/click_to_reference.gif)

<sub>From the Claude-as-CAD video. The session shown is a re-enactment of a real one.</sub>

### 2. A 3D primitive editor

Move or rotate any object, or drop in a new box, to show Claude exactly where things go when
words are too imprecise. Drag fields left or right, Blender-style; delete parts from the view;
⌘C / ⌘V to duplicate. Edits follow the robot's joints and never overwrite your CAD files.

![3D primitive editor](docs/media/primitive_editor.gif)

<sub>From the Claude-as-CAD video. Re-enactment in the actual editor; the Claude Code side is replayed from a real session.</sub>

### 3. Hierarchical notes

Give each CAD object its own folder, next to notes on servo motor properties, ArUco generators,
pitfalls, and everything learned so far, so Claude starts every task already knowing what
you've figured out. This one is a project habit rather than a feature of this repo: keep the
notes next to your CAD and the viewer's sidebar shows parts and notes side by side.

```
cad/
  docs/
    arm/  camera_mount/  gantry/
    servos.md        # motor dimensions, horn offsets
    aruco_robot.md   # marker generators
    pitfalls.md      # read before generating anything
    DESIGN_INDEX.md
  cadlib/
    aruco.py  beautify.py
```

![Hierarchical notes](docs/media/hierarchical_notes.gif)

<sub>From the Claude-as-CAD video.</sub>

## Putting it together

Place each servo module in the editor, click the faces to connect, and Claude builds the
connectors. When Claude rewrites the model file you have open, the viewer reloads it and keeps
your camera where it was.

![Building an arm: editor on the left, Claude Code on the right](docs/media/arm_build.gif)

<sub>2× speed. Staged replay of a real build session, run in the actual editor.</sub>

## Quick start

Requires Node.js 20+.

```bash
git clone https://github.com/cameronosmith/claude-as-cad.git
cd claude-as-cad
npm install
npm run build
npm run serve -- --dir /path/to/your/cad --port 4178
```

Open `http://127.0.0.1:4178/?file=robots/my_robot.urdf` (`file` is relative to `--dir`). The
sidebar lists every CAD file under `--dir`. The server binds to `127.0.0.1` by default.

Supported files (from the upstream viewer): `.urdf`, `.sdf`, `.srdf`, `.step`/`.stp`, `.stl`,
`.3mf`, `.glb`, `.dxf`, `.gcode`. The editor panel appears for URDF robots.

## Using the editor

| Action | How |
| --- | --- |
| Select a part | Click it (this also copies its reference tag) |
| Change a value | Drag the field left/right · Shift = fine · ⌘/Ctrl = snap · click to type |
| Add a box | **+ Add cube** (40 mm, at the center of the scene) |
| Duplicate | ⌘C / ⌘V (names count up: `cube2`, `holder_2`, …) |
| Remove a part from the view | **Delete part** (restore from the edits list) |
| Undo / redo | ⌘Z / ⇧⌘Z |
| Frame | **World (Z-up)** like Blender, or **Base** to match click-to-reference coordinates |

Rotation and scale pivot on each part's geometry center. Values are in mm and degrees.

## Edits are references, not CAD changes

Nothing you do in the editor is written into your CAD files. Edits live as a draft in your
browser (per model, survives reloads). **Save to edit log** appends a record for your agent:

- `EDIT_LOG.md` — a readable index, newest at the bottom
- `<model>__<timestamp>.json` — exact transforms for every edit

Records are written to `CAD_EDITOR_EDITS_DIR` (default `~/cad_editor_edits`). **Copy edits**
puts the same summary on your clipboard, e.g.

```
MOVE holder.stl (link_4): center (326.6, -0.3, 335.4)mm -> (326.6, -0.3, 385.4)mm | rot (0.0, 0.0, 0.0)deg | scale (1.000, 1.000, 1.000)
CUBE "cube1" (world): center (139.0, 0.6, 284.8)mm | rot (0.0, 0.0, 0.0)deg | size 40.0 x 40.0 x 40.0mm
```

The record format (`stl_delta`, `link_local`, `copies`) is documented in
[docs/edit-log.md](docs/edit-log.md).

By default the edit-log endpoint only accepts requests from the same machine. Set
`CAD_EDITOR_LOG_ALLOW_REMOTE=1` to accept them from other hosts on a network you trust.

## Status

Early (v0.1). claude-as-cad is based on a snapshot of the upstream CAD Viewer (v0.3.8);
upstream has moved on since. The editor is in active use on a real robot-arm project, but expect
rough edges, and file issues when you hit them.

## Credits

- **CAD Viewer** by Thompson Labs LLC, from [earthtojake/text-to-cad](https://github.com/earthtojake/text-to-cad) (MIT) — the viewer, file formats, and app shell this project is built on. For the agent side, see their [agent skills](https://github.com/earthtojake/text-to-cad).
- [three.js](https://threejs.org/) for rendering.
- The reference editor, edit log, and click-to-reference were built by Cameron Smith, developed together with Claude Code agents.

The upstream viewer's detailed configuration and runtime docs are kept in
[docs/viewer.md](docs/viewer.md).

## License

MIT — see [LICENSE](LICENSE). Upstream portions remain © Thompson Labs LLC under the same license.
