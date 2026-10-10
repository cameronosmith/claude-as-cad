import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const STATIC_CONTENT_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".wasm", "application/wasm"],
]);

export function contentTypeForStaticAsset(filePath) {
  return STATIC_CONTENT_TYPES.get(path.extname(String(filePath || "")).toLowerCase()) || "";
}

export function sendJson(res, statusCode, payload, { cacheControl = "no-store" } = {}) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", cacheControl || "no-store");
  res.end(JSON.stringify(payload));
}

function downloadFilename(value) {
  const rawFilename = path.basename(String(value || "").replace(/\\/g, "/")) || "download";
  return rawFilename.replace(/[\x00-\x1f"\\]/g, "_");
}

function encodeContentDispositionFilename(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => (
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  ));
}

function attachmentContentDisposition(filename) {
  const safeFilename = downloadFilename(filename);
  const quotedFilename = safeFilename.replace(/[^\x20-\x7e]/g, "_");
  return `attachment; filename="${quotedFilename}"; filename*=UTF-8''${encodeContentDispositionFilename(safeFilename)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requestRootDir(requestUrl) {
  return String(requestUrl?.searchParams?.get("dir") || "").trim();
}

function requestFileRef(requestUrl) {
  return String(requestUrl?.searchParams?.get("file") || "").trim();
}

function requestHeader(req, name) {
  const headers = req?.headers || {};
  const value = headers[String(name || "").toLowerCase()];
  return Array.isArray(value) ? value[0] : String(value || "");
}

function requestRefererUrl(req) {
  const value = requestHeader(req, "referer") || requestHeader(req, "referrer");
  if (!value) {
    return null;
  }
  try {
    return new URL(value, "http://localhost");
  } catch {
    return null;
  }
}

function siblingFileRef(sourceFileRef, relativeFileRef) {
  const source = String(sourceFileRef || "").replace(/\\/g, "/");
  const relative = String(relativeFileRef || "").replace(/\\/g, "/").replace(/^\/+/g, "");
  if (!source || !relative) {
    return "";
  }
  if (path.isAbsolute(source)) {
    return path.resolve(path.dirname(source), relative);
  }
  const sourceDir = path.posix.dirname(source);
  return path.posix.normalize(path.posix.join(sourceDir === "." ? "" : sourceDir, relative));
}

function legacyCadAssetFileRef(requestUrl, req) {
  if (!requestUrl.pathname.startsWith("/__cad/") || requestUrl.pathname === "/__cad/asset") {
    return "";
  }
  const relativePath = decodeURIComponent(requestUrl.pathname.slice("/__cad/".length));
  if (!relativePath || !path.extname(relativePath)) {
    return "";
  }
  const refererUrl = requestRefererUrl(req);
  return siblingFileRef(requestFileRef(refererUrl), relativePath);
}

function readJsonBody(req, { limitBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding?.("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > limitBytes) {
        reject(new Error("Request body is too large"));
        req.destroy?.();
      }
    });
    req.on("error", reject);
    req.on("end", () => {
      const text = body.trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
  });
}

function fileAssetRequest(backend, requestUrl, {
  rootDir,
  catalog,
} = {}) {
  const fileRef = requestFileRef(requestUrl);
  const request = {
    fileRef,
    asset: requestUrl.searchParams.get("asset") || "output",
    rootDir,
    catalog,
  };
  if (typeof backend.resolveRequestRoot === "function") {
    request.resolvedRoot = backend.resolveRequestRoot({ rootDir, fileRef });
  } else if (typeof backend.resolveRoot === "function" && rootDir) {
    request.resolvedRoot = backend.resolveRoot(rootDir);
  }
  return request;
}

function sendBufferDownload(res, {
  body,
  filename,
  contentType,
} = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || "");
  res.statusCode = 200;
  res.setHeader("content-type", contentType || "application/octet-stream");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", attachmentContentDisposition(filename));
  res.setHeader("content-length", String(bytes.length));
  res.end(bytes);
}

export function serveStaticFile(filePath, req, res, next, { contentType, headers = {} } = {}) {
  fs.stat(filePath, (error, stats) => {
    if (res.destroyed) {
      return;
    }
    if (error || !stats.isFile()) {
      next();
      return;
    }
    if (contentType) {
      res.setHeader("content-type", contentType);
    }
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined && value !== null && value !== "") {
        res.setHeader(name, value);
      }
    }
    const etag = `"${stats.size.toString(36)}-${Math.round(Number(stats.mtimeMs) || 0).toString(36)}"`;
    res.setHeader("etag", etag);
    res.setHeader("cache-control", "no-cache");
    if (req.headers?.["if-none-match"] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const incompressible = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".glb", ".zip", ".gz", ".woff2", ".mp4"]);
    const acceptsGzip = /\bgzip\b/.test(String(req.headers?.["accept-encoding"] || ""));
    const useGzip = acceptsGzip && stats.size >= 1024 && !incompressible.has(ext);

    const stream = fs.createReadStream(filePath);
    res.on("close", () => {
      if (!res.writableEnded) {
        stream.destroy();
      }
    });
    stream.on("error", () => {
      if (!res.headersSent) {
        next();
      } else {
        res.destroy();
      }
    });

    if (useGzip) {
      res.setHeader("content-encoding", "gzip");
      res.setHeader("vary", "accept-encoding");
      const gzip = zlib.createGzip({ level: 6 });
      gzip.on("error", () => {
        res.destroy();
      });
      stream.pipe(gzip).pipe(res);
    } else {
      res.setHeader("content-length", String(stats.size));
      stream.pipe(res);
    }
  });
}

export function createCadViewerApiMiddleware({
  backend,
  serverInfo = () => ({}),
  enableStepArtifactBackend = false,
  claimDisabledStepArtifactRoute = false,
  preferFileDownloadRedirects = false,
  onCatalogChanged = () => {},
  onCatalogActivated = () => {},
  onDirectoryActivated = () => {},
  rootDir,
  catalogCacheControl = "",
} = {}) {
  if (!backend) {
    throw new Error("createCadViewerApiMiddleware requires backend");
  }
  return async function cadViewerApiMiddleware(req, res, next) {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const activeRootDir = requestRootDir(requestUrl) || rootDir || "";
    const activeFileRef = requestFileRef(requestUrl);
    if (requestUrl.pathname === "/__cad/server") {
      sendJson(res, 200, serverInfo({ rootDir: activeRootDir, fileRef: activeFileRef }));
      return;
    }
    if (requestUrl.pathname === "/__cad/directory/activate") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, {
          error: "Use POST to activate a CAD Viewer directory",
        });
        return;
      }
      if (typeof backend.resolveRequestRoot !== "function" && typeof backend.resolveRoot !== "function") {
        sendJson(res, 501, {
          error: "Directory activation requires a local filesystem CAD Viewer backend",
        });
        return;
      }
      try {
        const resolvedRoot = typeof backend.resolveRequestRoot === "function"
          ? backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef })
          : backend.resolveRoot(activeRootDir);
        onDirectoryActivated(resolvedRoot, { rootDir: activeRootDir, fileRef: activeFileRef });
        sendJson(res, 200, {
          ok: true,
          directory: {
            dir: String(resolvedRoot?.dir || activeRootDir || ""),
            rootPath: String(resolvedRoot?.rootPath || ""),
            rootName: String(resolvedRoot?.rootName || ""),
          },
          server: serverInfo({ rootDir: String(resolvedRoot?.dir || activeRootDir || ""), fileRef: activeFileRef }),
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/catalog") {
      try {
        const catalog = await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef });
        if (typeof backend.resolveRequestRoot === "function" && (activeRootDir || activeFileRef)) {
          onCatalogActivated(
            backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef }),
            { rootDir: activeRootDir, fileRef: activeFileRef },
          );
        } else if (activeRootDir && typeof backend.resolveRoot === "function") {
          onCatalogActivated(backend.resolveRoot(activeRootDir), { rootDir: activeRootDir, fileRef: activeFileRef });
        }
        sendJson(res, 200, catalog, { cacheControl: catalogCacheControl });
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/generation-status") {
      if (typeof backend.readGenerationStatus !== "function") {
        sendJson(res, 501, {
          error: "Generation status is not available for this CAD Viewer backend",
        });
        return;
      }
      try {
        sendJson(res, 200, await backend.readGenerationStatus({ rootDir: activeRootDir }));
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/download") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "Use GET to download a file asset",
        });
        return;
      }

      try {
        const catalog = await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef });
        const request = fileAssetRequest(backend, requestUrl, { rootDir: activeRootDir, catalog });

        if (preferFileDownloadRedirects && typeof backend.resolveFileAssetAccess === "function") {
          const access = await backend.resolveFileAssetAccess(request);
          if (access?.url) {
            res.statusCode = 302;
            res.setHeader("location", access.url);
            res.setHeader("cache-control", "no-store");
            res.end("");
            return;
          }
        }

        if (typeof backend.readFileAsset === "function") {
          const result = await backend.readFileAsset(request);
          sendBufferDownload(res, result);
          return;
        }

        if (typeof backend.resolveFileAssetAccess !== "function") {
          sendJson(res, 501, {
            error: "File downloads are not available for this CAD Viewer backend",
          });
          return;
        }

        const access = await backend.resolveFileAssetAccess(request);
        if (access?.path) {
          serveStaticFile(access.path, req, res, () => {
            sendJson(res, 404, {
              error: "File asset not found",
            });
          }, {
            contentType: access.contentType || backend.contentTypeForPath?.(access.path) || "application/octet-stream",
            headers: {
              "content-disposition": attachmentContentDisposition(access.filename || access.file || access.path),
            },
          });
          return;
        }
        if (access?.url) {
          res.statusCode = 302;
          res.setHeader("location", access.url);
          res.setHeader("cache-control", "no-store");
          res.end("");
          return;
        }
        sendJson(res, 404, {
          error: "File asset not found",
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/editor-log") {
      // cad_editor: append a REFERENCE-ONLY edit record to the edit log. Never writes
      // next to (or into) the CAD — records live in ~/cad_editor_edits for a cad agent to read.
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, { ok: false, error: "Use POST to log editor edits" });
        return;
      }
      // Safe default: only accept edit-log writes from this machine. Set
      // CAD_EDITOR_LOG_ALLOW_REMOTE=1 to accept them from other hosts (e.g. on a private network).
      const remoteAddress = String(req.socket?.remoteAddress || "");
      const fromLoopback = remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
      if (!fromLoopback && process.env.CAD_EDITOR_LOG_ALLOW_REMOTE !== "1") {
        sendJson(res, 403, {
          ok: false,
          error: "Edit logging only accepts requests from this machine. Set CAD_EDITOR_LOG_ALLOW_REMOTE=1 to allow remote clients."
        });
        return;
      }
      try {
        if (typeof backend.assetPathForFileRef !== "function") {
          sendJson(res, 501, { ok: false, error: "Editor edit logging is not available for this backend" });
          return;
        }
        const modelPath = backend.assetPathForFileRef(activeFileRef, {
          rootDir: activeRootDir,
          ...(typeof backend.resolveRequestRoot === "function" && (activeRootDir || activeFileRef)
            ? { resolvedRoot: backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef }) }
            : {}),
        });
        const extension = modelPath ? path.extname(modelPath).toLowerCase() : "";
        if (!modelPath || ![".urdf", ".sdf"].includes(extension) || !fs.existsSync(modelPath)) {
          sendJson(res, 404, { ok: false, error: "Edit logging needs an existing .urdf/.sdf model file" });
          return;
        }
        const body = await readJsonBody(req, { limitBytes: 4 * 1024 * 1024 });
        if (!body || typeof body !== "object" || !String(body.format || "").startsWith("cad_editor.")) {
          sendJson(res, 400, { ok: false, error: "Body must be a cad_editor JSON object" });
          return;
        }
        const editsDir = process.env.CAD_EDITOR_EDITS_DIR || path.join(os.homedir(), "cad_editor_edits");
        fs.mkdirSync(editsDir, { recursive: true });
        const now = new Date();
        const pad = (value) => String(value).padStart(2, "0");
        const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        const stem = path.basename(modelPath, extension).replace(/[^A-Za-z0-9_.-]+/g, "_");
        const record = { ...body, logged_at: now.toISOString(), model_path: modelPath };
        let recordPath = "";
        for (let attempt = 0; attempt < 20 && !recordPath; attempt += 1) {
          const candidate = path.join(
            editsDir,
            `${stem}__${day.replace(/-/g, "")}-${clock.replace(/:/g, "")}${attempt ? `-${attempt + 1}` : ""}.json`
          );
          try {
            fs.writeFileSync(candidate, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
            recordPath = candidate;
          } catch (writeError) {
            if (writeError?.code !== "EEXIST") {
              throw writeError;
            }
          }
        }
        if (!recordPath) {
          throw new Error("Could not allocate an edit record file");
        }
        const logPath = path.join(editsDir, "EDIT_LOG.md");
        if (!fs.existsSync(logPath)) {
          fs.writeFileSync(logPath, [
            "# cad_editor edit log",
            "",
            "Reference-only edit proposals made in the claude-as-cad in-browser editor.",
            "These are NOT applied to the CAD — your agent (e.g. Claude Code) reads an entry and decides how to realize it.",
            "Each entry links a JSON record with exact data:",
            "- `parts[].stl_delta`: row-major 4x4 in the STL's own frame (mm): new_vertex = stl_delta * old_vertex",
            "- `parts[].deleted: true`: Cameron removed this part from the view (reference only)",
            "- `cubes[].link_local`: row-major 4x4 in the parent link frame (m) for a 1 m unit cube centred at its origin; size is in the scale",
            "- readable fields (`location_mm`, `rotation_deg` = URDF rpy order, `scale`, `size_mm`) are in the frame named by `frame`, at `joints_at_save`",
            "",
            "Newest at the bottom.",
            ""
          ].join("\n"));
        }
        const summary = String(body.summary_text || "").trim() || "(no summary)";
        fs.appendFileSync(logPath, [
          "",
          `## ${day} ${clock} — ${path.basename(modelPath)}`,
          `- model: \`${modelPath}\``,
          `- record: \`${recordPath}\``,
          "",
          "```",
          summary,
          "```",
          ""
        ].join("\n"));
        sendJson(res, 200, { ok: true, path: recordPath, logPath });
      } catch (error) {
        if (Number(error?.statusCode) === 403) {
          sendJson(res, 403, { ok: false, error: "Forbidden" });
          return;
        }
        sendJson(res, 400, { ok: false, error: errorMessage(error) });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/asset") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "GET") {
        res.setHeader("allow", "GET");
        sendJson(res, 405, {
          error: "Use GET to read a CAD Viewer asset",
        });
        return;
      }
      try {
        if (typeof backend.assetPathForFileRef !== "function") {
          sendJson(res, 501, {
            error: "Direct CAD Viewer assets are not available for this backend",
          });
          return;
        }
        const assetPath = backend.assetPathForFileRef(activeFileRef, {
          rootDir: activeRootDir,
          ...(typeof backend.resolveRequestRoot === "function" && (activeRootDir || activeFileRef)
            ? { resolvedRoot: backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef }) }
            : {}),
        });
        if (!assetPath) {
          sendJson(res, 404, {
            error: "CAD Viewer asset not found",
          });
          return;
        }
        serveStaticFile(assetPath, req, res, () => {
          sendJson(res, 404, {
            error: "CAD Viewer asset not found",
          });
        }, {
          contentType: backend.contentTypeForPath?.(assetPath) || "application/octet-stream",
        });
      } catch (error) {
        if (Number(error?.statusCode) === 403) {
          sendJson(res, 403, {
            error: "Forbidden",
          });
          return;
        }
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/reveal") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, {
          error: "Use POST to reveal a file asset",
        });
        return;
      }

      try {
        if (typeof backend.openFileAsset !== "function") {
          sendJson(res, 405, {
            error: "Revealing files is only available for the local filesystem backend",
          });
          return;
        }
        const catalog = await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef });
        const request = fileAssetRequest(backend, requestUrl, { rootDir: activeRootDir, catalog });
        const result = await backend.openFileAsset(request);
        sendJson(res, 200, {
          ok: true,
          ...result,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/implicit-export") {
      const method = String(req.method || "GET").toUpperCase();
      if (method !== "POST") {
        res.setHeader("allow", "POST");
        sendJson(res, 405, {
          error: "Use POST to export implicit CAD files",
        });
        return;
      }
      if (
        backend.kind !== "local-fs" ||
        typeof backend.generateImplicitExport !== "function" ||
        typeof backend.resolveRoot !== "function"
      ) {
        sendJson(res, 405, {
          error: "Implicit CAD export is only available for the local filesystem backend",
        });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const catalog = await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef });
        const resolvedRoot = typeof backend.resolveRequestRoot === "function"
          ? backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef })
          : backend.resolveRoot(activeRootDir);
        const format = requestUrl.searchParams.get("format") || body.format || "glb";
        const result = await backend.generateImplicitExport({
          fileRef: activeFileRef || body.file,
          format,
          parameterValues: body.parameterValues || body.params || null,
          animationState: body.animationState || body.implicitAnimationState || null,
          resolution: body.resolution,
          maxCells: body.maxCells,
          resolvedRoot,
          rootDir: activeRootDir,
          catalog,
        });
        onCatalogChanged(resolvedRoot);
        sendJson(res, 200, {
          ok: true,
          result,
          entry: result.entry || null,
          catalog: result.catalog || (
            typeof backend.refreshCatalog === "function"
              ? await backend.refreshCatalog({ rootDir: activeRootDir, fileRef: activeFileRef })
              : await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef })
          ),
          downloadUrl: `/__cad/download?dir=${encodeURIComponent(activeRootDir)}&file=${encodeURIComponent(result.outputFileRef)}&asset=output`,
          filename: result.filename,
        });
      } catch (error) {
        sendJson(res, 400, {
          ok: false,
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/step-source-status") {
      if (typeof backend.readStepSourceStatus !== "function") {
        sendJson(res, 501, {
          error: "STEP source status is not available for this CAD Viewer backend",
        });
        return;
      }
      try {
        const catalog = await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef });
        const request = {
          fileRef: activeFileRef,
          rootDir: activeRootDir,
          catalog,
        };
        if (typeof backend.resolveRequestRoot === "function") {
          request.resolvedRoot = backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef });
        } else if (typeof backend.resolveRoot === "function" && activeRootDir) {
          request.resolvedRoot = backend.resolveRoot(activeRootDir);
        }
        sendJson(res, 200, await backend.readStepSourceStatus(request));
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    if (requestUrl.pathname === "/__cad/step-artifact") {
      if (!enableStepArtifactBackend) {
        if (claimDisabledStepArtifactRoute) {
          sendJson(res, 501, {
            error: "STEP artifact generation is not enabled for this CAD Viewer backend",
          });
          return;
        }
        next();
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, {
          error: "Use POST to generate a STEP artifact",
        });
        return;
      }
      if (typeof backend.resolveRoot !== "function") {
        sendJson(res, 501, {
          error: "STEP artifact generation requires a local filesystem CAD Viewer backend",
        });
        return;
      }
      try {
        const catalog = await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef });
        const resolvedRoot = typeof backend.resolveRequestRoot === "function"
          ? backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef })
          : backend.resolveRoot(activeRootDir);
        const result = await backend.generateStepArtifact({
          fileRef: activeFileRef,
          force: requestUrl.searchParams.get("force") === "1",
          resolvedRoot,
          catalog,
        });
        const nextCatalog = typeof backend.refreshCatalog === "function"
          ? await backend.refreshCatalog({ rootDir: activeRootDir, fileRef: activeFileRef })
          : await backend.readCatalog({ rootDir: activeRootDir, fileRef: activeFileRef });
        onCatalogChanged(resolvedRoot);
        sendJson(res, result.ok ? 200 : 500, {
          ok: result.ok,
          error: result.error,
          result: result.result,
          entry: backend.entryForSourcePath(nextCatalog, resolvedRoot, result.stepPath),
          catalog: nextCatalog,
        });
      } catch (error) {
        sendJson(res, 400, {
          error: errorMessage(error),
        });
      }
      return;
    }
    next();
  };
}

export function createLocalAssetMiddleware({ backend, rootDir } = {}) {
  if (!backend) {
    throw new Error("createLocalAssetMiddleware requires backend");
  }
  return function localAssetMiddleware(req, res, next) {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const fallbackFileRef = legacyCadAssetFileRef(requestUrl, req);
    if (
      (requestUrl.pathname !== "/__cad/asset" && !fallbackFileRef) ||
      typeof backend.assetPathForFileRef !== "function"
    ) {
      next();
      return;
    }
    let assetPath = null;
    try {
      const refererUrl = requestRefererUrl(req);
      const activeRootDir = requestRootDir(requestUrl) || requestRootDir(refererUrl) || rootDir || "";
      const activeFileRef = requestFileRef(requestUrl) || fallbackFileRef;
      assetPath = backend.assetPathForFileRef(activeFileRef, {
        rootDir: activeRootDir,
        ...(typeof backend.resolveRequestRoot === "function" && (activeRootDir || activeFileRef)
          ? { resolvedRoot: backend.resolveRequestRoot({ rootDir: activeRootDir, fileRef: activeFileRef }) }
          : {}),
      });
    } catch (error) {
      if (Number(error?.statusCode) === 403) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      next();
      return;
    }
    if (!assetPath) {
      next();
      return;
    }
    serveStaticFile(assetPath, req, res, next, {
      contentType: backend.contentTypeForPath?.(assetPath) || undefined,
    });
  };
}

export function serveDistAsset({ distRoot, indexHtmlPath = path.join(distRoot, "index.html") } = {}) {
  return function distAssetMiddleware(req, res, next) {
    const requestUrl = new URL(req.url || "/", "http://localhost");
    const requestPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
    let filePath = "";
    try {
      filePath = path.resolve(distRoot, decodeURIComponent(requestPath).replace(/^\/+/, ""));
    } catch {
      res.statusCode = 400;
      res.end("Bad request");
      return;
    }
    if (!(filePath === distRoot || filePath.startsWith(`${distRoot}${path.sep}`))) {
      res.statusCode = 403;
      res.end("Forbidden");
      return;
    }
    const fileExists = fs.existsSync(filePath);
    const isStaticAssetRequest = requestPath.startsWith("/assets/") || path.extname(requestPath);
    if (!fileExists && isStaticAssetRequest) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end("Not found");
      return;
    }
    const fallbackPath = fileExists ? filePath : indexHtmlPath;
    serveStaticFile(fallbackPath, req, res, next, {
      contentType: contentTypeForStaticAsset(fallbackPath) || undefined,
    });
  };
}
