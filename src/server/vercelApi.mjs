import { createCadViewerApiMiddleware, sendJson } from "./httpHandlers.mjs";
import { createVercelBlobAssetBackend } from "./vercelBlobAssetBackend.mjs";
import {
  envValue,
  normalizeViewerAssetBackend,
  vercelBlobConfigFromEnv,
  VIEWER_ASSET_BACKENDS,
} from "./viewerEnv.mjs";


function vercelUrlFromHost(value) {
  const rawValue = String(value || "").trim();
  if (!rawValue) {
    return "";
  }
  try {
    const url = new URL(rawValue.includes("://") ? rawValue : `https://${rawValue}`);
    const pathname = url.pathname.replace(/\/+$/g, "");
    return `${url.protocol}//${url.host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return "";
  }
}


export function hostedViewerPublicUrlFromEnv(env = process.env) {
  const candidates = [
    "VERCEL_PROJECT_PRODUCTION_URL",
    "VERCEL_URL",
    "VERCEL_BRANCH_URL",
  ];
  for (const name of candidates) {
    const url = vercelUrlFromHost(envValue(env, name));
    if (url) {
      return url;
    }
  }
  return "";
}


// Hosted catalog reads are cached in-function and at the CDN so steady client
// polling does not hammer the public Blob endpoint; sustained per-request Blob
// fetches from shared serverless egress IPs trip Vercel's abuse mitigation
// with intermittent 403s.
export const HOSTED_CATALOG_CACHE_TTL_MS = 60_000;
export const HOSTED_CATALOG_CACHE_CONTROL =
  "public, max-age=0, s-maxage=60, stale-while-revalidate=600, stale-if-error=86400";

let sharedHostedBackend = null;

export function createHostedCadBackendFromEnv(env = process.env) {
  const assetBackend = normalizeViewerAssetBackend(
    envValue(env, "VIEWER_ASSET_BACKEND"),
    VIEWER_ASSET_BACKENDS.VERCEL_BLOB
  );
  if (assetBackend !== VIEWER_ASSET_BACKENDS.VERCEL_BLOB) {
    throw new Error("Hosted CAD API requires VIEWER_ASSET_BACKEND=vercel-blob");
  }
  return createVercelBlobAssetBackend({
    ...vercelBlobConfigFromEnv(env),
    readOnly: true,
    catalogCacheTtlMs: HOSTED_CATALOG_CACHE_TTL_MS,
  });
}

function sharedHostedCadBackendFromEnv() {
  if (!sharedHostedBackend) {
    sharedHostedBackend = createHostedCadBackendFromEnv();
  }
  return sharedHostedBackend;
}


export function buildHostedViewerServerInfo({
  backend,
  env = process.env,
  rootDir = "",
} = {}) {
  return {
    schemaVersion: 1,
    app: "cad-viewer",
    backend: backend?.kind || "vercel-blob",
    rootDir,
    catalogPath: backend?.catalogPath || vercelBlobConfigFromEnv(env).catalogPath,
    stepArtifactGenerationAvailable: false,
    url: hostedViewerPublicUrlFromEnv(env),
  };
}


export async function handleHostedCadApi(req, res, {
  cadPath,
  backend = sharedHostedCadBackendFromEnv(),
  env = process.env,
} = {}) {
  const normalizedCadPath = String(cadPath || "").trim();
  if (!normalizedCadPath.startsWith("/__cad/")) {
    sendJson(res, 500, { error: `Invalid CAD API path: ${normalizedCadPath || "(missing)"}` });
    return;
  }

  const originalUrl = req.url || "/";
  const originalRequestUrl = new URL(originalUrl, "http://localhost");
  originalRequestUrl.searchParams.delete("dir");
  req.url = `${normalizedCadPath}${originalRequestUrl.search}`;
  try {
    const middleware = createCadViewerApiMiddleware({
      backend,
      rootDir: "",
      enableStepArtifactBackend: false,
      claimDisabledStepArtifactRoute: true,
      preferFileDownloadRedirects: true,
      catalogCacheControl: HOSTED_CATALOG_CACHE_CONTROL,
      serverInfo: () => buildHostedViewerServerInfo({ backend, env, rootDir: "" }),
    });
    await middleware(req, res, () => {
      sendJson(res, 404, { error: "CAD API route not found" });
    });
  } finally {
    req.url = originalUrl;
  }
}
