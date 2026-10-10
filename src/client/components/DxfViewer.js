"use client";

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState
} from "react";
import { copyImageBlobToClipboard } from "@/ui/clipboard";
import { triggerBlobDownload } from "@/ui/download";
import { resolveThemeFillColor } from "cadjs/lib/themeSettings";
import ViewPlaneControl from "./viewer/ViewPlaneControl";

const MIN_VIEW_SIZE = 1;
const VIEW_PADDING_RATIO = 0.08;
const MAX_ZOOM_IN = 20;
const MAX_ZOOM_OUT = 12;
const WHEEL_ZOOM_FACTOR = 1.12;
const VIEWBOX_EPSILON = 1e-6;
const POINT_KEY_SCALE = 1000;
const GEOMETRY_EPSILON = 1e-3;
const ANGLE_EPSILON = 1e-9;
const ARC_CHORD_TOLERANCE_MM = 0.35;
const MIN_ARC_SEGMENTS = 10;
const MAX_ARC_SEGMENTS = 160;
const DXF_2D_VIEW_PLANE_ORIENTATION = Object.freeze({
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1]
});
const DXF_2D_VIEW_PLANE_FACES = Object.freeze([
  { id: "x+", title: "Fit 2D view", direction: [1, 0, 0] },
  { id: "x-", title: "Fit 2D view", direction: [-1, 0, 0] },
  { id: "y+", title: "Fit 2D view", direction: [0, 1, 0] },
  { id: "y-", title: "Fit 2D view", direction: [0, -1, 0] }
]);
const DXF_2D_VIEW_PLANE_MESH = Object.freeze({ format: "dxf-2d" });

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toFiniteNumber(value, fallback = 0) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function normalizePoint(point) {
  if (!Array.isArray(point) || point.length < 2) {
    return [0, 0];
  }
  return [toFiniteNumber(point[0]), toFiniteNumber(point[1])];
}

function pointsEqual(a, b, epsilon = GEOMETRY_EPSILON) {
  return Math.abs(a[0] - b[0]) <= epsilon && Math.abs(a[1] - b[1]) <= epsilon;
}

function pointKey(point) {
  return `${Math.round(point[0] * POINT_KEY_SCALE)}:${Math.round(point[1] * POINT_KEY_SCALE)}`;
}

function reversePoints(points) {
  return [...points].reverse();
}

function removeDuplicateClosure(points) {
  if (points.length > 1 && pointsEqual(points[0], points[points.length - 1])) {
    return points.slice(0, -1);
  }
  return points;
}

function removeConsecutiveDuplicates(points) {
  const deduped = [];
  for (const point of points) {
    if (deduped.length && pointsEqual(deduped[deduped.length - 1], point)) {
      continue;
    }
    deduped.push(point);
  }
  return removeDuplicateClosure(deduped);
}

function normalizeAngle(angleDeg) {
  const value = toFiniteNumber(angleDeg) % 360;
  return value < 0 ? value + 360 : value;
}

function angleInSweep(angleDeg, startAngleDeg, sweepAngleDeg) {
  const absSweepAngleDeg = Math.abs(sweepAngleDeg);
  if (absSweepAngleDeg >= 360 - ANGLE_EPSILON) {
    return true;
  }
  if (sweepAngleDeg >= 0) {
    const normalizedDelta = (normalizeAngle(angleDeg) - normalizeAngle(startAngleDeg) + 360) % 360;
    return normalizedDelta <= absSweepAngleDeg + ANGLE_EPSILON;
  }
  const normalizedDelta = (normalizeAngle(startAngleDeg) - normalizeAngle(angleDeg) + 360) % 360;
  return normalizedDelta <= absSweepAngleDeg + ANGLE_EPSILON;
}

function pointOnCircle(center, radius, angleDeg) {
  const radians = (toFiniteNumber(angleDeg) * Math.PI) / 180;
  return [
    center[0] + radius * Math.cos(radians),
    center[1] + radius * Math.sin(radians)
  ];
}

function arcExtremaPoints(arc) {
  const center = normalizePoint(arc?.center);
  const radius = Math.max(toFiniteNumber(arc?.radius), 0);
  const startAngleDeg = toFiniteNumber(arc?.startAngleDeg);
  const sweepAngleDeg = toFiniteNumber(arc?.sweepAngleDeg);
  const endAngleDeg = startAngleDeg + sweepAngleDeg;
  const points = [
    pointOnCircle(center, radius, startAngleDeg),
    pointOnCircle(center, radius, endAngleDeg)
  ];
  for (const candidateAngle of [0, 90, 180, 270]) {
    if (angleInSweep(candidateAngle, startAngleDeg, sweepAngleDeg)) {
      points.push(pointOnCircle(center, radius, candidateAngle));
    }
  }
  return points;
}

function boundsFromPoints(points) {
  if (!points.length) {
    return null;
  }
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys)
  };
}

function expandBounds(current, nextBounds) {
  if (!nextBounds) {
    return current;
  }
  if (!current) {
    return nextBounds;
  }
  return {
    minX: Math.min(current.minX, nextBounds.minX),
    minY: Math.min(current.minY, nextBounds.minY),
    maxX: Math.max(current.maxX, nextBounds.maxX),
    maxY: Math.max(current.maxY, nextBounds.maxY)
  };
}

function sampleCountForSweep(radius, sweepRadians) {
  const safeRadius = Math.max(Math.abs(radius), 0.01);
  const chordRatio = clamp(1 - (ARC_CHORD_TOLERANCE_MM / safeRadius), -1, 1);
  const maxSegmentAngle = chordRatio <= -1
    ? Math.PI / 8
    : clamp(2 * Math.acos(chordRatio), Math.PI / 64, Math.PI / 10);
  return clamp(
    Math.ceil(Math.max(Math.abs(sweepRadians), Math.PI / 36) / maxSegmentAngle),
    MIN_ARC_SEGMENTS,
    MAX_ARC_SEGMENTS
  );
}

function sampleArcPoints(center, radius, startAngleDeg, sweepAngleDeg) {
  const startAngleRad = (toFiniteNumber(startAngleDeg) * Math.PI) / 180;
  const sweepAngleRad = (toFiniteNumber(sweepAngleDeg) * Math.PI) / 180;
  const segments = sampleCountForSweep(radius, sweepAngleRad);
  const points = [];
  for (let index = 0; index <= segments; index += 1) {
    const t = index / segments;
    const angle = startAngleRad + sweepAngleRad * t;
    points.push([
      center[0] + radius * Math.cos(angle),
      center[1] + radius * Math.sin(angle)
    ]);
  }
  return points;
}

function sampleCirclePoints(center, radius) {
  return removeDuplicateClosure(sampleArcPoints(center, radius, 0, 360));
}

function readGeometryRecords(dxfData) {
  const geometry = dxfData?.geometry || {};
  const lines = Array.isArray(geometry.lines) ? geometry.lines : [];
  const arcs = Array.isArray(geometry.arcs) ? geometry.arcs : [];
  const circles = Array.isArray(geometry.circles) ? geometry.circles : [];
  const cutPrimitives = [];
  const cutCircleLoops = [];
  let rawBounds = null;

  for (const line of lines) {
    const start = normalizePoint(line?.start);
    const end = normalizePoint(line?.end);
    rawBounds = expandBounds(rawBounds, boundsFromPoints([start, end]));
    if (String(line?.kind || "").trim().toLowerCase() === "bend" || pointsEqual(start, end)) {
      continue;
    }
    cutPrimitives.push({ points: [start, end] });
  }

  for (const arc of arcs) {
    const center = normalizePoint(arc?.center);
    const radius = Math.max(toFiniteNumber(arc?.radius), 0);
    if (radius <= 0) {
      continue;
    }
    rawBounds = expandBounds(rawBounds, boundsFromPoints(arcExtremaPoints(arc)));
    const points = sampleArcPoints(
      center,
      radius,
      toFiniteNumber(arc?.startAngleDeg),
      toFiniteNumber(arc?.sweepAngleDeg)
    );
    if (String(arc?.kind || "").trim().toLowerCase() === "bend") {
      continue;
    }
    cutPrimitives.push({ points });
  }

  for (const circle of circles) {
    const center = normalizePoint(circle?.center);
    const radius = Math.max(toFiniteNumber(circle?.radius), 0);
    if (radius <= 0) {
      continue;
    }
    rawBounds = expandBounds(rawBounds, {
      minX: center[0] - radius,
      minY: center[1] - radius,
      maxX: center[0] + radius,
      maxY: center[1] + radius
    });
    if (String(circle?.kind || "").trim().toLowerCase() === "bend") {
      continue;
    }
    cutCircleLoops.push(sampleCirclePoints(center, radius));
  }

  return {
    cutPrimitives,
    cutCircleLoops,
    rawBounds
  };
}

function buildCutLoops(dxfData) {
  const { cutPrimitives, cutCircleLoops, rawBounds } = readGeometryRecords(dxfData);
  const loops = [];
  if (cutPrimitives.length) {
    const adjacency = new Map();
    const visited = new Set();
    const addAdjacency = (key, value) => {
      const existing = adjacency.get(key);
      if (existing) {
        existing.push(value);
        return;
      }
      adjacency.set(key, [value]);
    };

    cutPrimitives.forEach((primitive, index) => {
      const startKey = pointKey(primitive.points[0]);
      const endKey = pointKey(primitive.points[primitive.points.length - 1]);
      addAdjacency(startKey, { index, reverse: false });
      addAdjacency(endKey, { index, reverse: true });
    });

    for (let primitiveIndex = 0; primitiveIndex < cutPrimitives.length; primitiveIndex += 1) {
      if (visited.has(primitiveIndex)) {
        continue;
      }
      visited.add(primitiveIndex);
      let loopPoints = [...cutPrimitives[primitiveIndex].points];
      const startKey = pointKey(loopPoints[0]);
      let currentKey = pointKey(loopPoints[loopPoints.length - 1]);
      let guard = 0;

      while (currentKey !== startKey) {
        const nextOptions = (adjacency.get(currentKey) || []).filter(({ index }) => !visited.has(index));
        if (!nextOptions.length) {
          return { loops: [], rawBounds };
        }
        const nextOption = nextOptions[0];
        visited.add(nextOption.index);
        const primitivePoints = cutPrimitives[nextOption.index].points;
        const orientedPoints = nextOption.reverse ? reversePoints(primitivePoints) : primitivePoints;
        loopPoints = loopPoints.concat(orientedPoints.slice(1));
        currentKey = pointKey(orientedPoints[orientedPoints.length - 1]);
        guard += 1;
        if (guard > cutPrimitives.length + 4) {
          return { loops: [], rawBounds };
        }
      }

      loopPoints = removeConsecutiveDuplicates(loopPoints);
      if (loopPoints.length >= 3) {
        loops.push(loopPoints);
      }
    }
  }

  for (const circleLoop of cutCircleLoops) {
    if (circleLoop.length >= 3) {
      loops.push(circleLoop);
    }
  }

  return { loops, rawBounds };
}

function formatSvgNumber(value) {
  const rounded = Math.round(toFiniteNumber(value) * 1_000_000) / 1_000_000;
  return Math.abs(rounded) < ANGLE_EPSILON ? "0" : String(rounded);
}

function screenPoint(point, bounds) {
  return [
    point[0] - bounds.minX,
    bounds.maxY - point[1]
  ];
}

function buildDxfMaterialFillPathData(dxfData) {
  const { loops, rawBounds } = buildCutLoops(dxfData);
  if (!rawBounds || !loops.length) {
    return "";
  }
  return loops
    .map((loop) => {
      const screenLoop = loop.map((point) => screenPoint(point, rawBounds));
      if (screenLoop.length < 3) {
        return "";
      }
      const [first, ...rest] = screenLoop;
      return [
        `M ${formatSvgNumber(first[0])} ${formatSvgNumber(first[1])}`,
        ...rest.map((point) => `L ${formatSvgNumber(point[0])} ${formatSvgNumber(point[1])}`),
        "Z"
      ].join(" ");
    })
    .filter(Boolean)
    .join(" ");
}

function readCssVar(name, fallback) {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function readPalette() {
  return {
    background: readCssVar("--ui-app-bg", "#f3f4f6"),
    cutStroke: readCssVar("--ui-text", "#111827"),
    bendStroke: readCssVar("--ui-accent", "#b45309")
  };
}

function buildFittedViewBox(bounds, viewport) {
  const width = Math.max(Number(bounds?.width) || 0, MIN_VIEW_SIZE);
  const height = Math.max(Number(bounds?.height) || 0, MIN_VIEW_SIZE);
  const viewportWidth = Math.max(Number(viewport?.width) || 0, 1);
  const viewportHeight = Math.max(Number(viewport?.height) || 0, 1);
  const paddedWidth = width * (1 + VIEW_PADDING_RATIO * 2);
  const paddedHeight = height * (1 + VIEW_PADDING_RATIO * 2);
  const contentAspect = paddedWidth / Math.max(paddedHeight, MIN_VIEW_SIZE);
  const viewportAspect = viewportWidth / viewportHeight;

  let viewWidth = paddedWidth;
  let viewHeight = paddedHeight;
  if (contentAspect > viewportAspect) {
    viewHeight = viewWidth / viewportAspect;
  } else {
    viewWidth = viewHeight * viewportAspect;
  }

  return {
    x: (width - viewWidth) / 2,
    y: (height - viewHeight) / 2,
    width: Math.max(viewWidth, MIN_VIEW_SIZE),
    height: Math.max(viewHeight, MIN_VIEW_SIZE)
  };
}

function clampViewBox(nextViewBox, baseViewBox) {
  const minWidth = Math.max(baseViewBox.width / MAX_ZOOM_IN, MIN_VIEW_SIZE);
  const minHeight = Math.max(baseViewBox.height / MAX_ZOOM_IN, MIN_VIEW_SIZE);
  const maxWidth = Math.max(baseViewBox.width * MAX_ZOOM_OUT, MIN_VIEW_SIZE);
  const maxHeight = Math.max(baseViewBox.height * MAX_ZOOM_OUT, MIN_VIEW_SIZE);
  return {
    x: Number(nextViewBox.x) || 0,
    y: Number(nextViewBox.y) || 0,
    width: Math.min(Math.max(Number(nextViewBox.width) || baseViewBox.width, minWidth), maxWidth),
    height: Math.min(Math.max(Number(nextViewBox.height) || baseViewBox.height, minHeight), maxHeight)
  };
}

function areViewBoxesEqual(a, b) {
  return (
    Math.abs((Number(a?.x) || 0) - (Number(b?.x) || 0)) < VIEWBOX_EPSILON &&
    Math.abs((Number(a?.y) || 0) - (Number(b?.y) || 0)) < VIEWBOX_EPSILON &&
    Math.abs((Number(a?.width) || 0) - (Number(b?.width) || 0)) < VIEWBOX_EPSILON &&
    Math.abs((Number(a?.height) || 0) - (Number(b?.height) || 0)) < VIEWBOX_EPSILON
  );
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((value) => {
        if (value) {
          resolve(value);
          return;
        }
        reject(new Error("Failed to encode screenshot"));
      }, "image/png");
      return;
    }

    try {
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1] || "";
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      resolve(new Blob([bytes], { type: "image/png" }));
    } catch (error) {
      reject(error instanceof Error ? error : new Error("Failed to encode screenshot"));
    }
  });
}

async function buildSvgScreenshotBlob(svgElement, { width, height, backgroundColor }) {
  const serializer = new XMLSerializer();
  const svgMarkup = serializer.serializeToString(svgElement);
  const blob = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);

  try {
    const image = await new Promise((resolve, reject) => {
      const nextImage = new Image();
      nextImage.onload = () => resolve(nextImage);
      nextImage.onerror = () => reject(new Error("Failed to render DXF screenshot"));
      nextImage.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Failed to create screenshot canvas");
    }
    context.fillStyle = backgroundColor;
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    return await canvasToBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

const DxfViewer = forwardRef(function DxfViewer({
  dxfData,
  modelKey,
  themeSettings = null,
  showViewPlane = true,
  viewPlaneOffsetRight = 16,
  viewPlaneOffsetBottom = "1rem",
  viewPlaneHeader = null,
  onViewerAlertChange
}, ref) {
  const containerRef = useRef(null);
  const svgRef = useRef(null);
  const dragStateRef = useRef(null);
  const previousModelKeyRef = useRef(modelKey);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [viewBox, setViewBox] = useState({ x: 0, y: 0, width: 1, height: 1 });
  const palette = readPalette();
  const materialFill = resolveThemeFillColor(themeSettings?.materials || {}, 0);

  const boundsWidth = Math.max(Number(dxfData?.bounds?.width) || 0, MIN_VIEW_SIZE);
  const boundsHeight = Math.max(Number(dxfData?.bounds?.height) || 0, MIN_VIEW_SIZE);
  const fillPathData = useMemo(() => {
    try {
      return buildDxfMaterialFillPathData(dxfData);
    } catch {
      return "";
    }
  }, [dxfData]);
  const fittedViewBox = useMemo(
    () => buildFittedViewBox(
      { width: boundsWidth, height: boundsHeight },
      viewportSize
    ),
    [boundsHeight, boundsWidth, viewportSize.height, viewportSize.width]
  );

  useEffect(() => {
    onViewerAlertChange?.(null);
  }, [modelKey, onViewerAlertChange]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element || typeof ResizeObserver !== "function") {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const nextEntry = entries[0];
      if (!nextEntry) {
        return;
      }
      setViewportSize((current) => {
        const nextWidth = nextEntry.contentRect.width;
        const nextHeight = nextEntry.contentRect.height;
        if (current.width === nextWidth && current.height === nextHeight) {
          return current;
        }
        return {
          width: nextWidth,
          height: nextHeight
        };
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const modelChanged = previousModelKeyRef.current !== modelKey;
    previousModelKeyRef.current = modelKey;

    setViewBox((current) => {
      if (!modelChanged && areViewBoxesEqual(current, fittedViewBox)) {
        return current;
      }
      return fittedViewBox;
    });
  }, [
    fittedViewBox.height,
    fittedViewBox.width,
    fittedViewBox.x,
    fittedViewBox.y,
    modelKey
  ]);

  useEffect(() => {
    const clearDrag = () => {
      dragStateRef.current = null;
    };
    window.addEventListener("pointerup", clearDrag);
    window.addEventListener("pointercancel", clearDrag);
    return () => {
      window.removeEventListener("pointerup", clearDrag);
      window.removeEventListener("pointercancel", clearDrag);
    };
  }, []);

  useImperativeHandle(ref, () => ({
    async captureScreenshot({ filename = "cad-screenshot.png", mode = "download" } = {}) {
      const container = containerRef.current;
      const svgElement = svgRef.current;
      if (!container || !svgElement) {
        throw new Error("CAD Viewer not ready");
      }

      const rect = container.getBoundingClientRect();
      const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
      const width = Math.max(1, Math.round(rect.width * pixelRatio));
      const height = Math.max(1, Math.round(rect.height * pixelRatio));
      const blobPromise = buildSvgScreenshotBlob(svgElement, {
        width,
        height,
        backgroundColor: palette.background
      });

      if (mode === "clipboard") {
        return await copyImageBlobToClipboard(blobPromise);
      }

      const blob = await blobPromise;
      return triggerBlobDownload(blob, { filename });
    }
  }), [palette.background]);

  const handlePointerDown = (event) => {
    if (event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragStateRef.current = {
      clientX: event.clientX,
      clientY: event.clientY
    };
  };

  const handlePointerMove = (event) => {
    const dragState = dragStateRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!dragState || !rect || !rect.width || !rect.height) {
      return;
    }

    const deltaX = event.clientX - dragState.clientX;
    const deltaY = event.clientY - dragState.clientY;
    dragStateRef.current = {
      clientX: event.clientX,
      clientY: event.clientY
    };

    setViewBox((current) => ({
      ...current,
      x: current.x - (deltaX / rect.width) * current.width,
      y: current.y - (deltaY / rect.height) * current.height
    }));
  };

  const handleWheel = (event) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) {
      return;
    }

    event.preventDefault();
    const cursorX = (event.clientX - rect.left) / rect.width;
    const cursorY = (event.clientY - rect.top) / rect.height;
    const scale = event.deltaY > 0 ? WHEEL_ZOOM_FACTOR : 1 / WHEEL_ZOOM_FACTOR;

    setViewBox((current) => {
      const nextWidth = current.width * scale;
      const nextHeight = current.height * scale;
      const anchorX = current.x + current.width * cursorX;
      const anchorY = current.y + current.height * cursorY;
      return clampViewBox(
        {
          x: anchorX - nextWidth * cursorX,
          y: anchorY - nextHeight * cursorY,
          width: nextWidth,
          height: nextHeight
        },
        fittedViewBox
      );
    });
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 touch-none select-none"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onDoubleClick={() => {
        setViewBox(fittedViewBox);
      }}
      onWheel={handleWheel}
    >
      <svg
        ref={svgRef}
        className="h-full w-full"
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        xmlns="http://www.w3.org/2000/svg"
      >
        <rect
          x={viewBox.x}
          y={viewBox.y}
          width={viewBox.width}
          height={viewBox.height}
          fill={palette.background}
        />
        {fillPathData ? (
          <path
            d={fillPathData}
            fill={materialFill}
            fillOpacity="0.96"
            fillRule="evenodd"
            stroke="none"
          />
        ) : null}
        {Array.isArray(dxfData?.paths) ? dxfData.paths.map((path, index) => {
          const isBendPath = path?.kind === "bend";
          return (
            <path
              key={`${path?.layer || "path"}:${index}`}
              d={String(path?.d || "")}
              fill="none"
              stroke={isBendPath ? palette.bendStroke : palette.cutStroke}
              strokeDasharray={isBendPath ? "8 6" : undefined}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={isBendPath ? 1.5 : 1.75}
              vectorEffect="non-scaling-stroke"
            />
          );
        }) : null}
        {Array.isArray(dxfData?.circles) ? dxfData.circles.map((circle, index) => {
          const isBendCircle = circle?.kind === "bend";
          return (
            <circle
              key={`${circle?.layer || "circle"}:${index}`}
              cx={Number(circle?.cx) || 0}
              cy={Number(circle?.cy) || 0}
              r={Math.max(Number(circle?.r) || 0, 0)}
              fill="none"
              stroke={isBendCircle ? palette.bendStroke : palette.cutStroke}
              strokeDasharray={isBendCircle ? "8 6" : undefined}
              strokeWidth={isBendCircle ? 1.5 : 1.75}
              vectorEffect="non-scaling-stroke"
            />
          );
        }) : null}
      </svg>
      <ViewPlaneControl
        showViewPlane={showViewPlane}
        previewMode={false}
        isLoading={false}
        meshData={dxfData ? DXF_2D_VIEW_PLANE_MESH : null}
        viewPlaneOffsetRight={viewPlaneOffsetRight}
        viewPlaneOffsetBottom={viewPlaneOffsetBottom}
        activeViewPlaneFace="z+"
        viewPlaneFaces={DXF_2D_VIEW_PLANE_FACES}
        viewPlaneOrientation={DXF_2D_VIEW_PLANE_ORIENTATION}
        viewerTheme={null}
        variant="2d"
        viewPlaneHeader={viewPlaneHeader}
        activateViewPlaneFace={() => {
          setViewBox(fittedViewBox);
        }}
        activateDefaultViewPlane={() => {
          setViewBox(fittedViewBox);
        }}
      />
    </div>
  );
});

export default DxfViewer;
