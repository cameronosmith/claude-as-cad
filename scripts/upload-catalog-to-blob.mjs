#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  inlineStepGlbArtifactPathForSource,
  stepParameterPathForStepSource,
} from "cadjs/common/stepSidecars.mjs";
import {
  CAD_CATALOG_SCHEMA_VERSION,
  isServedCadAsset,
  scanCadDirectory,
  VIEWER_SKIPPED_DIRECTORIES,
} from "../src/server/catalog/cadDirectoryScanner.mjs";
import {
  pathIsInsideOrEqual,
  toPosixPath,
} from "cadjs/lib/pathUtils.mjs";

import {
  CATALOG_BLOB_CACHE_CONTROL_MAX_AGE_SECONDS,
  contentTypeForFileRef,
  createVercelBlobAssetBackend,
  normalizeVercelBlobCatalog,
} from "../src/server/vercelBlobAssetBackend.mjs";
import {
  envValue,
  normalizeViewerAssetBackend,
  vercelBlobConfigFromEnv,
  VIEWER_ASSET_BACKENDS,
} from "../src/server/viewerEnv.mjs";

export const DEFAULT_UPLOAD_IGNORE_FILE = ".vieweruploadignore";
export const DEFAULT_UPLOAD_EXCLUDE_PATTERNS = Object.freeze([
  "/mechbench/",
  "/mechbench2/",
  "/7dof_arm/",
  "*.py",
]);
const DEFAULT_UPLOAD_CONCURRENCY = 4;
const CACHE_BUSTED_UPLOAD_EXTENSIONS = new Set([".js", ".mjs"]);
const GIT_LFS_POINTER_PREFIX = "version https://git-lfs.github.com/spec/v1";

function usage() {
  return `Usage:
  npm --prefix viewer run upload:blob -- [directory] [options]

Uploads a CAD Viewer catalog and viewer-supported assets to Vercel Blob.

Options:
  --ignore-file <file>    Gitignore-style exclude file. May be repeated.
  --exclude <pattern>     Gitignore-style exclude pattern. May be repeated.
  --concurrency <n>       Concurrent uploads. Defaults to ${DEFAULT_UPLOAD_CONCURRENCY}.
  --skip-existing         Skip assets whose content is already in the remote catalog.
  --fetch-missing-lfs     Fetch Git LFS pointers only for assets that must be uploaded.
  -h, --help              Show this help.

Environment:
  VIEWER_VERCEL_BLOB_PREFIX
  VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN or BLOB_READ_WRITE_TOKEN
  VIEWER_ASSET_BACKEND=vercel-blob (optional)

Default excludes:
  ${DEFAULT_UPLOAD_EXCLUDE_PATTERNS.join("\n  ")}`;
}

function cleanPosixPath(value) {
  const normalized = path.posix.normalize(String(value || "").trim().replace(/\\/g, "/").replace(/^\/+/, ""));
  return normalized && normalized !== "." && !normalized.startsWith("../") ? normalized : "";
}

function fileStats(filePath) {
  try {
    const stats = fs.statSync(filePath, { bigint: true });
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function fileAssetMetadata(filePath) {
  const stats = fileStats(filePath);
  if (!stats) {
    return null;
  }
  return {
    hash: sha256File(filePath),
    bytes: Number(stats.size),
  };
}

function readGitLfsPointer(filePath) {
  const stats = fileStats(filePath);
  if (!stats || Number(stats.size) > 1024) {
    return null;
  }
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  if (!text.startsWith(GIT_LFS_POINTER_PREFIX)) {
    return null;
  }
  const oid = /^oid sha256:([a-f0-9]{64})$/mi.exec(text)?.[1] || "";
  const sizeText = /^size ([0-9]+)$/mi.exec(text)?.[1] || "";
  return {
    oid,
    size: sizeText ? Number(sizeText) : 0,
  };
}

function comparableFileAssetMetadata(filePath) {
  const pointer = readGitLfsPointer(filePath);
  if (pointer?.oid) {
    return {
      hash: pointer.oid,
      bytes: pointer.size,
      gitLfsPointer: true,
    };
  }
  const metadata = fileAssetMetadata(filePath);
  return metadata
    ? {
        ...metadata,
        gitLfsPointer: false,
      }
    : null;
}

function cacheBustedUploadFileRef({ fileRef, hash }) {
  const normalizedRef = cleanPosixPath(fileRef);
  const extension = path.posix.extname(normalizedRef).toLowerCase();
  const normalizedHash = String(hash || "").trim().replace(/[^a-fA-F0-9]/g, "").slice(0, 16);
  if (!normalizedRef || !normalizedHash || !CACHE_BUSTED_UPLOAD_EXTENSIONS.has(extension)) {
    return normalizedRef;
  }
  return `${normalizedRef.slice(0, -extension.length)}.${normalizedHash}${extension}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExpSource(pattern) {
  let source = "";
  for (let index = 0; index < pattern.length;) {
    const char = pattern[index];
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 2;
      } else {
        source += "[^/]*";
        index += 1;
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      index += 1;
      continue;
    }
    source += escapeRegExp(char);
    index += 1;
  }
  return source;
}

function normalizeIgnoreLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return "";
  }
  return trimmed.startsWith("\\#") ? trimmed.slice(1) : trimmed;
}

export function parseIgnorePatterns(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(normalizeIgnoreLine)
    .filter(Boolean);
}

function compileIgnoreRule(rawPattern) {
  let pattern = normalizeIgnoreLine(rawPattern);
  if (!pattern) {
    return null;
  }
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = normalizeIgnoreLine(pattern.slice(1));
  }
  if (!pattern) {
    return null;
  }
  const directoryOnly = pattern.endsWith("/");
  const anchored = pattern.startsWith("/");
  const normalizedPattern = pattern.replace(/^\/+|\/+$/g, "");
  if (!normalizedPattern) {
    return null;
  }
  const basenameOnly = !normalizedPattern.includes("/");
  const regexSource = globToRegExpSource(normalizedPattern);
  const regex = basenameOnly
    ? new RegExp(`(?:^|/)${regexSource}${directoryOnly ? "(?:/|$)" : "$"}`)
    : new RegExp(`${anchored ? "^" : "(?:^|.*/)"}${regexSource}${directoryOnly ? "(?:/|$)" : "$"}`);
  return {
    negated,
    pattern,
    regex,
  };
}

export function createIgnoreMatcher(patterns = []) {
  const rules = patterns
    .map(compileIgnoreRule)
    .filter(Boolean);
  return ({ relativePath = "", isDirectory = false } = {}) => {
    const normalizedPath = cleanPosixPath(relativePath);
    if (!normalizedPath) {
      return false;
    }
    const target = isDirectory ? `${normalizedPath}/` : normalizedPath;
    let ignored = false;
    for (const rule of rules) {
      if (rule.regex.test(target)) {
        ignored = !rule.negated;
      }
    }
    return ignored;
  };
}

function readIgnoreFile(ignoreFile, cwd) {
  const resolved = path.resolve(cwd, ignoreFile);
  return parseIgnorePatterns(fs.readFileSync(resolved, "utf-8"));
}

function resolveUploadRoot({
  directory = "",
  rootDir = "",
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  if (rootDir) {
    throw new Error("--root-dir has been removed; pass the upload directory as the positional argument.");
  }
  const callerRoot = path.resolve(env.INIT_CWD || cwd);
  const rawRootDir = directory || ".";
  const resolvedDirectory = path.resolve(callerRoot, rawRootDir);
  return {
    repoRoot: resolvedDirectory,
    rootDir: "",
    rootPath: resolvedDirectory,
  };
}

function includePathFromIgnoreMatcher(ignoreMatcher) {
  return ({ relativePath, isDirectory }) => !ignoreMatcher({ relativePath, isDirectory });
}

function shouldSkipUploadDirectory(name) {
  return VIEWER_SKIPPED_DIRECTORIES.has(name) || String(name || "").startsWith(".");
}

function rootRelativePath(rootPath, filePath) {
  const relativePath = path.relative(path.resolve(rootPath), path.resolve(filePath));
  if (!pathIsInsideOrEqual(filePath, rootPath)) {
    return "";
  }
  return cleanPosixPath(toPosixPath(relativePath));
}

function isPythonSourceFileRef(fileRef) {
  const raw = String(fileRef || "").trim().replace(/\\/g, "/");
  let pathname = raw.split(/[?#]/)[0];
  try {
    pathname = new URL(raw).pathname;
  } catch {
    // Plain catalog refs are expected here.
  }
  return path.posix.extname(cleanPosixPath(pathname)).toLowerCase() === ".py";
}

function addUploadFile(uploadFiles, { rootPath, filePath }) {
  const fileRef = rootRelativePath(rootPath, filePath);
  if (!fileRef) {
    return;
  }
  const stats = fileStats(filePath);
  if (!stats) {
    return;
  }
  uploadFiles.set(fileRef, {
    fileRef,
    filePath,
    bytes: Number(stats.size),
  });
}

function maybeAddAbsoluteUploadFile(uploadFiles, {
  rootPath,
  filePath,
  includePath = null,
}) {
  const fileRef = rootRelativePath(rootPath, filePath);
  if (!fileRef) {
    return null;
  }
  if (includePath && includePath({ filePath, relativePath: fileRef, isDirectory: false }) === false) {
    return null;
  }
  addUploadFile(uploadFiles, { rootPath, filePath });
  return uploadFiles.get(fileRef) || null;
}

function collectServedAssetFiles(rootPath, {
  scanRootPath = rootPath,
  includePath = null,
  uploadFiles = new Map(),
} = {}) {
  let entries = [];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return uploadFiles;
  }

  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    const relativePath = rootRelativePath(scanRootPath, entryPath);
    if (entry.isDirectory()) {
      if (
        !shouldSkipUploadDirectory(entry.name) &&
        (!includePath || includePath({ filePath: entryPath, relativePath, isDirectory: true }) !== false)
      ) {
        collectServedAssetFiles(entryPath, { scanRootPath, includePath, uploadFiles });
      }
      continue;
    }
    if (
      entry.isFile() &&
      (!includePath || includePath({ filePath: entryPath, relativePath, isDirectory: false }) !== false) &&
      isServedCadAsset(entryPath)
    ) {
      addUploadFile(uploadFiles, { rootPath: scanRootPath, filePath: entryPath });
    }
  }

  return uploadFiles;
}

function resolveExistingFileInsideRoot({ repoRoot, rootPath, fileRef }) {
  const normalizedRef = cleanPosixPath(fileRef);
  if (!normalizedRef) {
    return null;
  }
  const candidates = [
    path.resolve(rootPath, normalizedRef),
    path.resolve(repoRoot, normalizedRef),
  ];
  for (const candidate of [...new Set(candidates)]) {
    if (pathIsInsideOrEqual(candidate, rootPath) && fileStats(candidate)) {
      return {
        filePath: candidate,
        fileRef: rootRelativePath(rootPath, candidate),
      };
    }
  }
  return null;
}

function sourceFileRefsForEntry(entry, { includeSourceCode = true } = {}) {
  const refs = [
    entry?.sourceFile,
    entry?.source?.file,
    entry?.source?.path,
    entry?.source?.sourcePath,
  ].map(cleanPosixPath).filter(Boolean);
  return includeSourceCode ? refs : refs.filter((ref) => !isPythonSourceFileRef(ref));
}

function maybeAddCatalogRef(uploadFiles, {
  repoRoot,
  rootPath,
  includePath,
  fileRef,
}) {
  const resolved = resolveExistingFileInsideRoot({ repoRoot, rootPath, fileRef });
  if (!resolved) {
    return null;
  }
  if (includePath && includePath({
    filePath: resolved.filePath,
    relativePath: resolved.fileRef,
    isDirectory: false,
  }) === false) {
    return null;
  }
  addUploadFile(uploadFiles, { rootPath, filePath: resolved.filePath });
  return resolved;
}

function addCatalogReferencedFiles(uploadFiles, {
  catalog,
  repoRoot,
  rootPath,
  includePath,
}) {
  for (const entry of Array.isArray(catalog?.entries) ? catalog.entries : []) {
    const fileRef = cleanPosixPath(entry?.file);
    maybeAddCatalogRef(uploadFiles, { repoRoot, rootPath, includePath, fileRef });

    const extension = path.posix.extname(fileRef).toLowerCase();
    if (extension === ".step" || extension === ".stp") {
      const stepPath = path.resolve(rootPath, fileRef);
      maybeAddAbsoluteUploadFile(uploadFiles, {
        rootPath,
        filePath: inlineStepGlbArtifactPathForSource(stepPath),
        includePath,
      });
      maybeAddAbsoluteUploadFile(uploadFiles, {
        rootPath,
        filePath: stepParameterPathForStepSource(stepPath),
        includePath,
      });
    }

    maybeAddCatalogRef(uploadFiles, {
      repoRoot,
      rootPath,
      includePath,
      fileRef: entry?.relations?.urdf?.file,
    });

    for (const sourceRef of sourceFileRefsForEntry(entry, { includeSourceCode: false })) {
      maybeAddCatalogRef(uploadFiles, { repoRoot, rootPath, includePath, fileRef: sourceRef });
    }
  }
  return uploadFiles;
}

function normalizedHash(value) {
  return String(value || "").trim().toLowerCase().replace(/^sha256:/i, "");
}

function normalizedBytes(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function pathnameFromUrl(url) {
  try {
    return new URL(url).pathname.replace(/^\/+/, "");
  } catch {
    return "";
  }
}

function catalogUploadRecord({ fileRef, url = "", hash = "", bytes = undefined } = {}) {
  const normalizedRef = cleanPosixPath(fileRef);
  const normalizedUrl = String(url || "").trim();
  if (!normalizedRef || !normalizedUrl) {
    return null;
  }
  const normalized = {
    fileRef: normalizedRef,
    filePath: "",
    hash: normalizedHash(hash),
    blobFileRef: cleanPosixPath(pathnameFromUrl(normalizedUrl)) || normalizedRef,
    url: normalizedUrl,
    pathname: pathnameFromUrl(normalizedUrl),
  };
  const bytesNumber = Number(bytes);
  if (String(bytes ?? "").trim() && Number.isFinite(bytesNumber)) {
    normalized.bytes = bytesNumber;
  }
  return normalized;
}

function addExistingCatalogUpload(uploads, upload) {
  if (upload?.fileRef && upload?.url) {
    uploads.set(upload.fileRef, upload);
  }
}

function catalogFieldUpload(fileRef, value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  return catalogUploadRecord({
    fileRef,
    url: value.url,
    hash: value.hash,
    bytes: value.bytes,
  });
}

function cacheBustedHashFromUrl(url, extension) {
  let basename = "";
  try {
    basename = path.posix.basename(new URL(url).pathname);
  } catch {
    return "";
  }
  const escapedExtension = escapeRegExp(extension);
  const match = new RegExp(`\\.([a-fA-F0-9]{16})${escapedExtension}$`).exec(basename);
  return match?.[1]?.toLowerCase() || "";
}

function existingCatalogUploads(catalog, { rootPath } = {}) {
  const uploads = new Map();
  for (const entry of Array.isArray(catalog?.entries) ? catalog.entries : []) {
    const fileRef = cleanPosixPath(entry?.file);
    if (!fileRef) {
      continue;
    }
    const extension = path.posix.extname(fileRef).toLowerCase();
    if (extension === ".step" || extension === ".stp") {
      addExistingCatalogUpload(uploads, catalogFieldUpload(fileRef, {
        ...(entry?.step && typeof entry.step === "object" ? entry.step : {}),
        url: entry?.stepUrl || entry?.step?.url,
        hash: entry?.stepHash || entry?.step?.hash,
        bytes: entry?.stepBytes || entry?.step?.bytes,
      }));

      if (rootPath) {
        const stepPath = path.resolve(rootPath, fileRef);
        const glbRef = rootRelativePath(rootPath, inlineStepGlbArtifactPathForSource(stepPath));
        addExistingCatalogUpload(uploads, catalogUploadRecord({
          fileRef: glbRef,
          url: entry?.url,
          hash: entry?.hash,
          bytes: entry?.bytes,
        }));

        const moduleRef = rootRelativePath(rootPath, stepParameterPathForStepSource(stepPath));
        const moduleUrl = String(entry?.moduleUrl || "").trim();
        addExistingCatalogUpload(uploads, catalogUploadRecord({
          fileRef: moduleRef,
          url: moduleUrl,
          hash: cacheBustedHashFromUrl(moduleUrl, path.posix.extname(moduleRef).toLowerCase()),
          bytes: entry?.moduleBytes,
        }));
      }
    } else {
      addExistingCatalogUpload(uploads, catalogFieldUpload(fileRef, entry));
    }

    const relationUrdf = entry?.relations?.urdf;
    addExistingCatalogUpload(uploads, catalogFieldUpload(relationUrdf?.file, relationUrdf));

    const source = entry?.source;
    if (source && !isPythonSourceFileRef(source?.file || source?.sourcePath || "")) {
      addExistingCatalogUpload(uploads, catalogFieldUpload(source?.file || source?.sourcePath, source));
    }
  }
  return uploads;
}

function uploadMatchesExistingCatalog(uploadFile, existingUpload) {
  const existingHash = normalizedHash(existingUpload?.hash);
  if (!existingHash) {
    return false;
  }
  const metadata = comparableFileAssetMetadata(uploadFile.filePath);
  const localHash = normalizedHash(metadata?.hash);
  if (!localHash || localHash !== existingHash) {
    return false;
  }
  const existingBytes = normalizedBytes(existingUpload?.bytes);
  const localBytes = normalizedBytes(metadata?.bytes);
  return !existingBytes || !localBytes || existingBytes === localBytes;
}

function findGitRoot({ cwd = process.cwd(), rootPath = "" } = {}) {
  const candidates = [cwd, rootPath].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync("git", ["-C", candidate, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
    });
    if (result.status === 0) {
      return String(result.stdout || "").trim();
    }
  }
  return "";
}

function gitRelativePath(gitRoot, filePath) {
  const relativePath = path.relative(path.resolve(gitRoot), path.resolve(filePath));
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return "";
  }
  return toPosixPath(relativePath);
}

function ensureGitLfsFiles({
  uploadFiles,
  cwd = process.cwd(),
  rootPath = "",
  logger = console,
} = {}) {
  const pointerFiles = uploadFiles
    .filter((uploadFile) => readGitLfsPointer(uploadFile.filePath))
    .sort((a, b) => a.fileRef.localeCompare(b.fileRef));
  if (!pointerFiles.length) {
    return 0;
  }

  const gitRoot = findGitRoot({ cwd, rootPath });
  if (!gitRoot) {
    throw new Error("Cannot fetch Git LFS pointers because the upload directory is not inside a git worktree.");
  }
  const includePaths = pointerFiles
    .map((uploadFile) => gitRelativePath(gitRoot, uploadFile.filePath))
    .filter(Boolean);
  if (includePaths.length !== pointerFiles.length) {
    throw new Error("Cannot fetch Git LFS pointers because one or more upload files are outside the git worktree.");
  }

  logger.log?.(`Fetching ${includePaths.length} Git LFS object(s) for missing Blob uploads.`);
  const result = spawnSync("git", [
    "-C",
    gitRoot,
    "lfs",
    "pull",
    "--include",
    includePaths.join(","),
    "--exclude",
    "",
  ], {
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`git lfs pull failed while fetching missing Blob upload assets (exit ${result.status ?? "unknown"}).`);
  }
  const remainingPointers = pointerFiles.filter((uploadFile) => readGitLfsPointer(uploadFile.filePath));
  if (remainingPointers.length) {
    throw new Error(
      `Git LFS did not materialize ${remainingPointers.length} upload asset(s): ` +
      remainingPointers.map((uploadFile) => uploadFile.fileRef).join(", ")
    );
  }
  return pointerFiles.length;
}

function assertNoGitLfsPointers(uploadFiles) {
  const pointerFile = uploadFiles.find((uploadFile) => readGitLfsPointer(uploadFile.filePath));
  if (pointerFile) {
    throw new Error(
      `${pointerFile.fileRef} is a Git LFS pointer. ` +
      "Use --fetch-missing-lfs to fetch only missing Blob upload assets before uploading."
    );
  }
}

async function uploadOneFile(backend, uploadFile) {
  const metadata = fileAssetMetadata(uploadFile.filePath);
  if (!metadata) {
    throw new Error(`Upload asset is not a file: ${uploadFile.fileRef}`);
  }
  const preparedUploadFile = {
    ...uploadFile,
    ...metadata,
  };
  const blobFileRef = cacheBustedUploadFileRef(preparedUploadFile);
  const upload = await backend.writeAsset({
    fileRef: blobFileRef,
    body: fs.createReadStream(preparedUploadFile.filePath),
    contentType: contentTypeForFileRef(preparedUploadFile.fileRef),
  });
  return {
    upload,
    uploadFile: preparedUploadFile,
    blobFileRef,
  };
}

async function uploadFilesToBlob({
  backend,
  uploadFiles,
  concurrency = DEFAULT_UPLOAD_CONCURRENCY,
  logger = console,
  existingUploads = new Map(),
  skipExisting = false,
  fetchMissingLfs = false,
  cwd = process.cwd(),
  rootPath = "",
}) {
  const allFiles = [...uploadFiles.values()].sort((a, b) => a.fileRef.localeCompare(b.fileRef));
  const uploads = new Map();
  const queue = [];
  let skippedCount = 0;
  for (const uploadFile of allFiles) {
    const existingUpload = skipExisting ? existingUploads.get(uploadFile.fileRef) : null;
    if (existingUpload && uploadMatchesExistingCatalog(uploadFile, existingUpload)) {
      logger.log?.(`Skipping existing ${uploadFile.fileRef}`);
      uploads.set(uploadFile.fileRef, {
        ...uploadFile,
        ...existingUpload,
        fileRef: uploadFile.fileRef,
        filePath: uploadFile.filePath,
      });
      skippedCount += 1;
      continue;
    }
    queue.push(uploadFile);
  }

  let fetchedLfsFiles = 0;
  if (fetchMissingLfs) {
    fetchedLfsFiles = ensureGitLfsFiles({ uploadFiles: queue, cwd, rootPath, logger });
  } else {
    assertNoGitLfsPointers(queue);
  }

  let index = 0;
  const workerCount = Math.max(1, Math.min(Number(concurrency) || DEFAULT_UPLOAD_CONCURRENCY, queue.length || 1));
  let uploadedCount = 0;

  async function worker() {
    for (;;) {
      const uploadFile = queue[index];
      index += 1;
      if (!uploadFile) {
        return;
      }
      logger.log?.(`Uploading ${uploadFile.fileRef}`);
      const {
        upload,
        uploadFile: preparedUploadFile,
        blobFileRef,
      } = await uploadOneFile(backend, uploadFile);
      uploadedCount += 1;
      uploads.set(preparedUploadFile.fileRef, {
        ...preparedUploadFile,
        blobFileRef,
        url: upload?.url || "",
        pathname: upload?.pathname || "",
      });
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return {
    uploads,
    uploadedCount,
    skippedCount,
    fetchedLfsFiles,
  };
}

function uploadedAssetForRef(uploads, fileRef) {
  return uploads.get(cleanPosixPath(fileRef)) || null;
}

function rewriteAssetFields(target, upload) {
  if (!upload?.url) {
    return target;
  }
  const next = {
    ...target,
    url: upload.url,
  };
  if (upload.hash) {
    next.hash = upload.hash;
  }
  if (Number.isFinite(Number(upload.bytes))) {
    next.bytes = Number(upload.bytes);
  }
  return next;
}

function containsPythonSourceReference(value) {
  if (typeof value === "string") {
    return isPythonSourceFileRef(value);
  }
  if (Array.isArray(value)) {
    return value.some(containsPythonSourceReference);
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(containsPythonSourceReference);
  }
  return false;
}

const SOURCE_CODE_CATALOG_KEYS = new Set([
  "source",
  "sourceFile",
  "sourcePath",
  "sourceStatus",
  "sourceUrl",
]);

function stripSourceCodeReferences(value, key = "") {
  if (Array.isArray(value)) {
    return value
      .map((item) => stripSourceCodeReferences(item))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") {
    return SOURCE_CODE_CATALOG_KEYS.has(key) && containsPythonSourceReference(value)
      ? undefined
      : value;
  }
  if (SOURCE_CODE_CATALOG_KEYS.has(key) && containsPythonSourceReference(value)) {
    return undefined;
  }
  const stripped = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const nextValue = stripSourceCodeReferences(childValue, childKey);
    if (nextValue !== undefined) {
      stripped[childKey] = nextValue;
    }
  }
  return stripped;
}

function rewriteCatalogEntry(entry, {
  uploads,
  repoRoot,
  rootPath,
}) {
  const nextEntry = { ...entry };
  const fileRef = cleanPosixPath(entry?.file);
  const extension = path.posix.extname(fileRef).toLowerCase();

  if (extension === ".step" || extension === ".stp") {
    const stepUpload = uploadedAssetForRef(uploads, fileRef);
    if (stepUpload) {
      nextEntry.step = rewriteAssetFields({
        ...(nextEntry.step && typeof nextEntry.step === "object" ? nextEntry.step : {}),
        file: fileRef,
      }, stepUpload);
    }

    const glbRef = rootRelativePath(
      rootPath,
      inlineStepGlbArtifactPathForSource(path.resolve(rootPath, fileRef)),
    );
    const glbUpload = uploadedAssetForRef(uploads, glbRef);
    if (glbUpload) {
      Object.assign(nextEntry, rewriteAssetFields({}, glbUpload));
    }

    const moduleRef = rootRelativePath(
      rootPath,
      stepParameterPathForStepSource(path.resolve(rootPath, fileRef)),
    );
    const moduleUpload = uploadedAssetForRef(uploads, moduleRef);
    if (moduleUpload?.url) {
      nextEntry.moduleUrl = moduleUpload.url;
    }
  } else {
    const outputUpload = uploadedAssetForRef(uploads, fileRef);
    if (outputUpload) {
      Object.assign(nextEntry, rewriteAssetFields({}, outputUpload));
    }
  }

  const relationUrdfRef = cleanPosixPath(nextEntry.relations?.urdf?.file);
  const relationUrdfUpload = uploadedAssetForRef(uploads, relationUrdfRef);
  if (relationUrdfUpload) {
    nextEntry.relations = {
      ...nextEntry.relations,
      urdf: rewriteAssetFields({
        ...nextEntry.relations.urdf,
        file: relationUrdfRef,
      }, relationUrdfUpload),
    };
  }

  const sourceRef = sourceFileRefsForEntry(entry, { includeSourceCode: false })
    .map((ref) => resolveExistingFileInsideRoot({ repoRoot, rootPath, fileRef: ref }))
    .find(Boolean)?.fileRef || "";
  const sourceUpload = uploadedAssetForRef(uploads, sourceRef);
  if (sourceUpload) {
    nextEntry.source = rewriteAssetFields({
      ...(nextEntry.source && typeof nextEntry.source === "object" ? nextEntry.source : {}),
      file: sourceUpload.fileRef,
      sourcePath: sourceUpload.fileRef,
    }, sourceUpload);
  }

  return stripSourceCodeReferences(nextEntry);
}

export function rewriteCatalogForBlob(catalog, {
  uploads,
  repoRoot,
  rootPath,
} = {}) {
  return normalizeVercelBlobCatalog({
    schemaVersion: CAD_CATALOG_SCHEMA_VERSION,
    entries: (Array.isArray(catalog?.entries) ? catalog.entries : []).map((entry) => (
      rewriteCatalogEntry(entry, { uploads, repoRoot, rootPath })
    )),
  });
}

// Skip-existing publishes leave unchanged assets as unfetched Git LFS
// pointers, so artifact validation cannot read them and stamps false
// missing_step_topology warnings into the catalog. For those entries, the
// remote catalog entry with the same content hash carries the status computed
// when the real bytes were last scanned, so reuse it.
export function carryForwardRemoteArtifactStatuses(catalog, {
  existingCatalog,
  rootPath,
} = {}) {
  const remoteEntries = Array.isArray(existingCatalog?.entries) ? existingCatalog.entries : [];
  const localEntries = Array.isArray(catalog?.entries) ? catalog.entries : [];
  if (!remoteEntries.length || !localEntries.length || !rootPath) {
    return catalog;
  }
  const remoteByFile = new Map(remoteEntries.map((entry) => [String(entry?.file || ""), entry]));
  let changed = false;
  const entries = localEntries.map((entry) => {
    const artifact = entry?.artifact;
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact) || artifact.ok !== false) {
      return entry;
    }
    const glbPath = cleanPosixPath(String(artifact.glbPath || ""));
    if (!glbPath || !readGitLfsPointer(path.join(rootPath, ...glbPath.split("/")))) {
      return entry;
    }
    const remoteEntry = remoteByFile.get(String(entry?.file || ""));
    const localHash = String(entry?.hash || "");
    if (!remoteEntry || !localHash || String(remoteEntry.hash || "") !== localHash) {
      return entry;
    }
    changed = true;
    if (remoteEntry.artifact === undefined) {
      const { artifact: _droppedArtifact, ...cleanEntry } = entry;
      return cleanEntry;
    }
    return { ...entry, artifact: remoteEntry.artifact };
  });
  return changed ? { ...catalog, entries } : catalog;
}

export function catalogJsonBody(catalog) {
  return JSON.stringify({
    schemaVersion: CAD_CATALOG_SCHEMA_VERSION,
    entries: Array.isArray(catalog?.entries) ? catalog.entries : [],
  }, null, 2);
}

export async function uploadCatalogJsonToBlob({
  backend,
  catalog,
  catalogPath = "catalog.json",
} = {}) {
  if (!backend || typeof backend.writeAsset !== "function") {
    throw new Error("Blob catalog upload requires a writable asset backend.");
  }
  return backend.writeAsset({
    fileRef: catalogPath || "catalog.json",
    body: catalogJsonBody(catalog),
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: CATALOG_BLOB_CACHE_CONTROL_MAX_AGE_SECONDS,
  });
}

function resolveIgnorePatterns({ rootPath, ignoreFiles = [], excludePatterns = [], cwd = process.cwd() }) {
  const patterns = [...DEFAULT_UPLOAD_EXCLUDE_PATTERNS];
  const defaultIgnoreFile = path.join(rootPath, DEFAULT_UPLOAD_IGNORE_FILE);
  if (fs.existsSync(defaultIgnoreFile)) {
    patterns.push(...readIgnoreFile(defaultIgnoreFile, cwd));
  }
  for (const ignoreFile of ignoreFiles) {
    patterns.push(...readIgnoreFile(ignoreFile, cwd));
  }
  patterns.push(...excludePatterns);
  return patterns;
}

export function parseUploadArgs(argv, env = process.env) {
  if (env.VIEWER_LOCAL_ROOT_DIR || env.VIEWER_LOCAL_WORKSPACE_ROOT) {
    throw new Error("VIEWER_LOCAL_ROOT_DIR and VIEWER_LOCAL_WORKSPACE_ROOT have been removed; pass the upload directory as the positional argument.");
  }
  const options = {
    directory: "",
    ignoreFiles: [],
    excludePatterns: [],
    concurrency: DEFAULT_UPLOAD_CONCURRENCY,
    skipExisting: false,
    fetchMissingLfs: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`Missing value for ${arg}`);
      }
      return argv[index];
    };
    if (arg === "-h" || arg === "--help") {
      return { ...options, help: true };
    }
    if (arg === "--root-dir" || arg.startsWith("--root-dir=")) {
      throw new Error("--root-dir has been removed; pass the upload directory as the positional argument.");
    }
    if (arg === "--ignore-file") {
      options.ignoreFiles.push(readValue());
      continue;
    }
    if (arg === "--exclude") {
      options.excludePatterns.push(readValue());
      continue;
    }
    if (arg === "--concurrency") {
      options.concurrency = Number(readValue());
      continue;
    }
    if (arg === "--skip-existing") {
      options.skipExisting = true;
      continue;
    }
    if (arg === "--fetch-missing-lfs") {
      options.fetchMissingLfs = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (options.directory) {
      throw new Error(`Unexpected extra directory: ${arg}`);
    }
    options.directory = arg;
  }

  return options;
}

function assertVercelUploadEnv(env = process.env) {
  const requestedBackend = envValue(env, "VIEWER_ASSET_BACKEND");
  if (
    requestedBackend &&
    normalizeViewerAssetBackend(requestedBackend) !== VIEWER_ASSET_BACKENDS.VERCEL_BLOB
  ) {
    throw new Error("Blob upload requires VIEWER_ASSET_BACKEND=vercel-blob when VIEWER_ASSET_BACKEND is set.");
  }
  const config = vercelBlobConfigFromEnv(env);
  if (!config.prefix) {
    throw new Error("VIEWER_VERCEL_BLOB_PREFIX is required.");
  }
  if (!config.token) {
    throw new Error("VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN or BLOB_READ_WRITE_TOKEN is required for Blob uploads.");
  }
  return config;
}

export async function uploadCatalogDirectoryToVercelBlob({
  directory = "",
  rootDir = "",
  ignoreFiles = [],
  excludePatterns = [],
  concurrency = DEFAULT_UPLOAD_CONCURRENCY,
  skipExisting = false,
  fetchMissingLfs = false,
  env = process.env,
  cwd = process.cwd(),
  client = null,
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const uploadRoot = resolveUploadRoot({ directory, rootDir, env, cwd });
  const ignorePatterns = resolveIgnorePatterns({
    rootPath: uploadRoot.rootPath,
    ignoreFiles,
    excludePatterns,
    cwd,
  });
  const ignoreMatcher = createIgnoreMatcher(ignorePatterns);
  const includePath = includePathFromIgnoreMatcher(ignoreMatcher);
  let catalog = scanCadDirectory({
    repoRoot: uploadRoot.repoRoot,
    rootDir: uploadRoot.rootDir,
    includePath,
  });
  const uploadFiles = collectServedAssetFiles(uploadRoot.rootPath, {
    scanRootPath: uploadRoot.rootPath,
    includePath,
  });
  addCatalogReferencedFiles(uploadFiles, {
    catalog,
    repoRoot: uploadRoot.repoRoot,
    rootPath: uploadRoot.rootPath,
    includePath,
  });

  const config = assertVercelUploadEnv(env);
  const backend = createVercelBlobAssetBackend({
    ...config,
    client,
    fetchImpl,
    readOnly: false,
  });
  let existingUploads = new Map();
  let existingCatalog = null;
  if (skipExisting) {
    try {
      existingCatalog = await backend.readCatalog();
      existingUploads = existingCatalogUploads(existingCatalog, {
        rootPath: uploadRoot.rootPath,
      });
      logger.log?.(`Loaded remote catalog with ${existingUploads.size} upload asset reference(s).`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/404|not found/i.test(message)) {
        throw error;
      }
      logger.log?.(`No remote catalog found at ${backend.catalogPath}; uploading all catalog assets.`);
    }
  }
  const uploadResult = await uploadFilesToBlob({
    backend,
    uploadFiles,
    concurrency,
    logger,
    existingUploads,
    skipExisting,
    fetchMissingLfs,
    cwd,
    rootPath: uploadRoot.rootPath,
  });
  const uploads = uploadResult.uploads;
  if (skipExisting) {
    for (const [fileRef, existingUpload] of existingUploads) {
      if (!uploads.has(fileRef)) {
        uploads.set(fileRef, existingUpload);
      }
    }
  }
  if (uploadResult.fetchedLfsFiles > 0) {
    catalog = scanCadDirectory({
      repoRoot: uploadRoot.repoRoot,
      rootDir: uploadRoot.rootDir,
      includePath,
    });
  }
  const blobCatalog = carryForwardRemoteArtifactStatuses(
    rewriteCatalogForBlob(catalog, {
      uploads,
      repoRoot: uploadRoot.repoRoot,
      rootPath: uploadRoot.rootPath,
    }),
    {
      existingCatalog,
      rootPath: uploadRoot.rootPath,
    },
  );
  const catalogFileRef = config.catalogPath || "catalog.json";
  logger.log?.(`Uploading ${catalogFileRef}`);
  const catalogUpload = await uploadCatalogJsonToBlob({
    backend,
    catalog: blobCatalog,
    catalogPath: catalogFileRef,
  });
  return {
    ...uploadRoot,
    prefix: backend.prefix,
    catalogPath: backend.catalogPath,
    catalogUrl: catalogUpload?.url || "",
    ignoredPatterns: ignorePatterns,
    uploadedFiles: uploadResult.uploadedCount,
    skippedFiles: uploadResult.skippedCount,
    fetchedLfsFiles: uploadResult.fetchedLfsFiles,
    catalogEntries: blobCatalog.entries.length,
    catalog: blobCatalog,
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseUploadArgs(argv);
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await uploadCatalogDirectoryToVercelBlob(options);
  console.log(JSON.stringify({
    prefix: result.prefix,
    catalogPath: result.catalogPath,
    catalogUrl: result.catalogUrl,
    uploadedFiles: result.uploadedFiles,
    skippedFiles: result.skippedFiles,
    fetchedLfsFiles: result.fetchedLfsFiles,
    catalogEntries: result.catalogEntries,
    ignoredPatterns: result.ignoredPatterns,
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
