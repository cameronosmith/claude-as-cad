# Agent instructions

This is a robot CAD project built with [claude-as-cad](https://github.com/cameronosmith/claude-as-cad).
Every agent reads this file before working. Build folders under `builds/` add their own scope on top.

## Roles

Work is split into three roles. One agent can play all three; bigger projects run several agents,
one or more per role (see "Messages between agents" below).

- **Organizer** — owns this file, `docs/`, and `docs/DESIGN_INDEX.md`. Routes requests to the right
  build, keeps the notes structured, and catches duplicate or contradictory notes.
- **Builder** — one per build category in `builds/<category>/` (arm, gripper, mobile base, ...).
  Writes that category's generators, URDFs, and meshes. Its `AGENTS.md` says what it owns.
- **Interface** — runs the claude-as-cad viewer for this project: starts it, sends viewer links,
  reads the edit log. Only changes the viewer itself if the project customizes it.

## Read before working

1. `docs/pitfalls.md` — traps that already cost time.
2. The build you're touching: `builds/<category>/AGENTS.md` and `NOTES.md`, plus
   `docs/DESIGN_INDEX.md` to find the canonical design.
3. The matching skill or recipe, if one exists. Follow it instead of reinventing it.

## Capture rule

When the user **confirms** something worked ("perfect", "that works", "looks good" after
iterating) or **corrects** you (a wrong assumption, a better number, a preferred pattern):

1. Before moving on, write the learning into the right note: the build's `NOTES.md` if it's
   specific to that build, a `docs/` file if it applies across builds. Create one if none fits.
2. If a design or generator changed or became canonical, update `docs/DESIGN_INDEX.md`.
3. If it's a repeatable procedure, add it to the existing skill or recipe (or reference it)
   instead of copying recipe text into notes.
4. If nothing new was learned, write nothing.

Label measured numbers as verified (what was measured, when) and guesses as guesses. Never
quietly turn one into the other.

## claude-as-cad conventions

- **Click-to-reference tags** such as `[holder.stl in link_5 @ (76.0, 107.2, 48.3)mm | local (...)mm ...]`
  are exact. `@` is the robot's base frame in mm; `local` is the STL's own frame. Use them instead
  of estimating coordinates.
- **Editor edits are references.** Read them from `EDIT_LOG.md` (in `CAD_EDITOR_EDITS_DIR`) and
  realize them in the generator. They are never already applied to the CAD.

## Starting a new build category

Create `builds/<category>/` with an `AGENTS.md` (copy `builds/arm/AGENTS.md`) and a `NOTES.md`, add a
row to `docs/DESIGN_INDEX.md`, and give it its own builder agent if the project runs one per build.

## Messages between agents

Use whatever messaging your setup already has (separate sessions, your agent app's background or
sub-agents, tmux panes, ...). If it has none, use files: append a dated note to
`agents/<agent-name>/inbox.md` (newest at the top), then tell the user which agent should read it.
