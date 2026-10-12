# Working with agents

claude-as-cad doesn't care how many agents you run or which agent app they live in. The structure
that makes agent-driven CAD work — roles, notes, a design index, a capture rule — lives in plain
files, so it works the same with one agent or ten, in Claude Code, Codex, Cursor, or anything else
that reads an instructions file.

## The project template

[`templates/robot-project/`](../templates/robot-project/) is a starting layout for your CAD project:

```
my-robot/
  AGENTS.md          # roles, read-before-working order, capture rule (every agent reads this)
  CLAUDE.md          # one line, "@AGENTS.md", so Claude Code picks up the same file
  docs/
    README.md        # how the notes are organized
    pitfalls.md      # traps that already cost time
    DESIGN_INDEX.md  # canonical designs, their generators, where their notes live
  builds/
    arm/
      AGENTS.md      # this build's scope, on top of the root rules
      NOTES.md       # learnings specific to this build
  agents/            # optional file inboxes, only if your setup has no messaging
```

Copy it into your project and rename `builds/arm/` to your first build. `AGENTS.md` is the
cross-tool convention; the `CLAUDE.md` files just import it.

**The capture rule** is what replaces "make a note of this." When you confirm something worked or
correct the agent, it records the learning in the right note before moving on, updates the design
index if a canonical design changed, and folds repeatable procedures into existing skills. If
nothing new was learned, it writes nothing.

## Three roles

| Role | Owns | Does |
| --- | --- | --- |
| **Organizer** | `AGENTS.md`, `docs/`, `DESIGN_INDEX.md` | routes requests to the right build, keeps notes structured, catches duplicates |
| **Builder** | one `builds/<category>/` each | writes that category's generators, URDFs, meshes |
| **Interface** | the claude-as-cad viewer for this project | starts it, sends viewer links, reads the edit log |

## How far to take it

**One agent.** Open your agent in the project root. It plays all three roles, reads the right
build folder for each task, and follows the capture rule. Everything works at this level.

**One session per build.** When a project grows, open a separate session in each build folder
(`builds/arm/`, `builds/gripper/`, ...). Each picks up its folder's `AGENTS.md` plus the root rules,
and they stay consistent through the shared notes. In Claude Code you can branch an existing
conversation into a new specialist with `claude --resume <session-id> --fork-session`.

## Recommended: multiple agents per role, talking to each other

This is how the project's author runs claude-as-cad, and the setup we recommend once you're past
the first build:

- **Several agents running at once, one or more per role:** an interface agent, an organizer, and a
  builder per build category. When a category gets big, fork its builder into narrower specialists
  (a lift builder and a wheels builder out of a mobile-base builder, for example).
- **They message each other directly, in whatever setup you already use** — separate terminal
  sessions, your agent app's background or sub-agents, a tmux pane per agent, or plain inbox files
  (`agents/<name>/inbox.md`) when nothing else is available. No new infrastructure is needed.
- **Each agent stays in its lane.** Builders don't edit each other's folders; they message the
  builder that owns it. Only the organizer restructures `docs/` and the design index.

A typical loop:

1. You ask the **organizer** for a change; it routes it to the right **builder**.
2. The builder reads its notes, builds, and asks the **interface** agent for a viewer link.
3. You look, click faces or block out a fix in the editor, and reply to the builder.
4. When you say it's right, the builder captures what it learned; if a design became canonical, it
   tells the organizer, who updates `DESIGN_INDEX.md`.

Agents can also hand finished work beyond CAD — for example, a CAD builder passing a model with
fiducial markers to a calibration and data-recording agent (see the website's "Why" section).
