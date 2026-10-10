"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Navigation2 } from "lucide-react";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { copyImageBlobToClipboard } from "@/ui/clipboard";
import { triggerBlobDownload } from "@/ui/download";
import { isEditableTarget } from "@/ui/dom";
import {
  createImplicitCadFullscreenScene,
  implicitCadCameraState,
  implicitCadModelShaderKey,
  refreshImplicitCadFloorBounds,
  updateImplicitCadAppearanceUniforms,
  updateImplicitCadGraphicsUniforms,
  updateImplicitCadModelUniforms,
  updateImplicitCadMaterialUniforms
} from "implicitjs/render";
import {
  implicitGraphicsRenderResolutionScale,
  implicitGraphicsRenderSettings,
  normalizeImplicitGraphicsSettings
} from "@/workbench/implicitGraphicsSettings";
import ViewPlaneControl from "./viewer/ViewPlaneControl";
import {
  PREVIEW_AUTO_ROTATE_SPEED,
  updateOrbitControls
} from "./viewer/orbitControls.js";

const INTERACTION_IDLE_DELAY_MS = 140;
const DEFAULT_DAMPING_FACTOR = 0.14;
const DEFAULT_ZOOM_SPEED = 4.5;
const ACCELERATED_WHEEL_ZOOM_SPEED = 10;
const TRACKPAD_PINCH_ZOOM_SPEED = 14;
const KEYBOARD_ORBIT_NUDGE_RAD = Math.PI / 32;
const KEYBOARD_ORBIT_SPEED_RAD_PER_SEC = Math.PI * 0.42;
const KEYBOARD_POLAR_EPSILON = 0.02;
const DEFAULT_VIEW_DIRECTION = Object.freeze([2.1, -1.65, 1.08]);
const WORLD_UP = Object.freeze([0, 0, 1]);
const CAMERA_UP_PARALLEL_DOT_THRESHOLD = 0.9;
const VIEW_PLANE_ACTIVE_DOT_THRESHOLD = 0.994;
const VIEW_PLANE_TRANSITION_MS = 280;
const DEFAULT_FOV_DEG = 48;
const IMPLICIT_CAMERA_VERSION = 8;
const AUTO_ZOOM_FRAME_MARGIN = 1.08;
const AUTO_ZOOM_SPEED_MS = 400;
const RESET_VIEW_CONTROL_BUTTON_CLASSES = "cad-glass-surface pointer-events-auto grid h-8 w-8 shrink-0 place-items-center rounded-full border border-sidebar-border text-sidebar-foreground/60 shadow-sm transition duration-150 hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45";
const VIEW_PLANE_FACES = [
  { id: "z", title: "Jump to top view", direction: [0, 0, 1], up: [0, 1, 0] },
  { id: "zNeg", title: "Jump to bottom view", direction: [0, 0, -1], up: [0, 1, 0] },
  { id: "yNeg", title: "Jump to front view", direction: [0, -1, 0], up: WORLD_UP },
  { id: "y", title: "Jump to back view", direction: [0, 1, 0], up: WORLD_UP },
  { id: "x", title: "Jump to right view", direction: [1, 0, 0], up: WORLD_UP },
  { id: "xNeg", title: "Jump to left view", direction: [-1, 0, 0], up: WORLD_UP }
];
const VIEW_PLANE_FACE_BY_ID = Object.fromEntries(VIEW_PLANE_FACES.map((face) => [face.id, face]));

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function easeInOutCubic(value) {
  const t = clamp(value, 0, 1);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cameraUpForDirection(direction, preferredUp = WORLD_UP) {
  const viewDirection = new THREE.Vector3(...(direction || []));
  const up = new THREE.Vector3(...(preferredUp || WORLD_UP));
  if (viewDirection.lengthSq() < 1e-6) {
    return up.lengthSq() < 1e-6 ? new THREE.Vector3(...WORLD_UP) : up.normalize();
  }
  viewDirection.normalize();
  if (up.lengthSq() < 1e-6) {
    up.set(...WORLD_UP);
  }
  up.normalize();
  if (Math.abs(viewDirection.dot(up)) < CAMERA_UP_PARALLEL_DOT_THRESHOLD) {
    return up;
  }
  const fallbackUp = new THREE.Vector3(0, 1, 0);
  if (Math.abs(viewDirection.dot(fallbackUp)) < CAMERA_UP_PARALLEL_DOT_THRESHOLD) {
    return fallbackUp;
  }
  return new THREE.Vector3(1, 0, 0);
}

function isTrackpadLikeWheelEvent(event) {
  return event.ctrlKey || (event.deltaMode === 0 && Math.abs(event.deltaY) < 20);
}

function getKeyboardOrbitCommand(event) {
  if (!event) {
    return null;
  }
  if (event.key === "ArrowLeft") {
    return { direction: "left", keyId: "ArrowLeft" };
  }
  if (event.key === "ArrowRight") {
    return { direction: "right", keyId: "ArrowRight" };
  }
  if (event.key === "ArrowUp") {
    return { direction: "up", keyId: "ArrowUp" };
  }
  if (event.key === "ArrowDown") {
    return { direction: "down", keyId: "ArrowDown" };
  }

  const key = String(event.key || "").toLowerCase();
  if (key === "a" || event.code === "KeyA") {
    return { direction: "left", keyId: event.code || "KeyA" };
  }
  if (key === "d" || event.code === "KeyD") {
    return { direction: "right", keyId: event.code || "KeyD" };
  }
  if (key === "w" || event.code === "KeyW") {
    return { direction: "up", keyId: event.code || "KeyW" };
  }
  if (key === "s" || event.code === "KeyS") {
    return { direction: "down", keyId: event.code || "KeyS" };
  }
  return null;
}

function getKeyboardOrbitAxes(keyboardOrbitState) {
  return {
    azimuth:
      (keyboardOrbitState.directionCounts.right > 0 ? 1 : 0) -
      (keyboardOrbitState.directionCounts.left > 0 ? 1 : 0),
    polar:
      (keyboardOrbitState.directionCounts.down > 0 ? 1 : 0) -
      (keyboardOrbitState.directionCounts.up > 0 ? 1 : 0)
  };
}

function clearKeyboardOrbitState(keyboardOrbitState) {
  if (!keyboardOrbitState) {
    return;
  }
  keyboardOrbitState.pressedKeys.clear();
  keyboardOrbitState.directionCounts.left = 0;
  keyboardOrbitState.directionCounts.right = 0;
  keyboardOrbitState.directionCounts.up = 0;
  keyboardOrbitState.directionCounts.down = 0;
  keyboardOrbitState.lastFrameTime = 0;
}

function applyOrbitDelta(runtime, azimuthDelta, polarDelta) {
  if (!runtime?.camera || !runtime?.controls) {
    return false;
  }
  if (Math.abs(azimuthDelta) < 1e-6 && Math.abs(polarDelta) < 1e-6) {
    return false;
  }

  const offset = runtime.camera.position.clone().sub(runtime.controls.target);
  const distance = offset.length();
  if (!Number.isFinite(distance) || distance <= 1e-6) {
    return false;
  }

  const worldUp = new THREE.Vector3(...WORLD_UP).normalize();
  const direction = offset.clone().divideScalar(distance);
  const minPolar = Math.max(
    Number.isFinite(runtime.controls.minPolarAngle) ? runtime.controls.minPolarAngle : 0,
    KEYBOARD_POLAR_EPSILON
  );
  const maxPolar = Math.min(
    Number.isFinite(runtime.controls.maxPolarAngle) ? runtime.controls.maxPolarAngle : Math.PI,
    Math.PI - KEYBOARD_POLAR_EPSILON
  );
  const currentPolar = Math.acos(clamp(direction.dot(worldUp), -1, 1));
  const requestedPolar = clamp(currentPolar + polarDelta, minPolar, maxPolar);
  const resolvedPolarDelta = requestedPolar - currentPolar;

  if (Math.abs(azimuthDelta) > 1e-6) {
    offset.applyAxisAngle(worldUp, azimuthDelta);
  }
  if (Math.abs(resolvedPolarDelta) > 1e-6) {
    let orbitRight = new THREE.Vector3().crossVectors(worldUp, offset).normalize();
    if (orbitRight.lengthSq() <= 1e-9) {
      orbitRight = new THREE.Vector3(1, 0, 0);
    }
    offset.applyAxisAngle(orbitRight, resolvedPolarDelta);
  }
  runtime.camera.position.copy(runtime.controls.target).add(offset);
  runtime.camera.up.set(...WORLD_UP);
  runtime.camera.lookAt(runtime.controls.target);
  return true;
}

function stepKeyboardOrbit(runtime, timestamp) {
  const keyboardOrbitState = runtime?.keyboardOrbitState;
  if (!keyboardOrbitState) {
    return false;
  }

  const axes = getKeyboardOrbitAxes(keyboardOrbitState);
  if (!axes.azimuth && !axes.polar) {
    keyboardOrbitState.lastFrameTime = 0;
    return false;
  }
  if (!keyboardOrbitState.lastFrameTime) {
    keyboardOrbitState.lastFrameTime = timestamp;
    return false;
  }

  const deltaSeconds = clamp((timestamp - keyboardOrbitState.lastFrameTime) / 1000, 0, 0.05);
  keyboardOrbitState.lastFrameTime = timestamp;
  return applyOrbitDelta(
    runtime,
    axes.azimuth * KEYBOARD_ORBIT_SPEED_RAD_PER_SEC * deltaSeconds,
    axes.polar * KEYBOARD_ORBIT_SPEED_RAD_PER_SEC * deltaSeconds
  );
}

function normalizeViewportFrameInsets(value = {}) {
  const normalizeInset = (inset) => {
    const numericInset = Number(inset);
    return Number.isFinite(numericInset) ? Math.max(0, numericInset) : 0;
  };
  return {
    top: normalizeInset(value?.top),
    right: normalizeInset(value?.right),
    bottom: normalizeInset(value?.bottom),
    left: normalizeInset(value?.left)
  };
}

function getViewportFrameMetrics(runtime, frameInsets = {}) {
  const canvas = runtime?.renderer?.domElement;
  const width = Math.max(1, canvas?.clientWidth || canvas?.parentElement?.clientWidth || 1);
  const height = Math.max(1, canvas?.clientHeight || canvas?.parentElement?.clientHeight || 1);
  const normalizedInsets = normalizeViewportFrameInsets(frameInsets);
  const left = clamp(normalizedInsets.left, 0, Math.max(width - 1, 0));
  const right = clamp(normalizedInsets.right, 0, Math.max(width - left - 1, 0));
  const top = clamp(normalizedInsets.top, 0, Math.max(height - 1, 0));
  const bottom = clamp(normalizedInsets.bottom, 0, Math.max(height - top - 1, 0));
  const framedWidth = Math.max(1, width - left - right);
  const framedHeight = Math.max(1, height - top - bottom);
  const centerX = left + framedWidth / 2;
  const centerY = top + framedHeight / 2;
  return {
    width,
    height,
    top,
    right,
    bottom,
    left,
    framedWidth,
    framedHeight,
    aspect: framedWidth / framedHeight,
    offsetNdcX: (centerX / width) * 2 - 1,
    offsetNdcY: 1 - (centerY / height) * 2
  };
}

function viewportCropForCanvas(runtime, frameInsets = {}) {
  const canvas = runtime?.renderer?.domElement;
  const metrics = getViewportFrameMetrics(runtime, frameInsets);
  const pixelWidth = Math.max(1, canvas?.width || metrics.width);
  const pixelHeight = Math.max(1, canvas?.height || metrics.height);
  const scaleX = pixelWidth / Math.max(metrics.width, 1);
  const scaleY = pixelHeight / Math.max(metrics.height, 1);
  const x = Math.round(metrics.left * scaleX);
  const y = Math.round(metrics.top * scaleY);
  const right = Math.round(metrics.right * scaleX);
  const bottom = Math.round(metrics.bottom * scaleY);
  return {
    x,
    y,
    width: Math.max(1, pixelWidth - x - right),
    height: Math.max(1, pixelHeight - y - bottom)
  };
}

function applyCameraFrameInsets(runtime, frameInsets = {}, { updateProjection = true } = {}) {
  const camera = runtime?.camera;
  if (!camera?.projectionMatrix?.elements) {
    return;
  }
  if (updateProjection) {
    camera.updateProjectionMatrix();
  }
  const { offsetNdcX, offsetNdcY } = getViewportFrameMetrics(runtime, frameInsets);
  camera.projectionMatrix.elements[8] -= offsetNdcX;
  camera.projectionMatrix.elements[9] -= offsetNdcY;
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function readViewPlaneOrientation(runtime) {
  if (!runtime?.camera) {
    return null;
  }
  const inverseCameraRotation = runtime.camera.quaternion.clone().invert();
  const projectAxis = (x, y, z) => {
    const projected = new THREE.Vector3(x, y, z).applyQuaternion(inverseCameraRotation);
    return [projected.x, projected.y, projected.z];
  };
  return {
    x: projectAxis(1, 0, 0),
    y: projectAxis(0, 1, 0),
    z: projectAxis(0, 0, 1)
  };
}

function viewPlaneOrientationsEqual(a, b) {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  for (const axis of ["x", "y", "z"]) {
    const av = a[axis];
    const bv = b[axis];
    if (!av || !bv) {
      return false;
    }
    for (let index = 0; index < 3; index += 1) {
      if (Math.abs((av[index] || 0) - (bv[index] || 0)) > 1e-4) {
        return false;
      }
    }
  }
  return true;
}

function getActiveViewPlaneFaceId(runtime) {
  if (!runtime?.camera || !runtime?.controls) {
    return "";
  }
  const offset = runtime.camera.position.clone().sub(runtime.controls.target);
  if (offset.lengthSq() < 1e-6) {
    return "";
  }
  offset.normalize();
  let bestId = "";
  let bestDot = -Infinity;
  for (const face of VIEW_PLANE_FACES) {
    const direction = new THREE.Vector3(...face.direction).normalize();
    const dot = direction.dot(offset);
    if (dot > bestDot) {
      bestDot = dot;
      bestId = face.id;
    }
  }
  return bestDot >= VIEW_PLANE_ACTIVE_DOT_THRESHOLD ? bestId : "";
}

function perspectiveSnapshot(runtime, modelKey = "") {
  if (!runtime?.camera || !runtime?.controls) {
    return null;
  }
  const camera = runtime.camera;
  const target = runtime.controls.target;
  return {
    implicit: true,
    cameraVersion: IMPLICIT_CAMERA_VERSION,
    modelKey: String(modelKey || ""),
    position: [camera.position.x, camera.position.y, camera.position.z],
    target: [target.x, target.y, target.z],
    up: [camera.up.x, camera.up.y, camera.up.z],
    fov: camera.fov
  };
}

function applyPerspectiveSnapshot(runtime, perspective, modelKey = "") {
  if (!runtime?.camera || !runtime?.controls || !perspective?.implicit) {
    return false;
  }
  if (perspective.cameraVersion !== IMPLICIT_CAMERA_VERSION) {
    return false;
  }
  const snapshotModelKey = String(perspective.modelKey || "").trim();
  const activeModelKey = String(modelKey || "").trim();
  if (snapshotModelKey && activeModelKey && snapshotModelKey !== activeModelKey) {
    return false;
  }
  const position = Array.isArray(perspective.position) ? perspective.position : null;
  const target = Array.isArray(perspective.target) ? perspective.target : null;
  const up = Array.isArray(perspective.up) ? perspective.up : WORLD_UP;
  if (!position || !target) {
    return false;
  }
  runtime.camera.position.set(
    finiteNumber(position[0], runtime.camera.position.x),
    finiteNumber(position[1], runtime.camera.position.y),
    finiteNumber(position[2], runtime.camera.position.z)
  );
  runtime.controls.target.set(
    finiteNumber(target[0], runtime.controls.target.x),
    finiteNumber(target[1], runtime.controls.target.y),
    finiteNumber(target[2], runtime.controls.target.z)
  );
  runtime.camera.up.set(
    finiteNumber(up[0], WORLD_UP[0]),
    finiteNumber(up[1], WORLD_UP[1]),
    finiteNumber(up[2], WORLD_UP[2])
  );
  runtime.camera.fov = finiteNumber(perspective.fov, runtime.camera.fov);
  runtime.updateCameraFraming?.();
  runtime.camera.lookAt(runtime.controls.target);
  runtime.controls.update();
  runtime.requestRender?.();
  return true;
}

function transitionCameraToViewPreset(runtime, preset) {
  if (!runtime?.camera || !runtime?.controls || !preset) {
    return false;
  }
  const direction = new THREE.Vector3(...(preset.direction || []));
  const up = new THREE.Vector3(...(preset.up || []));
  if (direction.lengthSq() < 1e-6 || up.lengthSq() < 1e-6) {
    return false;
  }
  const target = runtime.controls.target.clone();
  const distance = clamp(
    runtime.camera.position.distanceTo(target),
    runtime.controls.minDistance || 0.01,
    runtime.controls.maxDistance || Infinity
  );
  runtime.cameraTransition = {
    startTime: performance.now(),
    durationMs: VIEW_PLANE_TRANSITION_MS,
    startPosition: runtime.camera.position.clone(),
    endPosition: target.clone().add(direction.normalize().multiplyScalar(distance)),
    startUp: runtime.camera.up.clone(),
    endUp: up.normalize()
  };
  runtime.controls.enableDamping = false;
  runtime.beginInteraction?.();
  runtime.requestRender?.();
  return true;
}

function stepCameraTransition(runtime, timestamp) {
  const transition = runtime?.cameraTransition;
  if (!transition) {
    return false;
  }
  const progress = clamp((timestamp - transition.startTime) / transition.durationMs, 0, 1);
  const eased = easeInOutCubic(progress);
  runtime.camera.position.lerpVectors(transition.startPosition, transition.endPosition, eased);
  runtime.camera.up.lerpVectors(transition.startUp, transition.endUp, eased).normalize();
  if (transition.endTarget) {
    runtime.controls.target.lerpVectors(transition.startTarget, transition.endTarget, eased);
  }
  runtime.camera.lookAt(runtime.controls.target);
  if (progress >= 1) {
    runtime.cameraTransition = null;
    runtime.controls.enableDamping = true;
    runtime.controls.dampingFactor = DEFAULT_DAMPING_FACTOR;
    runtime.scheduleIdleQuality?.();
    runtime.emitPerspectiveChange?.();
    return false;
  }
  return true;
}

function applyCameraState(runtime, cameraState) {
  runtime.controls.target.set(...cameraState.target);
  runtime.camera.position.set(...cameraState.position);
  runtime.camera.up.set(...cameraState.up);
  runtime.camera.fov = cameraState.fov;
  runtime.camera.zoom = cameraState.zoom;
  runtime.updateCameraFraming?.();
  runtime.camera.lookAt(runtime.controls.target);
  runtime.controls.update();
  runtime.emitPerspectiveChange?.();
  runtime.requestRender?.();
}

function transitionCameraToState(runtime, cameraState, {
  animate = true,
  durationMs = AUTO_ZOOM_SPEED_MS
} = {}) {
  if (!runtime?.camera || !runtime?.controls || !cameraState) {
    return false;
  }
  if (!animate || durationMs <= 0) {
    applyCameraState(runtime, cameraState);
    return true;
  }
  runtime.camera.fov = cameraState.fov;
  runtime.camera.zoom = cameraState.zoom;
  runtime.updateCameraFraming?.();
  runtime.cameraTransition = {
    startTime: performance.now(),
    durationMs,
    startPosition: runtime.camera.position.clone(),
    endPosition: new THREE.Vector3(...cameraState.position),
    startUp: runtime.camera.up.clone(),
    endUp: new THREE.Vector3(...cameraState.up).normalize(),
    startTarget: runtime.controls.target.clone(),
    endTarget: new THREE.Vector3(...cameraState.target)
  };
  runtime.controls.enableDamping = false;
  runtime.beginInteraction?.();
  runtime.requestRender?.();
  return true;
}

// Compile the raymarch program off the main thread (KHR_parallel_shader_compile
// via THREE.compileAsync) and only start rendering once it links; large models
// otherwise freeze the tab for seconds on their first frame.
function armImplicitShaderCompile(runtime) {
  const shaderScene = runtime?.shaderScene;
  const renderer = runtime?.renderer;
  if (!shaderScene || !renderer) {
    return;
  }
  if (typeof renderer.compileAsync !== "function" || !runtime.screenCamera) {
    runtime.shaderSceneReady = true;
    return;
  }
  runtime.shaderSceneReady = false;
  renderer.compileAsync(shaderScene.scene, runtime.screenCamera)
    .catch(() => {})
    .finally(() => {
      if (runtime.shaderScene === shaderScene) {
        runtime.shaderSceneReady = true;
        runtime.requestRender?.();
      }
    });
}

function autoZoomBoundsKey(model) {
  const bounds = model?.bounds;
  if (!Array.isArray(bounds?.min) || !Array.isArray(bounds?.max)) {
    return "";
  }
  const radius = Math.max(finiteNumber(model?.radius, 1), 1e-6);
  const quantum = Math.max(radius * 0.02, 1e-6);
  return [...bounds.min, ...bounds.max]
    .map((value) => Math.round(finiteNumber(value, 0) / quantum))
    .join(",");
}

function canvasBlob(canvas, crop = null) {
  return new Promise((resolve, reject) => {
    const source = canvas;
    const target = crop
      ? document.createElement("canvas")
      : source;
    if (crop) {
      target.width = crop.width;
      target.height = crop.height;
      target
        .getContext("2d")
        ?.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    }
    target.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to capture implicit CAD screenshot"));
      }
    }, "image/png");
  });
}

function updateImplicitThemeUniforms(runtime, model, themeSettings) {
  updateImplicitCadAppearanceUniforms(THREE, runtime?.shaderScene?.material, model, {
    themeSettings,
    graphicsSettings: implicitGraphicsRenderSettings(runtime?.graphicsSettings, {
      interaction: runtime?.previewOrbitEnabled === true
    })
  });
}

function updateImplicitGraphicsUniforms(runtime, model) {
  updateImplicitCadGraphicsUniforms(runtime?.shaderScene?.material, model, implicitGraphicsRenderSettings(
    runtime?.graphicsSettings,
    { interaction: runtime?.previewOrbitEnabled === true }
  ));
}

const ImplicitCadViewer = forwardRef(function ImplicitCadViewer({
  model,
  modelKey = "",
  isLoading = false,
  previewMode = false,
  viewportFrameInsets = {},
  viewPlaneOffsetRight = 16,
  themeSettings = null,
  graphicsSettings = null,
  dynamicRenderActive = false,
  perspective = null,
  perspectiveRef = null,
  onPerspectiveChange,
  onViewerAlertChange
}, ref) {
  const mountRef = useRef(null);
  const runtimeRef = useRef(null);
  const frameInsetsRef = useRef(viewportFrameInsets);
  const latestModelKeyRef = useRef(modelKey);
  const perspectiveChangeRef = useRef(onPerspectiveChange);
  const previewModeRef = useRef(previewMode);
  const normalizedGraphicsSettings = useMemo(
    () => normalizeImplicitGraphicsSettings(graphicsSettings),
    [graphicsSettings]
  );
  const graphicsSettingsRef = useRef(normalizedGraphicsSettings);
  const dynamicRenderActiveRef = useRef(dynamicRenderActive === true);
  const [renderError, setRenderError] = useState("");
  const [activeViewPlaneFace, setActiveViewPlaneFace] = useState("");
  const [viewPlaneOrientation, setViewPlaneOrientation] = useState(null);

  useEffect(() => {
    frameInsetsRef.current = viewportFrameInsets;
    const runtime = runtimeRef.current;
    runtime?.updateCameraFraming?.();
    runtime?.requestRender?.();
  }, [viewportFrameInsets]);

  useEffect(() => {
    perspectiveChangeRef.current = onPerspectiveChange;
  }, [onPerspectiveChange]);

  useEffect(() => {
    latestModelKeyRef.current = modelKey;
  }, [modelKey]);

  useEffect(() => {
    previewModeRef.current = previewMode;
  }, [model, previewMode, themeSettings]);

  useEffect(() => {
    const active = dynamicRenderActive === true;
    dynamicRenderActiveRef.current = active;
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }
    runtime.dynamicRenderActive = active;
    updateImplicitGraphicsUniforms(runtime, model);
    runtime.requestRender?.();
  }, [dynamicRenderActive, model]);

  const emitPerspectiveChange = useCallback(() => {
    const snapshot = perspectiveSnapshot(runtimeRef.current, latestModelKeyRef.current);
    if (snapshot) {
      perspectiveChangeRef.current?.(snapshot);
    }
  }, []);

  const autoZoomStateRef = useRef({ attached: true, lastFitKey: "" });
  const [autoZoomDetached, setAutoZoomDetached] = useState(false);
  const setAutoZoomAttached = useCallback((attached) => {
    autoZoomStateRef.current.attached = attached;
    setAutoZoomDetached(!attached);
  }, []);
  const setAutoZoomAttachedRef = useRef(setAutoZoomAttached);
  setAutoZoomAttachedRef.current = setAutoZoomAttached;

  const runAutoZoom = useCallback((reason = "state", {
    animate = true,
    force = false,
    viewDirection = null,
    viewUp = null,
    durationMs = AUTO_ZOOM_SPEED_MS
  } = {}) => {
    const runtime = runtimeRef.current;
    if (!runtime?.camera || !runtime?.controls) {
      return false;
    }
    const state = autoZoomStateRef.current;
    if (!force && state.attached === false) {
      return false;
    }
    const activeModel = runtime.model || model;
    if (!activeModel) {
      return false;
    }
    const metrics = getViewportFrameMetrics(runtime, frameInsetsRef.current);
    const offset = runtime.camera.position.clone().sub(runtime.controls.target);
    const direction = viewDirection || (offset.lengthSq() > 1e-9 ? offset.toArray() : DEFAULT_VIEW_DIRECTION);
    const cameraState = implicitCadCameraState(
      activeModel,
      { direction, up: viewUp || runtime.camera.up.toArray() },
      {
        width: metrics.framedWidth,
        height: metrics.framedHeight,
        zoom: 1,
        frameMargin: AUTO_ZOOM_FRAME_MARGIN,
        // Never run the CPU SDF estimator on the interaction path; fits use
        // cached/declared bounds and refineImplicitFit tightens them later.
        estimateFrameBounds: false
      }
    );
    setAutoZoomAttached(true);
    state.lastFitKey = autoZoomBoundsKey(activeModel);
    return transitionCameraToState(runtime, cameraState, { animate, durationMs });
  }, [model, setAutoZoomAttached]);
  const runAutoZoomRef = useRef(null);
  runAutoZoomRef.current = runAutoZoom;

  const maybeAutoZoomForModel = useCallback((nextModel) => {
    if (!nextModel || dynamicRenderActiveRef.current) {
      return;
    }
    const state = autoZoomStateRef.current;
    if (state.attached === false) {
      return;
    }
    const key = autoZoomBoundsKey(nextModel);
    if (!key || state.lastFitKey === key) {
      return;
    }
    runAutoZoomRef.current?.("model");
  }, []);

  // Resolve tight floor/frame bounds in the background, then re-fit once. This
  // only ever runs when the model's *declared* bounds change and never during
  // dynamic render (animation playback, slider drags): animation advances
  // uniforms every frame without changing the envelope, so refining per frame
  // would spawn an unbounded flood of concurrent CPU SDF scans.
  const refineImplicitFit = useCallback((nextModel, { force = false } = {}) => {
    const runtime = runtimeRef.current;
    const material = runtime?.shaderScene?.material;
    if (!runtime || !material || !nextModel) {
      return;
    }
    if (!force && dynamicRenderActiveRef.current) {
      return;
    }
    const boundsKey = autoZoomBoundsKey(nextModel);
    if (!force && boundsKey && runtime.refineBoundsKey === boundsKey) {
      return;
    }
    runtime.refineBoundsKey = boundsKey;
    const token = (runtime.refineToken = (runtime.refineToken || 0) + 1);
    refreshImplicitCadFloorBounds(material, nextModel)
      .then(() => {
        if (runtimeRef.current !== runtime || runtime.refineToken !== token) {
          return;
        }
        if (runtime.shaderScene?.material !== material) {
          return;
        }
        runtime.requestRender?.();
        if (autoZoomStateRef.current.attached !== false && !dynamicRenderActiveRef.current) {
          runAutoZoomRef.current?.("refine");
        }
      })
      .catch(() => {
        if (runtimeRef.current === runtime && runtime.refineBoundsKey === boundsKey) {
          runtime.refineBoundsKey = null;
        }
      });
  }, []);
  const refineImplicitFitRef = useRef(null);
  refineImplicitFitRef.current = refineImplicitFit;

  const activateViewPlaneFace = useCallback((faceId) => {
    const face = VIEW_PLANE_FACE_BY_ID[faceId];
    if (!face || !runtimeRef.current) {
      return false;
    }
    setActiveViewPlaneFace(face.id);
    if (autoZoomStateRef.current.attached !== false) {
      return runAutoZoom("viewport", {
        viewDirection: face.direction,
        viewUp: face.up,
        durationMs: VIEW_PLANE_TRANSITION_MS
      });
    }
    return transitionCameraToViewPreset(runtimeRef.current, face);
  }, [runAutoZoom]);

  const activateDefaultViewPlane = useCallback(() => {
    const runtime = runtimeRef.current;
    if (!runtime) {
      return false;
    }
    setActiveViewPlaneFace("");
    return runAutoZoom("reset", {
      force: true,
      viewDirection: DEFAULT_VIEW_DIRECTION,
      viewUp: WORLD_UP
    });
  }, [runAutoZoom]);

  useImperativeHandle(ref, () => ({
    async captureScreenshot({ filename = "implicit-cad-screenshot.png", mode = "download" } = {}) {
      const runtime = runtimeRef.current;
      const canvas = runtime?.renderer?.domElement;
      if (!canvas) {
        throw new Error("Implicit CAD Viewer not ready");
      }
      runtime.requestRender?.({ immediate: true });
      const blobPromise = canvasBlob(canvas, viewportCropForCanvas(runtime, frameInsetsRef.current));
      if (mode === "clipboard") {
        return await copyImageBlobToClipboard(blobPromise);
      }
      const blob = await blobPromise;
      return triggerBlobDownload(blob, { filename });
    },
    getPerspective() {
      return perspectiveSnapshot(runtimeRef.current, latestModelKeyRef.current);
    },
    setPerspective(nextPerspective) {
      return applyPerspectiveSnapshot(runtimeRef.current, nextPerspective, latestModelKeyRef.current);
    },
    focusViewPreset(faceId) {
      return activateViewPlaneFace(faceId);
    }
  }), [activateViewPlaneFace]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime?.controls) {
      return;
    }
    runtime.orbitControlsLastTimestamp = 0;
    runtime.previewOrbitEnabled = !!previewMode;
    runtime.controls.autoRotate = !!previewMode;
    runtime.controls.autoRotateSpeed = PREVIEW_AUTO_ROTATE_SPEED;
    updateImplicitThemeUniforms(runtime, model, themeSettings);
    updateImplicitGraphicsUniforms(runtime, model);
    if (previewMode) {
      runtime.beginInteraction?.();
    } else {
      runtime.scheduleIdleQuality?.();
    }
    runtime.requestRender?.();
  }, [previewMode]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || !model) {
      return;
    }
    runtime.dynamicRenderActive = dynamicRenderActiveRef.current;
    let nextShaderKey = "";
    try {
      nextShaderKey = implicitCadModelShaderKey(model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(message);
      onViewerAlertChange?.({
        severity: "error",
        compact: true,
        title: "Implicit CAD shader failed",
        message
      });
      return;
    }
    if (runtime.shaderScene && runtime.shaderScene.shaderKey === nextShaderKey) {
      runtime.model = model;
      updateImplicitCadModelUniforms(THREE, runtime.shaderScene.material, model);
      runtime.updateCameraFraming?.();
      updateImplicitThemeUniforms(runtime, model, themeSettings);
      updateImplicitGraphicsUniforms(runtime, model);
      maybeAutoZoomForModel(model);
      refineImplicitFit(model);
      runtime.requestRender?.();
      return;
    }

    let nextShaderScene = null;
    try {
      nextShaderScene = createImplicitCadFullscreenScene(THREE, model);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(message);
      onViewerAlertChange?.({
        severity: "error",
        compact: true,
        title: "Implicit CAD shader failed",
        message
      });
      return;
    }

    const previousShaderScene = runtime.shaderScene;
    runtime.shaderScene = nextShaderScene;
    runtime.model = model;
    armImplicitShaderCompile(runtime);
    setRenderError("");
    onViewerAlertChange?.(null);
    updateImplicitThemeUniforms(runtime, model, themeSettings);
    updateImplicitGraphicsUniforms(runtime, model);
    runtime.updateCameraFraming?.();
    maybeAutoZoomForModel(model);
    refineImplicitFit(model);
    runtime.requestRender?.();
    previousShaderScene?.dispose?.();
  }, [maybeAutoZoomForModel, model, normalizedGraphicsSettings, onViewerAlertChange, refineImplicitFit, themeSettings]);

  useEffect(() => {
    updateImplicitThemeUniforms(runtimeRef.current, model, themeSettings);
    runtimeRef.current?.requestRender?.();
  }, [model, themeSettings]);

  useEffect(() => {
    graphicsSettingsRef.current = normalizedGraphicsSettings;
    const runtime = runtimeRef.current;
    if (!runtime) {
      return;
    }
    runtime.graphicsSettings = normalizedGraphicsSettings;
    runtime.dynamicRenderActive = dynamicRenderActiveRef.current;
    updateImplicitThemeUniforms(runtime, model, themeSettings);
    updateImplicitGraphicsUniforms(runtime, model);
    runtime.setPixelRatioCap?.(implicitGraphicsRenderResolutionScale(
      normalizedGraphicsSettings,
      { interaction: previewModeRef.current }
    ));
    runtime.requestRender?.();
  }, [model, normalizedGraphicsSettings, themeSettings]);

  useEffect(() => {
    if (!mountRef.current || !model) {
      return undefined;
    }

    let disposed = false;
    let frameId = 0;
    let idleTimerId = 0;
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true
    });
    renderer.setPixelRatio(Math.min(
      window.devicePixelRatio || 1,
      graphicsSettingsRef.current.resolutionScale
    ));
    renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 640, false);
    renderer.domElement.className = "h-full w-full touch-none";
    mount.innerHTML = "";
    mount.appendChild(renderer.domElement);

    let shaderScene = null;
    let screenCamera = null;
    let camera = null;
    let controls = null;
    const getOrbitControlsPixelRatioBucket = () => Math.max((window.devicePixelRatio || 1) | 0, 1);
    const initialWheelPixelRatioBucket = getOrbitControlsPixelRatioBucket();
    const getWheelZoomSpeed = (baseZoomSpeed) => (
      baseZoomSpeed * (getOrbitControlsPixelRatioBucket() / initialWheelPixelRatioBucket)
    );
    const keyboardOrbitState = {
      pressedKeys: new Set(),
      directionCounts: {
        left: 0,
        right: 0,
        up: 0,
        down: 0
      },
      lastFrameTime: 0
    };
    try {
      shaderScene = createImplicitCadFullscreenScene(THREE, model);
      screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      camera = new THREE.PerspectiveCamera(DEFAULT_FOV_DEG, 1, 0.01, 2000);
      camera.up.set(...WORLD_UP);
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = DEFAULT_DAMPING_FACTOR;
      controls.rotateSpeed = 1;
      controls.panSpeed = 1.35;
      controls.zoomSpeed = DEFAULT_ZOOM_SPEED;
      if ("zoomToCursor" in controls) {
        controls.zoomToCursor = true;
      }
      setRenderError("");
      onViewerAlertChange?.(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRenderError(message);
      onViewerAlertChange?.({
        severity: "error",
        compact: true,
        title: "Implicit CAD shader failed",
        message
      });
    }

    const runtime = {
      renderer,
      shaderScene,
      screenCamera,
      camera,
      controls,
      cameraTransition: null,
      renderQueued: false,
      orbitControlsLastTimestamp: 0,
      keyboardOrbitState,
      graphicsSettings: graphicsSettingsRef.current,
      dynamicRenderActive: dynamicRenderActiveRef.current,
      previewOrbitEnabled: !!previewMode,
      model,
      shaderSceneReady: false,
      requestRender,
      beginInteraction,
      scheduleIdleQuality,
      setPixelRatioCap,
      updateCameraFraming,
      emitPerspectiveChange
    };
    runtimeRef.current = runtime;

    function setPixelRatioCap(cap) {
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
      renderer.setSize(mount.clientWidth || 800, mount.clientHeight || 640, false);
    }

    function updateCameraFraming() {
      if (!runtime.camera || !runtime.controls) {
        return;
      }
      const activeModel = runtime.model || model;
      const metrics = getViewportFrameMetrics(runtime, frameInsetsRef.current);
      runtime.camera.aspect = metrics.width / metrics.height;
      runtime.camera.near = Math.max(activeModel.radius / 1200, 0.01);
      runtime.camera.far = Math.max(activeModel.radius * 600, 2000);
      runtime.camera.updateProjectionMatrix();
      applyCameraFrameInsets(runtime, frameInsetsRef.current, { updateProjection: false });
      runtime.controls.minDistance = Math.max(activeModel.radius / 2200, 0.02);
      runtime.controls.maxDistance = Math.max(activeModel.radius * 140, 50);
    }

    function requestRender(options = {}) {
      if (disposed) {
        return;
      }
      if (options.immediate) {
        renderFrame(performance.now());
        return;
      }
      if (runtime.renderQueued) {
        return;
      }
      runtime.renderQueued = true;
      frameId = window.requestAnimationFrame(renderFrame);
    }

    function beginInteraction() {
      if (idleTimerId) {
        window.clearTimeout(idleTimerId);
        idleTimerId = 0;
      }
      setPixelRatioCap(implicitGraphicsRenderResolutionScale(
        graphicsSettingsRef.current,
        { interaction: true }
      ));
      requestRender();
    }

    function scheduleIdleQuality() {
      if (idleTimerId) {
        window.clearTimeout(idleTimerId);
      }
      idleTimerId = window.setTimeout(() => {
        idleTimerId = 0;
        controls.enableDamping = true;
        controls.dampingFactor = DEFAULT_DAMPING_FACTOR;
        controls.zoomSpeed = DEFAULT_ZOOM_SPEED;
        setPixelRatioCap(implicitGraphicsRenderResolutionScale(
          graphicsSettingsRef.current,
          { interaction: previewModeRef.current }
        ));
        requestRender();
      }, INTERACTION_IDLE_DELAY_MS);
    }

    function renderFrame(timestamp) {
      if (disposed) {
        return;
      }
      runtime.renderQueued = false;
      const transitionActive = stepCameraTransition(runtime, timestamp);
      const keyboardOrbitMoved = stepKeyboardOrbit(runtime, timestamp);
      const controlsActive = updateOrbitControls(controls, timestamp, runtime);
      if (keyboardOrbitMoved) {
        emitPerspectiveChange();
      }
      if (runtime.shaderScene && runtime.shaderSceneReady !== false && runtime.camera && runtime.screenCamera) {
        const canvas = renderer.domElement;
        updateImplicitCadMaterialUniforms(
          runtime.shaderScene.material,
          runtime.camera,
          canvas.width || canvas.clientWidth || 1,
          canvas.height || canvas.clientHeight || 1
        );
        renderer.render(runtime.shaderScene.scene, runtime.screenCamera);
      }
      if (!runtime.previewOrbitEnabled) {
        const nextActiveFace = getActiveViewPlaneFaceId(runtime);
        setActiveViewPlaneFace((current) => current === nextActiveFace ? current : nextActiveFace);
        // The camera is static while animation only advances geometry uniforms;
        // bail out of the state update unless the orientation actually changed so
        // playback does not trigger a React re-render every frame.
        const nextOrientation = readViewPlaneOrientation(runtime);
        setViewPlaneOrientation((current) => (
          viewPlaneOrientationsEqual(current, nextOrientation) ? current : nextOrientation
        ));
      }
      if (transitionActive || keyboardOrbitMoved || controlsActive || controls?.autoRotate) {
        requestRender();
      }
    }

    function onResize() {
      if (disposed) {
        return;
      }
      setPixelRatioCap(implicitGraphicsRenderResolutionScale(
        graphicsSettingsRef.current,
        { interaction: previewModeRef.current }
      ));
      updateCameraFraming();
      if (autoZoomStateRef.current.attached !== false) {
        runAutoZoomRef.current?.("resize", { animate: false });
      }
      requestRender();
    }

    const handleControlsStart = () => {
      runtime.cameraTransition = null;
      setAutoZoomAttachedRef.current(false);
      beginInteraction();
    };
    const handleControlsChange = () => {
      emitPerspectiveChange();
      requestRender();
    };
    const handleControlsEnd = () => {
      scheduleIdleQuality();
    };
    const handleWheel = (event) => {
      runtime.cameraTransition = null;
      setAutoZoomAttachedRef.current(false);
      controls.enableDamping = false;
      controls.zoomSpeed = getWheelZoomSpeed(
        isTrackpadLikeWheelEvent(event) ? TRACKPAD_PINCH_ZOOM_SPEED : ACCELERATED_WHEEL_ZOOM_SPEED
      );
      beginInteraction();
    };
    const handleKeyDown = (event) => {
      if (
        previewModeRef.current ||
        event.defaultPrevented ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const command = getKeyboardOrbitCommand(event);
      if (!command) {
        return;
      }
      if (keyboardOrbitState.pressedKeys.has(command.keyId)) {
        event.preventDefault();
        return;
      }

      keyboardOrbitState.pressedKeys.add(command.keyId);
      keyboardOrbitState.directionCounts[command.direction] += 1;
      keyboardOrbitState.lastFrameTime = 0;
      runtime.cameraTransition = null;
      setAutoZoomAttachedRef.current(false);
      beginInteraction();
      applyOrbitDelta(
        runtime,
        (command.direction === "right" ? 1 : command.direction === "left" ? -1 : 0) * KEYBOARD_ORBIT_NUDGE_RAD,
        (command.direction === "down" ? 1 : command.direction === "up" ? -1 : 0) * KEYBOARD_ORBIT_NUDGE_RAD
      );
      emitPerspectiveChange();
      requestRender();
      event.preventDefault();
    };
    const handleKeyUp = (event) => {
      const command = getKeyboardOrbitCommand(event);
      if (!command) {
        return;
      }
      if (!keyboardOrbitState.pressedKeys.delete(command.keyId)) {
        return;
      }

      keyboardOrbitState.directionCounts[command.direction] = Math.max(
        0,
        keyboardOrbitState.directionCounts[command.direction] - 1
      );
      const axes = getKeyboardOrbitAxes(keyboardOrbitState);
      if (!axes.azimuth && !axes.polar) {
        keyboardOrbitState.lastFrameTime = 0;
        scheduleIdleQuality();
      }
      event.preventDefault();
    };
    const clearKeyboardOrbit = () => {
      if (!keyboardOrbitState.pressedKeys.size) {
        return;
      }
      clearKeyboardOrbitState(keyboardOrbitState);
      scheduleIdleQuality();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") {
        clearKeyboardOrbit();
      }
    };

    const resizeObserver = typeof ResizeObserver === "function"
      ? new ResizeObserver(onResize)
      : null;
    resizeObserver?.observe(mount);
    window.addEventListener("resize", onResize);
    controls?.addEventListener("start", handleControlsStart);
    controls?.addEventListener("change", handleControlsChange);
    controls?.addEventListener("end", handleControlsEnd);
    renderer.domElement.addEventListener("wheel", handleWheel, { passive: true, capture: true });
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", clearKeyboardOrbit);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    updateImplicitThemeUniforms(runtime, model, themeSettings);
    updateImplicitGraphicsUniforms(runtime, model);
    updateCameraFraming();
    armImplicitShaderCompile(runtime);
    const initialPerspective = perspectiveRef?.current || perspective;
    if (applyPerspectiveSnapshot(runtime, initialPerspective, modelKey)) {
      setAutoZoomAttachedRef.current(false);
      autoZoomStateRef.current.lastFitKey = autoZoomBoundsKey(model);
    } else {
      runAutoZoomRef.current?.("mount", { animate: false, force: true });
    }
    refineImplicitFitRef.current?.(model);
    if (controls) {
      runtime.orbitControlsLastTimestamp = 0;
      controls.autoRotate = !!previewMode;
      controls.autoRotateSpeed = PREVIEW_AUTO_ROTATE_SPEED;
    }
    requestRender();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
      if (idleTimerId) {
        window.clearTimeout(idleTimerId);
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onResize);
      controls?.removeEventListener("start", handleControlsStart);
      controls?.removeEventListener("change", handleControlsChange);
      controls?.removeEventListener("end", handleControlsEnd);
      renderer.domElement.removeEventListener("wheel", handleWheel, { passive: true, capture: true });
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", clearKeyboardOrbit);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      controls?.dispose?.();
      runtime.shaderScene?.dispose?.();
      renderer.dispose();
      renderer.domElement.remove();
      if (runtimeRef.current === runtime) {
        runtimeRef.current = null;
      }
    };
  }, [
    emitPerspectiveChange,
    modelKey,
    onViewerAlertChange,
    perspective,
    perspectiveRef,
    Boolean(model)
  ]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#09090b]">
      <div ref={mountRef} className="absolute inset-0" />
      {!previewMode && !isLoading && model && autoZoomDetached ? (
        <button
          type="button"
          aria-label="Reset view"
          title="Reset view"
          className={`${RESET_VIEW_CONTROL_BUTTON_CLASSES} absolute z-20`}
          style={{
            right: `calc(${finiteNumber(viewPlaneOffsetRight, 16)}px + 2rem)`,
            bottom: "calc(1rem + 6.6rem)"
          }}
          onClick={activateDefaultViewPlane}
        >
          <Navigation2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
      <ViewPlaneControl
        showViewPlane
        previewMode={previewMode}
        isLoading={isLoading}
        meshData={model}
        viewPlaneOffsetRight={viewPlaneOffsetRight}
        viewPlaneOffsetBottom="1rem"
        compact={false}
        activeViewPlaneFace={activeViewPlaneFace}
        viewPlaneFaces={VIEW_PLANE_FACES}
        viewPlaneOrientation={viewPlaneOrientation}
        viewerTheme={themeSettings}
        activateViewPlaneFace={activateViewPlaneFace}
        activateDefaultViewPlane={activateDefaultViewPlane}
      />
      {isLoading ? (
        <div className="pointer-events-none absolute inset-x-0 top-4 z-10 flex justify-center">
          <div className="rounded-md border border-border/70 bg-background/90 px-3 py-1.5 text-xs text-muted-foreground shadow-sm">
            Loading implicit CAD
          </div>
        </div>
      ) : null}
      {renderError ? (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center p-4">
          <div className="max-w-lg rounded-md border border-destructive/40 bg-background/95 p-4 text-sm text-foreground shadow-lg">
            {renderError}
          </div>
        </div>
      ) : null}
    </div>
  );
});

export default ImplicitCadViewer;
