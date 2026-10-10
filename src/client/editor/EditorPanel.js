// cad_editor — side pane for numeric part/cube editing (no gizmo by design).
// Fields scrub like Blender: press + drag left/right to slide the value
// (Shift = fine, Ctrl/Cmd = snap); a click without dragging types a value.
import { createContext, useContext, useEffect, useRef, useState } from "react";

const AXES = ["X", "Y", "Z"];
const DRAG_THRESHOLD_PX = 3;
const EditorGestureContext = createContext({ begin: () => {}, end: () => {} });

function formatNumber(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "";
  }
  const rounded = Number(number.toFixed(digits));
  return String(Object.is(rounded, -0) || Math.abs(rounded) < 10 ** -digits ? 0 : rounded);
}

function NumberField({ axis, value, step, drag, snap, digits, onCommit }) {
  const gesture = useContext(EditorGestureContext);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [scrubValue, setScrubValue] = useState(null);
  const inputRef = useRef(null);
  const cancelRef = useRef(false);
  const dragRef = useRef(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => () => dragRef.current?.teardown?.(), []);

  const startEditing = () => {
    setText(formatNumber(value, digits));
    setEditing(true);
  };

  const commitText = (raw) => {
    setEditing(false);
    const number = Number(String(raw).trim());
    if (String(raw).trim() !== "" && Number.isFinite(number) && number !== Number(value)) {
      onCommitRef.current(number);
    }
  };

  const handlePointerDown = (event) => {
    if (event.button !== 0 || editing) {
      return;
    }
    event.preventDefault();
    const element = event.currentTarget;
    const state = {
      startX: event.clientX,
      dx: 0,
      start: Number(value) || 0,
      dragging: false,
      pending: null,
      raf: 0
    };
    const flush = () => {
      state.raf = 0;
      if (state.pending !== null) {
        onCommitRef.current(state.pending);
      }
    };
    // No pointer lock: browsers flash a banner on every lock and emit a bogus
    // jump event when it engages. Plain clientX deltas + pointer capture are robust.
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // capture is optional; window listeners still receive moves
    }
    const onMove = (moveEvent) => {
      state.dx = moveEvent.clientX - state.startX;
      if (!state.dragging) {
        if (Math.abs(state.dx) < DRAG_THRESHOLD_PX) {
          return;
        }
        state.dragging = true;
        gesture.begin();
      }
      let next = state.start + state.dx * drag * (moveEvent.shiftKey ? 0.1 : 1);
      if ((moveEvent.ctrlKey || moveEvent.metaKey) && snap > 0) {
        next = Math.round(next / snap) * snap;
      }
      state.pending = next;
      setScrubValue(next);
      if (!state.raf) {
        state.raf = requestAnimationFrame(flush);
      }
    };
    const teardown = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (state.raf) {
        cancelAnimationFrame(state.raf);
        state.raf = 0;
      }
      dragRef.current = null;
    };
    const onUp = () => {
      teardown();
      if (state.dragging) {
        if (state.pending !== null) {
          onCommitRef.current(state.pending);
        }
        gesture.end();
        setScrubValue(null);
      } else {
        startEditing();
      }
    };
    dragRef.current = { teardown };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <span className="w-2.5 shrink-0 text-[10px] font-medium text-muted-foreground">{axis}</span>
      {editing ? (
        <input
          ref={inputRef}
          className="h-6 w-full min-w-0 rounded border border-primary bg-background px-1 text-right font-mono text-[11px] outline-none"
          inputMode="decimal"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={(event) => {
            if (cancelRef.current) {
              cancelRef.current = false;
              setEditing(false);
              return;
            }
            commitText(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              cancelRef.current = true;
              event.currentTarget.blur();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              const multiplier = event.shiftKey ? 10 : event.altKey ? 0.1 : 1;
              const current = Number(text);
              const next = (Number.isFinite(current) ? current : Number(value) || 0) +
                (event.key === "ArrowUp" ? 1 : -1) * step * multiplier;
              setText(formatNumber(next, digits));
              onCommitRef.current(next);
            }
          }}
        />
      ) : (
        <div
          role="slider"
          tabIndex={0}
          aria-valuenow={Number(value) || 0}
          title="Drag left/right to change (Shift = fine, Ctrl/Cmd = snap). Click to type."
          onPointerDown={handlePointerDown}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              startEditing();
            }
          }}
          className={`group flex h-6 w-full min-w-0 cursor-ew-resize select-none items-center justify-between rounded border px-1 font-mono text-[11px] outline-none focus:border-primary ${scrubValue !== null ? "border-primary bg-primary/10" : "border-border bg-muted/40 hover:bg-muted"}`}
        >
          <span className="text-[9px] text-muted-foreground opacity-0 group-hover:opacity-100">‹</span>
          <span className="truncate">{formatNumber(scrubValue ?? value, digits)}</span>
          <span className="text-[9px] text-muted-foreground opacity-0 group-hover:opacity-100">›</span>
        </div>
      )}
    </div>
  );
}

function VectorRow({ label, values, step, drag, snap, digits, onCommit }) {
  return (
    <div className="space-y-0.5">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="flex gap-1.5">
        {AXES.map((axis, index) => (
          <NumberField
            key={axis}
            axis={axis}
            value={Array.isArray(values) ? values[index] : 0}
            step={step}
            drag={drag}
            snap={snap}
            digits={digits}
            onCommit={(next) => onCommit(index, next)}
          />
        ))}
      </div>
    </div>
  );
}

function PanelButton({ children, onClick, disabled = false, tone = "default", title }) {
  const tones = {
    default: "border-border bg-background hover:bg-muted",
    primary: "border-primary bg-primary text-primary-foreground hover:opacity-90",
    danger: "border-border bg-background text-red-500 hover:bg-red-500/10"
  };
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`h-7 rounded border px-2 text-[11px] font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${tones[tone] || tones.default}`}
    >
      {children}
    </button>
  );
}

export default function EditorPanel({
  style,
  frameLink,
  frameMode = "world",
  onFrameModeChange,
  selection,
  partFields,
  cubeFields,
  cubeName,
  cubeLink,
  linkNames,
  editedItems,
  dirty,
  saving,
  status,
  sidecarPath,
  onPartField,
  onResetPart,
  onDeletePart,
  onRestorePart,
  onCubeField,
  onCubeName,
  onCubeLink,
  onDeleteCube,
  onAddCube,
  onSelectItem,
  onSave,
  onCopy,
  onRevertAll,
  onGestureStart,
  onGestureEnd,
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo
}) {
  const gestureRef = useRef({ begin: () => {}, end: () => {} });
  gestureRef.current = {
    begin: () => onGestureStart?.(),
    end: () => onGestureEnd?.()
  };
  const [gestureValue] = useState(() => ({
    begin: () => gestureRef.current.begin(),
    end: () => gestureRef.current.end()
  }));
  const [collapsed, setCollapsed] = useState(false);
  const [nameDraft, setNameDraft] = useState(cubeName || "");
  const frameLabel = frameMode === "base" ? `${frameLink} frame` : "world, Z-up";

  useEffect(() => {
    setNameDraft(cubeName || "");
  }, [cubeName, selection?.id]);

  const commitName = () => {
    const next = nameDraft.trim();
    if (next && next !== cubeName) {
      onCubeName(next);
    } else {
      setNameDraft(cubeName || "");
    }
  };

  return (
    <div
      style={style}
      className="pointer-events-auto fixed z-40 w-[300px] rounded-lg border border-border bg-background/95 text-foreground shadow-xl backdrop-blur"
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">Primitive editor</span>
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-600">fork</span>
          {dirty ? <span className="text-[10px] text-amber-600" title="Changed since the last Save to edit log">● not logged</span> : null}
        </div>
        <button
          type="button"
          className="text-[11px] text-muted-foreground hover:text-foreground"
          onClick={() => setCollapsed((value) => !value)}
        >
          {collapsed ? "Show" : "Hide"}
        </button>
      </div>

      {collapsed ? null : (
        <EditorGestureContext.Provider value={gestureValue}>
        <div className="max-h-[calc(100vh-140px)] space-y-3 overflow-y-auto px-3 py-2.5 text-[11px]">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Frame</span>
            <div className="flex overflow-hidden rounded border border-border">
              {[
                { id: "world", label: "World (Z-up)", title: "Viewer world frame, Z up — like Blender" },
                { id: "base", label: "Base", title: "Base-link frame — matches click-to-reference coords and cad" }
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  title={option.title}
                  onClick={() => onFrameModeChange?.(option.id)}
                  className={`px-2 py-0.5 text-[10px] ${frameMode === option.id ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted"}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          {selection ? (
            <div className="space-y-2">
              <div>
                {selection.kind === "cube" || selection.kind === "copy" ? (
                  <input
                    className="h-7 w-full rounded border border-border bg-background px-2 text-xs font-semibold outline-none focus:border-primary"
                    value={nameDraft}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onBlur={commitName}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.currentTarget.blur();
                      } else if (event.key === "Escape") {
                        setNameDraft(cubeName || "");
                      }
                    }}
                  />
                ) : (
                  <div className="truncate text-xs font-semibold" title={selection.title}>{selection.title}</div>
                )}
                <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                  {selection.kind === "cube" || selection.kind === "copy" ? (
                    <>
                      <span>{selection.kind === "copy" ? `${selection.subtitle} · parent` : "cube · parent"}</span>
                      <select
                        className="h-5 rounded border border-border bg-background px-1 text-[10px]"
                        value={cubeLink || ""}
                        onChange={(event) => onCubeLink(event.target.value)}
                      >
                        {(linkNames || []).map((name) => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <span className="truncate">{selection.subtitle}{selection.edited ? " · edited" : ""}</span>
                  )}
                </div>
              </div>

              {selection.kind === "part" && selection.deleted ? (
                <div className="space-y-2">
                  <div className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-600">
                    Removed from the view (reference edit — the CAD still has this part).
                  </div>
                  <PanelButton onClick={onRestorePart} title="Bring the part back">Restore part</PanelButton>
                </div>
              ) : null}

              {((selection.kind === "part" && !selection.deleted) || selection.kind === "copy") && partFields ? (
                <>
                  <VectorRow label={`Location (mm, ${frameLabel}, geometry center)`} values={partFields.location_mm} step={1} drag={0.5} snap={1} digits={2} onCommit={(index, value) => onPartField("location_mm", index, value)} />
                  <VectorRow label="Rotation (deg, about center)" values={partFields.rotation_deg} step={1} drag={0.5} snap={5} digits={2} onCommit={(index, value) => onPartField("rotation_deg", index, value)} />
                  <VectorRow label="Scale" values={partFields.scale} step={0.05} drag={0.005} snap={0.05} digits={4} onCommit={(index, value) => onPartField("scale", index, value)} />
                  {selection.kind === "copy" ? (
                    <div className="flex gap-1.5">
                      <PanelButton tone="danger" onClick={onDeleteCube} title="Remove this copy (undo with ⌘Z)">Delete copy</PanelButton>
                    </div>
                  ) : (
                    <div className="flex gap-1.5">
                      <PanelButton onClick={onResetPart} disabled={!selection.edited} title="Restore this part's original placement">Reset part</PanelButton>
                      <PanelButton tone="danger" onClick={onDeletePart} title="Remove this part from the view (reference edit; undo with ⌘Z)">Delete part</PanelButton>
                    </div>
                  )}
                </>
              ) : null}

              {selection.kind === "cube" && cubeFields ? (
                <>
                  <VectorRow label={`Location (mm, ${frameLabel}, center)`} values={cubeFields.location_mm} step={1} drag={0.5} snap={1} digits={2} onCommit={(index, value) => onCubeField("location_mm", index, value)} />
                  <VectorRow label="Rotation (deg)" values={cubeFields.rotation_deg} step={1} drag={0.5} snap={5} digits={2} onCommit={(index, value) => onCubeField("rotation_deg", index, value)} />
                  <VectorRow label="Size (mm)" values={cubeFields.size_mm} step={1} drag={0.5} snap={1} digits={2} onCommit={(index, value) => onCubeField("size_mm", index, value)} />
                  <div className="flex gap-1.5">
                    <PanelButton tone="danger" onClick={onDeleteCube}>Delete cube</PanelButton>
                  </div>
                </>
              ) : null}
            </div>
          ) : (
            <div className="text-muted-foreground">Click a part to edit its location, rotation and scale, or add a cube. ⌘C / ⌘V copies and pastes the selection.</div>
          )}

          <div className="border-t border-border pt-2.5">
            <PanelButton onClick={onAddCube} title="Adds a 20mm cube at the selected part (or the frame origin)">+ Add cube</PanelButton>
          </div>

          {editedItems?.length ? (
            <div className="space-y-1 border-t border-border pt-2.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Edits ({editedItems.length})</div>
              <div className="flex flex-col gap-0.5">
                {editedItems.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectItem(item)}
                    className={`truncate rounded px-1.5 py-0.5 text-left hover:bg-muted ${selection?.id === item.id ? "bg-muted font-semibold" : ""}`}
                    title={item.label}
                  >
                    {item.kind === "cube" ? "▣ " : item.kind === "copy" ? "⧉ " : "↔ "}{item.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5 border-t border-border pt-2.5">
            <div className="flex flex-wrap gap-1.5">
              <PanelButton onClick={onUndo} disabled={!canUndo} title="Undo last edit (⌘Z / Ctrl+Z)">↶ Undo</PanelButton>
              <PanelButton onClick={onRedo} disabled={!canRedo} title="Redo (⇧⌘Z / Ctrl+Shift+Z)">↷ Redo</PanelButton>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <PanelButton tone="primary" onClick={onSave} disabled={saving || !editedItems?.length} title="Append these reference edits to the edit log (CAD_EDITOR_EDITS_DIR on the server, default ~/cad_editor_edits) for your agent — the CAD is not changed">{saving ? "Logging…" : "Save to edit log"}</PanelButton>
              <PanelButton onClick={onCopy} disabled={!editedItems?.length} title="Copy a summary of the edits to paste to cad">Copy edits</PanelButton>
              <PanelButton tone="danger" onClick={onRevertAll} disabled={!editedItems?.length} title="Drop all unsaved and saved edits in this session">Revert all</PanelButton>
            </div>
            {status ? <div className="break-words text-[10px] text-muted-foreground">{status}</div> : null}
            <div className="text-[10px] text-muted-foreground">Reference edits only — kept in this browser; the CAD is never changed.</div>
            {sidecarPath ? <div className="break-all font-mono text-[9px] text-muted-foreground/80">last logged: {sidecarPath}</div> : null}
          </div>
        </div>
        </EditorGestureContext.Provider>
      )}
    </div>
  );
}
