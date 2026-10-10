// cad_editor — pure frame/delta math for the primitive editor.
//
// Spaces (all THREE.Matrix4 unless noted):
//   part-local  : the STL's own coordinates (mm)
//   world       : the viewer modelGroup space == URDF solve world (meters)
//   frame       : the editor/display frame = "base" link (meters internally, mm in the UI)
//
// A part edit is stored as `delta` (row-major 16) in PART-LOCAL space, so the
// rendered object is  part.transform · delta. Because part.transform is the
// posed FK placement, edits follow the joints for free, and cad can apply an
// edit by transforming the STL vertices: v' = delta · v  (mm).
//
// UI fields (Blender "origin to geometry" semantics, in the base frame):
//   location_mm  : where the part's geometry center sits
//   rotation_deg : fixed-axis X→Y→Z (== URDF rpy == Blender XYZ euler), about the center
//   scale        : per-axis factors in base axes, applied before rotation (Blender object scale)
import * as THREE from "three";
import { solveUrdfLinkWorldTransforms } from "cadjs/lib/urdf/kinematics";

export const EDITOR_SIDECAR_FORMAT = "cad_editor.edits/v1";
export const EULER_ORDER = "ZYX";
const DEG = Math.PI / 180;
const MIN_SCALE = 1e-4;

export function matrixFromRowMajor(values) {
  const matrix = new THREE.Matrix4();
  if (Array.isArray(values) && values.length === 16) {
    matrix.set(...values.map((value) => Number(value) || 0));
  }
  return matrix;
}

export function rowMajorFromMatrix(matrix) {
  const e = matrix.elements;
  return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]];
}

export function isNearIdentity(values, epsilon = 1e-9) {
  if (!Array.isArray(values) || values.length !== 16) {
    return true;
  }
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return values.every((value, index) => Math.abs(value - identity[index]) <= epsilon);
}

export function editorFrameLinkName(urdfData) {
  const links = Array.isArray(urdfData?.links) ? urdfData.links : [];
  return links.some((link) => link?.name === "base") ? "base" : String(urdfData?.rootLink || "");
}

export function linkWorldMatrices(urdfData, jointValues) {
  const matrices = new Map();
  if (!urdfData) {
    return matrices;
  }
  for (const [name, transform] of solveUrdfLinkWorldTransforms(urdfData, jointValues || {}).entries()) {
    matrices.set(name, matrixFromRowMajor(transform));
  }
  return matrices;
}

export function meshFileFromUrl(url) {
  let raw = String(url || "");
  if (!raw) {
    return "";
  }
  const fileParam = raw.match(/[?&]file=([^&]*)/);
  if (fileParam) {
    try {
      raw = decodeURIComponent(fileParam[1]);
    } catch {
      raw = fileParam[1];
    }
  }
  return raw.split(/[?#]/)[0].split(/[/\\]/).filter(Boolean).pop() || "";
}

// Stable, human-readable keys for URDF visual parts: "link|mesh.stl|occurrence".
export function buildEditorPartIndex(parts) {
  const list = Array.isArray(parts) ? parts : [];
  const counts = new Map();
  const entries = [];
  for (const part of list) {
    const partId = String(part?.id || "");
    if (!partId) {
      continue;
    }
    const link = String(part?.linkName || "");
    const mesh = meshFileFromUrl(part?.meshUrl || part?.partFileRef || part?.sourceMeshKey) || String(part?.name || partId);
    const baseKey = `${link}|${mesh}`;
    const occurrence = counts.get(baseKey) || 0;
    counts.set(baseKey, occurrence + 1);
    entries.push({ key: `${baseKey}|${occurrence}`, partId, link, mesh, occurrence, part });
  }
  return entries;
}

function boundsCenter(bounds) {
  const min = bounds?.min;
  const max = bounds?.max;
  if (!Array.isArray(min) || !Array.isArray(max)) {
    return new THREE.Vector3();
  }
  return new THREE.Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
}

function vectorMm(vector) {
  return [vector.x * 1000, vector.y * 1000, vector.z * 1000];
}

function composeFrameTransform(locationMm, rotationDeg, scale) {
  const location = new THREE.Vector3(...locationMm.map((value) => (Number(value) || 0) / 1000));
  const rotation = new THREE.Euler(...rotationDeg.map((value) => (Number(value) || 0) * DEG), EULER_ORDER);
  const scaleVector = new THREE.Vector3(...scale.map((value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || Math.abs(number) < MIN_SCALE) {
      return MIN_SCALE;
    }
    return number;
  }));
  return new THREE.Matrix4().compose(location, new THREE.Quaternion().setFromEuler(rotation), scaleVector);
}

function decomposeFrameTransform(matrix) {
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, quaternion, scale);
  const euler = new THREE.Euler().setFromQuaternion(quaternion, EULER_ORDER);
  return {
    position,
    rotation_deg: [euler.x / DEG, euler.y / DEG, euler.z / DEG],
    scale: [scale.x, scale.y, scale.z]
  };
}

// ---- parts -----------------------------------------------------------------

export function partEditContext(part, frameWorld) {
  if (!part || !frameWorld) {
    return null;
  }
  const base = matrixFromRowMajor(part.transform);
  if (Math.abs(base.determinant()) < 1e-18) {
    return null;
  }
  const centerLocal = boundsCenter(part.sourceBounds || part.bounds);
  const frameInverse = frameWorld.clone().invert();
  const centerFrame = centerLocal.clone().applyMatrix4(base).applyMatrix4(frameInverse);
  return { base, baseInverse: base.clone().invert(), frameWorld, frameInverse, centerFrame };
}

export function partFieldsFromDelta(context, delta) {
  if (!context) {
    return null;
  }
  const deltaMatrix = delta ? matrixFromRowMajor(delta) : new THREE.Matrix4();
  const deltaWorld = context.base.clone().multiply(deltaMatrix).multiply(context.baseInverse);
  const deltaFrame = context.frameInverse.clone().multiply(deltaWorld).multiply(context.frameWorld);
  const location = context.centerFrame.clone().applyMatrix4(deltaFrame);
  const linear = deltaFrame.clone().setPosition(0, 0, 0);
  const { rotation_deg, scale } = decomposeFrameTransform(linear);
  return {
    location_mm: vectorMm(location),
    rotation_deg,
    scale,
    original_center_mm: vectorMm(context.centerFrame)
  };
}

export function deltaFromPartFields(context, fields) {
  if (!context || !fields) {
    return null;
  }
  const pivot = context.centerFrame;
  const deltaFrame = composeFrameTransform(fields.location_mm, fields.rotation_deg, fields.scale)
    .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
  const deltaWorld = context.frameWorld.clone().multiply(deltaFrame).multiply(context.frameInverse);
  return rowMajorFromMatrix(context.baseInverse.clone().multiply(deltaWorld).multiply(context.base));
}

// ---- cubes -----------------------------------------------------------------
// A cube is a unit box (1 m) placed by `local` (row-major 16) in its parent
// link's frame; size lives in the scale, so world = linkWorld · local.

export function cubeWorldRowMajor(cube, linkWorlds) {
  const linkWorld = linkWorlds.get(cube.link);
  if (!linkWorld) {
    return null;
  }
  return rowMajorFromMatrix(linkWorld.clone().multiply(matrixFromRowMajor(cube.local)));
}

export function cubeFieldsFromLocal(cube, linkWorlds, frameWorld) {
  const linkWorld = linkWorlds.get(cube.link);
  if (!linkWorld || !frameWorld) {
    return null;
  }
  const inFrame = frameWorld.clone().invert().multiply(linkWorld).multiply(matrixFromRowMajor(cube.local));
  const { position, rotation_deg, scale } = decomposeFrameTransform(inFrame);
  return {
    location_mm: vectorMm(position),
    rotation_deg,
    size_mm: scale.map((value) => value * 1000)
  };
}

export function cubeLocalFromFields(fields, linkName, linkWorlds, frameWorld) {
  const linkWorld = linkWorlds.get(linkName);
  if (!linkWorld || !frameWorld) {
    return null;
  }
  const inFrame = composeFrameTransform(
    fields.location_mm,
    fields.rotation_deg,
    fields.size_mm.map((value) => (Number(value) || 0) / 1000)
  );
  return rowMajorFromMatrix(linkWorld.clone().invert().multiply(frameWorld).multiply(inFrame));
}

// ---- part copies (pasted CAD parts) ------------------------------------------
// A copy reuses the source STL's geometry. `local` places STL-mm geometry in the parent link
// frame (pose-independent, like a cube's local) and `delta` is a part-style STL-local edit.

function frameOffsetWorld(frameWorld, offsetMm) {
  const offset = new THREE.Matrix4().makeTranslation(
    (Number(offsetMm?.[0]) || 0) / 1000,
    (Number(offsetMm?.[1]) || 0) / 1000,
    (Number(offsetMm?.[2]) || 0) / 1000
  );
  return frameWorld.clone().multiply(offset).multiply(frameWorld.clone().invert());
}

export function meshCopyWorldRowMajor(object, linkWorlds) {
  const linkWorld = linkWorlds.get(object.link);
  if (!linkWorld) {
    return null;
  }
  const world = linkWorld.clone().multiply(matrixFromRowMajor(object.local));
  if (Array.isArray(object.delta) && object.delta.length === 16) {
    world.multiply(matrixFromRowMajor(object.delta));
  }
  return rowMajorFromMatrix(world);
}

export function meshCopyContext(object, linkWorlds, frameWorld) {
  const linkWorld = linkWorlds.get(object.link);
  if (!linkWorld || !frameWorld) {
    return null;
  }
  return partEditContext({
    transform: rowMajorFromMatrix(linkWorld.clone().multiply(matrixFromRowMajor(object.local))),
    sourceBounds: object.sourceBounds
  }, frameWorld);
}

export function meshLocalFromPart(part, partDelta, link, linkWorlds, frameWorld, offsetMm) {
  const linkWorld = linkWorlds.get(link);
  if (!linkWorld || !frameWorld || !part) {
    return null;
  }
  const placed = matrixFromRowMajor(part.transform);
  if (Array.isArray(partDelta) && partDelta.length === 16) {
    placed.multiply(matrixFromRowMajor(partDelta));
  }
  const world = frameOffsetWorld(frameWorld, offsetMm).multiply(placed);
  return rowMajorFromMatrix(linkWorld.clone().invert().multiply(world));
}

export function offsetLocalInFrame(local, link, linkWorlds, frameWorld, offsetMm) {
  const linkWorld = linkWorlds.get(link);
  if (!linkWorld || !frameWorld) {
    return null;
  }
  const world = frameOffsetWorld(frameWorld, offsetMm).multiply(linkWorld).multiply(matrixFromRowMajor(local));
  return rowMajorFromMatrix(linkWorld.clone().invert().multiply(world));
}

export function reparentLocal(local, fromLink, toLink, linkWorlds) {
  const from = linkWorlds.get(fromLink);
  const to = linkWorlds.get(toLink);
  if (!from || !to) {
    return null;
  }
  return rowMajorFromMatrix(to.clone().invert().multiply(from).multiply(matrixFromRowMajor(local)));
}

// "cube1" -> next free "cubeN"; anything else -> "<base>_2", "<base>_3", … (".stl" and an
// existing "_N" suffix are stripped first, so copying "x_2" gives "x_3").
export function nextCopyName(name, existingNames) {
  const taken = new Set(existingNames || []);
  if (/^cube\d+$/.test(String(name))) {
    let index = 1;
    while (taken.has(`cube${index}`)) {
      index += 1;
    }
    return `cube${index}`;
  }
  const base = String(name || "copy").replace(/\.stl$/i, "").replace(/_\d+$/, "");
  let index = 2;
  while (taken.has(`${base}_${index}`)) {
    index += 1;
  }
  return `${base}_${index}`;
}

export function boundsCenterInFrameMm(bounds, frameWorld) {
  if (!frameWorld || !Array.isArray(bounds?.min) || !Array.isArray(bounds?.max)) {
    return null;
  }
  const center = boundsCenter(bounds).applyMatrix4(frameWorld.clone().invert());
  return vectorMm(center);
}

// ---- reporting -------------------------------------------------------------

export function describeMeshCopy(object, fields) {
  return `COPY "${object.name}" of ${object.mesh} (${object.link}): center ${fmt(fields.location_mm)}mm | rot ${fmt(fields.rotation_deg)}deg | scale ${fmt(fields.scale, 3)}`;
}

const fmt = (values, digits = 1) => `(${values.map((value) => Number(value).toFixed(digits)).join(", ")})`;

export function describePartEdit(entry, fields) {
  return `MOVE ${entry.mesh} (${entry.link}): center ${fmt(fields.original_center_mm)}mm -> ${fmt(fields.location_mm)}mm | rot ${fmt(fields.rotation_deg)}deg | scale ${fmt(fields.scale, 3)}`;
}

export function describePartDelete(entry, fields) {
  const where = fields ? ` (center ${fmt(fields.original_center_mm)}mm)` : "";
  return `DELETE ${entry.mesh} (${entry.link})${where}`;
}

export function describeCube(cube, fields) {
  return `CUBE "${cube.name}" (${cube.link}): center ${fmt(fields.location_mm)}mm | rot ${fmt(fields.rotation_deg)}deg | size ${fields.size_mm.map((value) => Number(value).toFixed(1)).join(" x ")}mm`;
}
