import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  carryForwardRemoteArtifactStatuses,
  createIgnoreMatcher,
  DEFAULT_UPLOAD_EXCLUDE_PATTERNS,
  parseIgnorePatterns,
  parseUploadArgs,
  rewriteCatalogForBlob,
  uploadCatalogDirectoryToVercelBlob,
} from "./upload-catalog-to-blob.mjs";

function makeTempRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cad-viewer-blob-upload-"));
}

function writeFile(filePath, content = "") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function shortHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function fullHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function gitLfsPointer({ oid, size }) {
  return [
    "version https://git-lfs.github.com/spec/v1",
    `oid sha256:${oid}`,
    `size ${size}`,
    "",
  ].join("\n");
}

test("upload ignore patterns support comments, directory patterns, globs, and negation", () => {
  const patterns = parseIgnorePatterns(`
# comment
/mechbench/
*.tmp
!keep.tmp
`);
  const ignored = createIgnoreMatcher(patterns);

  assert.equal(ignored({ relativePath: "mechbench", isDirectory: true }), true);
  assert.equal(ignored({ relativePath: "mechbench/part.step" }), true);
  assert.equal(ignored({ relativePath: "nested/file.tmp" }), true);
  assert.equal(ignored({ relativePath: "keep.tmp" }), false);
  assert.equal(ignored({ relativePath: "parts/keep.step" }), false);
});

test("parseUploadArgs accepts a directory and repeated ignore options", () => {
  assert.deepEqual(
    parseUploadArgs([
      "models",
      "--ignore-file",
      ".vieweruploadignore",
      "--exclude",
      "/mechbench/",
      "--exclude",
      "/mechbench2/",
      "--concurrency",
      "2",
      "--skip-existing",
      "--fetch-missing-lfs",
    ], {}),
    {
      directory: "models",
      ignoreFiles: [".vieweruploadignore"],
      excludePatterns: ["/mechbench/", "/mechbench2/"],
      concurrency: 2,
      skipExisting: true,
      fetchMissingLfs: true,
    }
  );
});

test("parseUploadArgs rejects removed root-dir and workspace-root flags", () => {
  assert.throws(
    () => parseUploadArgs(["--root-dir", "/repo/models"], {}),
    /--root-dir has been removed/
  );
  assert.throws(
    () => parseUploadArgs(["--root-dir=/repo/models"], {}),
    /--root-dir has been removed/
  );
  assert.throws(
    () => parseUploadArgs(["--workspace-root", "/repo"], {}),
    /Unknown option: --workspace-root/
  );
  assert.throws(
    () => parseUploadArgs([], { VIEWER_LOCAL_ROOT_DIR: "/repo/models" }),
    /VIEWER_LOCAL_ROOT_DIR.*removed/
  );
  assert.throws(
    () => parseUploadArgs([], { VIEWER_LOCAL_WORKSPACE_ROOT: "/repo" }),
    /VIEWER_LOCAL_ROOT_DIR.*removed/
  );
});

test("rewriteCatalogForBlob annotates STEP assets without publishing Python source refs", () => {
  const repoRoot = makeTempRepo();
  const rootPath = path.join(repoRoot, "models");
  writeFile(path.join(rootPath, "parts/bracket.step"), "ISO-10303-21;\nEND-ISO-10303-21;\n");
  writeFile(path.join(rootPath, "parts/bracket.py"), "def gen_step():\n    return None\n");
  const uploads = new Map([
    ["parts/bracket.step", {
      fileRef: "parts/bracket.step",
      filePath: path.join(rootPath, "parts/bracket.step"),
      url: "https://blob.test/models2/parts/bracket.step",
      hash: "step-hash",
      bytes: 12,
    }],
    ["parts/bracket.py", {
      fileRef: "parts/bracket.py",
      filePath: path.join(rootPath, "parts/bracket.py"),
      url: "https://blob.test/models2/parts/bracket.py",
      hash: "py-hash",
      bytes: 34,
    }],
  ]);

  const catalog = rewriteCatalogForBlob({
    schemaVersion: 4,
    entries: [
      {
        file: "parts/bracket.step",
        kind: "part",
        sourceKind: "python",
        source: {
          file: "models/parts/bracket.py",
          sourcePath: "models/parts/bracket.py",
          sourceHash: "source-hash",
        },
        sourceStatus: {
          sourceKind: "python",
          sourcePath: "models/parts/bracket.py",
        },
        artifact: {
          ok: false,
          error: "missing_source_path",
          sourceKind: "python",
          stepPath: "parts/bracket.step",
          glbPath: "parts/.bracket.step.glb",
          message: "GLB STEP_topology is missing required sourcePath identity: parts/.bracket.step.glb.",
        },
      },
    ],
  }, {
    uploads,
    repoRoot,
    rootPath,
  });

  assert.deepEqual(catalog.entries[0].step, {
    file: "parts/bracket.step",
    url: "https://blob.test/models2/parts/bracket.step",
    hash: "step-hash",
    bytes: 12,
  });
  assert.equal(catalog.entries[0].sourceKind, "python");
  assert.equal(catalog.entries[0].source, undefined);
  assert.equal(catalog.entries[0].sourceStatus, undefined);
  assert.equal(catalog.entries[0].artifact, undefined);
  assert.equal(JSON.stringify(catalog).includes(".py"), false);
});

test("rewriteCatalogForBlob keeps non-source-path STEP artifact warnings", () => {
  const repoRoot = makeTempRepo();
  const rootPath = path.join(repoRoot, "models");
  const catalog = rewriteCatalogForBlob({
    schemaVersion: 4,
    entries: [
      {
        file: "parts/bracket.step",
        kind: "part",
        sourceKind: "python",
        artifact: {
          ok: false,
          error: "missing_edge_topology",
          sourceKind: "python",
          stepPath: "parts/bracket.step",
          glbPath: "parts/.bracket.step.glb",
          message: "STEP topology validation requires readable STEP_topology edgeView in the GLB.",
        },
      },
    ],
  }, {
    uploads: new Map(),
    repoRoot,
    rootPath,
  });

  assert.equal(catalog.entries[0].artifact.error, "missing_edge_topology");
});

test("uploadCatalogDirectoryToVercelBlob applies default catalog exclusions", async () => {
  const repoRoot = makeTempRepo();
  writeFile(path.join(repoRoot, "models/keep.stl"), "solid keep\nendsolid keep\n");
  writeFile(path.join(repoRoot, "models/part.step"), "ISO-10303-21;\nEND-ISO-10303-21;\n");
  const stepModuleBody = "export default { manifest: { schemaVersion: 1 } };\n";
  writeFile(path.join(repoRoot, "models/.part.step.js"), stepModuleBody);
  writeFile(path.join(repoRoot, "models/mechbench/skipped.stl"), "solid skip\nendsolid skip\n");
  writeFile(path.join(repoRoot, "models/mechbench2/skipped.stl"), "solid skip\nendsolid skip\n");
  writeFile(path.join(repoRoot, "models/7dof_arm/skipped.step"), "ISO-10303-21;\nEND-ISO-10303-21;\n");
  writeFile(path.join(repoRoot, "models/source.py"), "def gen_step():\n    return None\n");
  const putCalls = [];

  const result = await uploadCatalogDirectoryToVercelBlob({
    directory: "models",
    env: {
      VIEWER_ASSET_BACKEND: "vercel-blob",
      VIEWER_VERCEL_BLOB_PREFIX: "models2",
      VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN: "test-token",
    },
    cwd: repoRoot,
    client: {
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    logger: { log() {} },
  });

  assert.deepEqual(putCalls.map((call) => call.pathname).sort(), [
    `models2/.part.step.${shortHash(stepModuleBody)}.js`,
    "models2/catalog.json",
    "models2/keep.stl",
    "models2/part.step",
  ]);
  assert.equal(
    putCalls.find((call) => call.pathname === `models2/.part.step.${shortHash(stepModuleBody)}.js`).options.contentType,
    "text/javascript; charset=utf-8",
  );
  assert.equal(putCalls.find((call) => call.pathname === "models2/keep.stl").options.contentType, "model/stl");
  assert.equal(result.uploadedFiles, 3);
  assert.equal(result.catalogEntries, 2);
  assert.equal(result.rootDir, "");
  assert.equal(result.rootPath, path.join(repoRoot, "models"));

  const catalogUpload = putCalls.find((call) => call.pathname === "models2/catalog.json");
  assert.equal(catalogUpload.options.cacheControlMaxAge, 60);
  assert.equal(putCalls.find((call) => call.pathname === "models2/keep.stl").options.cacheControlMaxAge, undefined);
  const uploadedCatalog = JSON.parse(catalogUpload.body);
  assert.deepEqual(uploadedCatalog.entries.map((entry) => entry.file), ["keep.stl", "part.step"]);
  assert.equal(uploadedCatalog.entries[0].url, "https://blob.test/models2/keep.stl");
  assert.equal(uploadedCatalog.entries[1].step.url, "https://blob.test/models2/part.step");
  assert.equal(
    uploadedCatalog.entries[1].moduleUrl,
    `https://blob.test/models2/.part.step.${shortHash(stepModuleBody)}.js`
  );
  assert.deepEqual(result.ignoredPatterns.slice(0, DEFAULT_UPLOAD_EXCLUDE_PATTERNS.length), DEFAULT_UPLOAD_EXCLUDE_PATTERNS);
});

test("uploadCatalogDirectoryToVercelBlob skips assets already present in the remote catalog", async () => {
  const repoRoot = makeTempRepo();
  const existingContent = "solid existing\nendsolid existing\n";
  const existingHash = fullHash(existingContent);
  const existingBytes = Buffer.byteLength(existingContent);
  writeFile(path.join(repoRoot, "models/existing.stl"), gitLfsPointer({
    oid: existingHash,
    size: existingBytes,
  }));
  writeFile(path.join(repoRoot, "models/new.stl"), "solid new\nendsolid new\n");
  const remoteCatalog = {
    schemaVersion: 4,
    entries: [{
      file: "existing.stl",
      kind: "mesh",
      url: "https://blob.test/models2/existing.stl",
      hash: existingHash,
      bytes: existingBytes,
    }],
  };
  const putCalls = [];
  const getCalls = [];

  const result = await uploadCatalogDirectoryToVercelBlob({
    directory: "models",
    skipExisting: true,
    env: {
      VIEWER_ASSET_BACKEND: "vercel-blob",
      VIEWER_VERCEL_BLOB_PREFIX: "models2",
      VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN: "test-token",
    },
    cwd: repoRoot,
    client: {
      get: async (pathname, options) => {
        getCalls.push({ pathname, options });
        return {
          stream: new Response(JSON.stringify(remoteCatalog)).body,
        };
      },
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    logger: { log() {} },
  });

  assert.deepEqual(getCalls, [{
    pathname: "models2/catalog.json",
    options: {
      access: "public",
      token: "test-token",
    },
  }]);
  assert.deepEqual(putCalls.map((call) => call.pathname).sort(), [
    "models2/catalog.json",
    "models2/new.stl",
  ]);
  assert.equal(result.uploadedFiles, 1);
  assert.equal(result.skippedFiles, 1);

  const uploadedCatalog = JSON.parse(putCalls.find((call) => call.pathname === "models2/catalog.json").body);
  assert.equal(putCalls.find((call) => call.pathname === "models2/catalog.json").options.cacheControlMaxAge, 60);
  const existingEntry = uploadedCatalog.entries.find((entry) => entry.file === "existing.stl");
  assert.equal(existingEntry.url, "https://blob.test/models2/existing.stl");
  assert.equal(existingEntry.hash, existingHash);
  assert.equal(existingEntry.bytes, existingBytes);
});

test("uploadCatalogDirectoryToVercelBlob rejects missing Git LFS pointers without explicit fetching", async () => {
  const repoRoot = makeTempRepo();
  writeFile(path.join(repoRoot, "models/missing.stl"), gitLfsPointer({
    oid: "a".repeat(64),
    size: 12345,
  }));

  await assert.rejects(
    () => uploadCatalogDirectoryToVercelBlob({
      directory: "models",
      env: {
        VIEWER_ASSET_BACKEND: "vercel-blob",
        VIEWER_VERCEL_BLOB_PREFIX: "models2",
        VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN: "test-token",
      },
      cwd: repoRoot,
      client: {
        put: async () => {
          throw new Error("LFS pointer should not be uploaded");
        },
      },
      logger: { log() {} },
    }),
    /missing\.stl is a Git LFS pointer/
  );
});

test("uploadCatalogDirectoryToVercelBlob honors positional directory from npm caller cwd", async () => {
  const repoRoot = makeTempRepo();
  writeFile(path.join(repoRoot, "models/keep.stl"), "solid keep\nendsolid keep\n");
  writeFile(path.join(repoRoot, "viewer/package.json"), "{}\n");
  const putCalls = [];

  const result = await uploadCatalogDirectoryToVercelBlob({
    directory: "models",
    env: {
      INIT_CWD: repoRoot,
      VIEWER_ASSET_BACKEND: "vercel-blob",
      VIEWER_VERCEL_BLOB_PREFIX: "models2",
      VIEWER_VERCEL_BLOB_READ_WRITE_TOKEN: "test-token",
    },
    cwd: path.join(repoRoot, "viewer"),
    client: {
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    logger: { log() {} },
  });

  assert.deepEqual(putCalls.map((call) => call.pathname).sort(), [
    "models2/catalog.json",
    "models2/keep.stl",
  ]);
  assert.equal(result.catalogEntries, 1);
  assert.equal(result.rootDir, "");
  assert.equal(result.rootPath, path.join(repoRoot, "models"));
});

test("carryForwardRemoteArtifactStatuses reuses remote status for unchanged LFS pointer artifacts", () => {
  const rootPath = makeTempRepo();
  const glbHash = fullHash("real glb bytes");
  writeFile(path.join(rootPath, ".part.step.glb"), gitLfsPointer({ oid: glbHash, size: 1234 }));
  writeFile(path.join(rootPath, ".real.step.glb"), "actual binary content");

  const pointerWarning = {
    ok: false,
    error: "missing_step_topology",
    glbPath: ".part.step.glb",
    message: "STEP topology validation requires readable STEP_topology indexView in the GLB: .part.step.glb.",
  };
  const realFileWarning = {
    ok: false,
    error: "missing_step_topology",
    glbPath: ".real.step.glb",
    message: "STEP topology validation requires readable STEP_topology indexView in the GLB: .real.step.glb.",
  };
  const catalog = {
    schemaVersion: 4,
    entries: [
      { file: "part.step", hash: glbHash, artifact: pointerWarning },
      { file: "real.step", hash: fullHash("actual binary content"), artifact: realFileWarning },
      { file: "changed.step", hash: "different-local-hash", artifact: { ...pointerWarning } },
    ],
  };
  const existingCatalog = {
    schemaVersion: 4,
    entries: [
      { file: "part.step", hash: glbHash },
      { file: "real.step", hash: fullHash("actual binary content") },
      { file: "changed.step", hash: "remote-hash" },
    ],
  };

  const result = carryForwardRemoteArtifactStatuses(catalog, { existingCatalog, rootPath });

  assert.equal(result.entries.find((entry) => entry.file === "part.step").artifact, undefined);
  assert.deepEqual(
    result.entries.find((entry) => entry.file === "real.step").artifact,
    realFileWarning,
  );
  assert.deepEqual(
    result.entries.find((entry) => entry.file === "changed.step").artifact,
    pointerWarning,
  );
});

test("carryForwardRemoteArtifactStatuses copies remote warnings instead of pointer-derived ones", () => {
  const rootPath = makeTempRepo();
  const glbHash = fullHash("glb with legit warning");
  writeFile(path.join(rootPath, ".warned.step.glb"), gitLfsPointer({ oid: glbHash, size: 99 }));

  const remoteWarning = {
    ok: false,
    error: "unsupported_step_topology",
    glbPath: ".warned.step.glb",
    message: "STEP topology validation requires STEP_topology schemaVersion 2 in the GLB.",
  };
  const result = carryForwardRemoteArtifactStatuses(
    {
      schemaVersion: 4,
      entries: [{
        file: "warned.step",
        hash: glbHash,
        artifact: {
          ok: false,
          error: "missing_step_topology",
          glbPath: ".warned.step.glb",
          message: "unreadable pointer",
        },
      }],
    },
    {
      existingCatalog: {
        schemaVersion: 4,
        entries: [{ file: "warned.step", hash: glbHash, artifact: remoteWarning }],
      },
      rootPath,
    },
  );

  assert.deepEqual(result.entries[0].artifact, remoteWarning);
});
