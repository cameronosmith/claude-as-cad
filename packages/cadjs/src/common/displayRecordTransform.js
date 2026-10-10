import {
  buildPartTransformMatrix
} from "./stepModuleEffects.js";

function applyObjectMatrix(THREE, object3d, matrix) {
  if (!object3d || !(matrix instanceof THREE.Matrix4)) {
    return;
  }
  object3d.matrixAutoUpdate = false;
  const targetMatrix = object3d.matrix instanceof THREE.Matrix4 ? object3d.matrix : new THREE.Matrix4();
  targetMatrix.copy(matrix);
  object3d.matrix = targetMatrix;
  object3d.matrixWorldNeedsUpdate = true;
}

export function composeDisplayRecordEffectMatrix(THREE, record) {
  if (!record || !THREE?.Matrix4) {
    return null;
  }
  const matrices = [
    record.effectMatrix,
    record.explodedViewMatrix
  ].filter((matrix) => matrix instanceof THREE.Matrix4);
  if (!matrices.length) {
    return null;
  }
  const combined = new THREE.Matrix4();
  for (const matrix of matrices) {
    combined.premultiply(matrix);
  }
  return combined;
}

// cad_editor: per-part edit deltas in PART-LOCAL space (row-major 16), keyed by
// partId. Post-multiplied onto the posed base so edits follow joint motion.
const editorPartDeltas = new Map();

export function setEditorPartDeltas(deltasByPartId) {
  editorPartDeltas.clear();
  for (const [partId, delta] of Object.entries(deltasByPartId || {})) {
    if (Array.isArray(delta) && delta.length === 16) {
      editorPartDeltas.set(String(partId), delta);
    }
  }
}

export function composeDisplayRecordObjectMatrix(THREE, record) {
  const baseMatrix = buildPartTransformMatrix(THREE, record?.baseTransform);
  const editorDelta = editorPartDeltas.get(String(record?.partId || ""));
  if (editorDelta) {
    baseMatrix.multiply(buildPartTransformMatrix(THREE, editorDelta));
  }
  const effectMatrix = composeDisplayRecordEffectMatrix(THREE, record);
  return effectMatrix ? effectMatrix.multiply(baseMatrix) : baseMatrix;
}

export function applyDisplayRecordTransform(THREE, record) {
  if (!record) {
    return;
  }
  const combinedMatrix = composeDisplayRecordObjectMatrix(THREE, record);
  applyObjectMatrix(THREE, record.mesh, combinedMatrix);
  applyObjectMatrix(THREE, record.edges, combinedMatrix);
  applyObjectMatrix(THREE, record.silhouette, combinedMatrix);
}
