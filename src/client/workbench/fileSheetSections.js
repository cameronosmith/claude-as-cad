export const FILE_SHEET_SECTION_IDS = Object.freeze({
  FILE_STATUS: "status",
  DXF: "dxf",
  GCODE_TOOLPATH: "toolpath",
  GCODE_FEATURES: "features",
  GCODE_STATS: "stats",
  GCODE_BOUNDS: "bounds",
  STEP_TREE: "tree",
  STEP_PARAMETERS: "parameters",
  ROBOT_SDF: "sdf",
  ROBOT_MOTION: "motion",
  ROBOT_JOINTS: "joints",
  IMPLICIT_GRAPHICS: "graphics",
  THEME_DISPLAY: "display",
  THEME_APPEARANCE: "appearance",
  FILE_METADATA: "metadata"
});

const THEME_SECTION_IDS = Object.freeze([
  FILE_SHEET_SECTION_IDS.THEME_DISPLAY,
  FILE_SHEET_SECTION_IDS.THEME_APPEARANCE
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSectionIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.map(normalizeString).filter(Boolean))];
}

function migrateLegacySectionId(sectionId) {
  if (sectionId === "plate" || sectionId === "bends") {
    return FILE_SHEET_SECTION_IDS.DXF;
  }
  return sectionId;
}

export function renderedFileSheetSectionIds(kind, options = {}) {
  const normalizedKind = normalizeString(kind);
  const isSdf = options.isSdf === true || normalizedKind === "sdf";
  const showJoints = options.showJoints !== false;
  switch (normalizedKind) {
    case "dxf":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        FILE_SHEET_SECTION_IDS.DXF,
        ...THEME_SECTION_IDS,
        FILE_SHEET_SECTION_IDS.FILE_METADATA
      ];
    case "gcode":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        FILE_SHEET_SECTION_IDS.GCODE_TOOLPATH,
        FILE_SHEET_SECTION_IDS.GCODE_FEATURES,
        FILE_SHEET_SECTION_IDS.GCODE_STATS,
        FILE_SHEET_SECTION_IDS.GCODE_BOUNDS,
        ...THEME_SECTION_IDS,
        FILE_SHEET_SECTION_IDS.FILE_METADATA
      ];
    case "step":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        FILE_SHEET_SECTION_IDS.STEP_TREE,
        ...(options.hasStepModulePanel ? [FILE_SHEET_SECTION_IDS.STEP_PARAMETERS] : []),
        ...THEME_SECTION_IDS,
        FILE_SHEET_SECTION_IDS.FILE_METADATA
      ];
    case "urdf":
    case "srdf":
    case "sdf":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        ...(isSdf ? [FILE_SHEET_SECTION_IDS.ROBOT_SDF] : []),
        ...(options.motionEnabled ? [FILE_SHEET_SECTION_IDS.ROBOT_MOTION] : []),
        ...(showJoints ? [FILE_SHEET_SECTION_IDS.ROBOT_JOINTS] : []),
        ...THEME_SECTION_IDS,
        FILE_SHEET_SECTION_IDS.FILE_METADATA
      ];
    case "mesh":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        ...THEME_SECTION_IDS,
        FILE_SHEET_SECTION_IDS.FILE_METADATA
      ];
    case "implicit":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        ...(options.hasImplicitParameterPanel ? [FILE_SHEET_SECTION_IDS.STEP_PARAMETERS] : []),
        FILE_SHEET_SECTION_IDS.IMPLICIT_GRAPHICS,
        ...THEME_SECTION_IDS,
        FILE_SHEET_SECTION_IDS.FILE_METADATA
      ];
    default:
      return [];
  }
}

export function defaultOpenFileSheetSectionIds(kind, options = {}) {
  const normalizedKind = normalizeString(kind);
  const isSdf = options.isSdf === true || normalizedKind === "sdf";
  const showJoints = options.showJoints !== false;
  switch (normalizedKind) {
    case "dxf":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        FILE_SHEET_SECTION_IDS.DXF
      ];
    case "gcode":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        FILE_SHEET_SECTION_IDS.GCODE_TOOLPATH
      ];
    case "step":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        FILE_SHEET_SECTION_IDS.STEP_TREE,
        ...(options.hasStepModulePanel ? [FILE_SHEET_SECTION_IDS.STEP_PARAMETERS] : [])
      ];
    case "urdf":
    case "srdf":
    case "sdf":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        ...(isSdf ? [FILE_SHEET_SECTION_IDS.ROBOT_SDF] : []),
        ...(options.motionEnabled ? [FILE_SHEET_SECTION_IDS.ROBOT_MOTION] : []),
        ...(showJoints ? [FILE_SHEET_SECTION_IDS.ROBOT_JOINTS] : [])
      ];
    case "mesh":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : [])
      ];
    case "implicit":
      return [
        ...(options.hasFileStatus ? [FILE_SHEET_SECTION_IDS.FILE_STATUS] : []),
        ...(options.hasImplicitParameterPanel ? [FILE_SHEET_SECTION_IDS.STEP_PARAMETERS] : [])
      ];
    default:
      return [];
  }
}

export function normalizeFileSheetOpenSectionIds(sectionIds, renderedSectionIds) {
  const rendered = new Set(normalizeSectionIds(renderedSectionIds));
  if (!rendered.size) {
    return [];
  }
  return [...new Set(normalizeSectionIds(sectionIds)
    .map(migrateLegacySectionId)
    .filter((sectionId) => rendered.has(sectionId)))];
}

export function fileSheetSectionIdsWithOpenSection(sectionIds, renderedSectionIds, sectionId) {
  const normalizedSectionId = normalizeString(sectionId);
  const normalizedSectionIds = normalizeFileSheetOpenSectionIds(sectionIds, renderedSectionIds);
  if (!normalizedSectionId || !normalizeSectionIds(renderedSectionIds).includes(normalizedSectionId)) {
    return normalizedSectionIds;
  }
  if (normalizedSectionIds.includes(normalizedSectionId)) {
    return normalizedSectionIds;
  }
  return [...normalizedSectionIds, normalizedSectionId];
}

export function shouldOpenFileSheetForSelectionReveal({ isDesktop = true, source = "viewer" } = {}) {
  return isDesktop || normalizeString(source) !== "viewer";
}
