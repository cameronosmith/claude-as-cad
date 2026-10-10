import assert from "node:assert/strict";
import test from "node:test";

import {
  contentTypeForFileRef,
  createVercelBlobAssetBackend,
  normalizeVercelBlobCatalog,
} from "./vercelBlobAssetBackend.mjs";

test("Vercel Blob backend uses browser-safe MIME types for served modules", () => {
  assert.equal(contentTypeForFileRef("models/.part.step.js"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForFileRef("models/.part.step.mjs"), "text/javascript; charset=utf-8");
  assert.equal(contentTypeForFileRef("models/catalog.json"), "application/json; charset=utf-8");
});

test("Vercel Blob backend reports public catalog URL failures instead of falling back to the SDK", async () => {
  const getCalls = [];
  const fetchCalls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    client: {
      get: async (pathname, options) => {
        getCalls.push({ pathname, options });
        return {
          statusCode: 200,
          stream: new Response(JSON.stringify({
            schemaVersion: 4,
            entries: [{ file: "parts/bracket.step" }],
          })).body,
          blob: { pathname },
        };
      },
    },
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return {
        ok: false,
        status: 403,
        statusText: "Forbidden",
      };
    },
    token: "test-token",
  });

  await assert.rejects(
    () => backend.readCatalog(),
    /Failed to read Vercel Blob catalog: 403 Forbidden/
  );
  assert.deepEqual(fetchCalls, ["https://blob.test/demo/catalog.json?_tcad_catalog=1"]);
  assert.deepEqual(getCalls, []);
});

test("Vercel Blob backend can use the Blob SDK when no public catalog URL is configured", async () => {
  const getCalls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    client: {
      get: async (pathname, options) => {
        getCalls.push({ pathname, options });
        return {
          statusCode: 200,
          stream: new Response(JSON.stringify({
            schemaVersion: 4,
            entries: [{ file: "parts/bracket.step" }],
          })).body,
          blob: { pathname },
        };
      },
    },
    token: "test-token",
  });

  assert.deepEqual(await backend.readCatalog(), {
    schemaVersion: 4,
    entries: [{ file: "parts/bracket.step" }],
  });
  assert.deepEqual(getCalls, [{
    pathname: "demo/catalog.json",
    options: {
      access: "public",
      token: "test-token",
    },
  }]);
});

test("Vercel Blob backend prefers public catalog URLs when available", async () => {
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    client: {
      get: async () => {
        throw new Error("authenticated Blob SDK should not be used when public catalog reads work");
      },
    },
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ schemaVersion: 4, url }),
    }),
    token: "test-token",
  });

  assert.deepEqual(await backend.readCatalog(), {
    schemaVersion: 4,
    url: "https://blob.test/demo/catalog.json?_tcad_catalog=1",
  });
});

test("Vercel Blob backend suppresses Python source-path artifact warnings", async () => {
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "parts/bracket.step",
        kind: "part",
        sourceKind: "python",
        artifact: {
          ok: false,
          error: "missing_source_path",
          sourceKind: "python",
          stepPath: "parts/bracket.step",
          glbPath: "parts/.bracket.step.glb",
          message: "GLB STEP_topology is missing required sourcePath identity: parts/.bracket.step.glb.",
        },
      },
      {
        file: "parts/imported.step",
        kind: "part",
        sourceKind: "step",
        artifact: {
          ok: false,
          error: "missing_source_path",
          sourceKind: "step",
        },
      },
      {
        file: "parts/edge.step",
        kind: "part",
        sourceKind: "python",
        artifact: {
          ok: false,
          error: "missing_edge_topology",
          sourceKind: "python",
        },
      },
    ],
  };
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    fetchImpl: async () => ({
      ok: true,
      json: async () => catalog,
    }),
  });

  assert.equal(normalizeVercelBlobCatalog(catalog).entries[0].artifact, undefined);
  assert.equal((await backend.readCatalog()).entries[0].artifact, undefined);
  assert.equal((await backend.readCatalog()).entries[1].artifact.error, "missing_source_path");
  assert.equal((await backend.readCatalog()).entries[2].artifact.error, "missing_edge_topology");
});

test("Vercel Blob backend reads catalog and writes deterministic asset paths", async () => {
  const putCalls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/catalog.json",
    client: {
      put: async (pathname, body, options) => {
        putCalls.push({ pathname, body, options });
        return { pathname, url: `https://blob.test/${pathname}` };
      },
    },
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ schemaVersion: 4, url }),
    }),
    token: "test-token",
  });

  assert.equal(backend.canGenerateStepArtifacts, false);
  assert.equal("generateStepArtifact" in backend, false);
  assert.deepEqual(await backend.readCatalog(), {
    schemaVersion: 4,
    url: "https://blob.test/catalog.json?_tcad_catalog=1",
  });
  const result = await backend.writeAsset({
    fileRef: "models/.part.step.glb",
    body: Buffer.from("glb"),
    contentType: "model/gltf-binary",
  });

  assert.equal(result.pathname, "demo/models/.part.step.glb");
  assert.equal(putCalls[0].pathname, "demo/models/.part.step.glb");
  assert.equal(putCalls[0].options.addRandomSuffix, false);
  assert.equal(putCalls[0].options.allowOverwrite, true);
  assert.equal(putCalls[0].options.access, "public");
});

test("Vercel Blob backend downloads STEP output files instead of generated GLB artifacts", async () => {
  const stepBytes = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        url: "https://blob.test/demo/benchmarks/.part.step.glb",
        hash: "glb-hash",
        bytes: 3,
      },
    ],
  };
  const listedPrefixes = [];
  const fetchedUrls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    client: {
      list: async ({ prefix }) => {
        listedPrefixes.push(prefix);
        return {
          blobs: prefix === "demo/benchmarks/part.step"
            ? [{ pathname: prefix, url: "https://blob.test/demo/benchmarks/part.step" }]
            : [],
        };
      },
    },
    fetchImpl: async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        headers: {
          get: () => "application/step",
        },
        arrayBuffer: async () => stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength),
      };
    },
    token: "test-token",
  });

  const access = await backend.resolveFileAssetAccess({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });
  const download = await backend.readFileAsset({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });

  assert.equal(access.asset, "output");
  assert.equal(access.url, "https://blob.test/demo/benchmarks/part.step");
  assert.equal(access.filename, "part.step");
  assert.deepEqual(listedPrefixes, [
    "demo/benchmarks/part.step",
    "demo/benchmarks/part.step",
  ]);
  assert.deepEqual(fetchedUrls, ["https://blob.test/demo/benchmarks/part.step"]);
  assert.equal(download.contentType, "application/step");
  assert.equal(download.body.toString("utf-8"), stepBytes.toString("utf-8"));
});

test("read-only Vercel Blob backend uses catalog URLs without listing blobs", async () => {
  const stepBytes = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        url: "https://blob.test/demo/benchmarks/.part.step.glb",
        source: {
          file: "benchmarks/part.step",
          url: "https://blob.test/demo/benchmarks/part.step",
        },
      },
    ],
  };
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "demo",
    client: {
      list: async () => {
        throw new Error("read-only catalog URLs should avoid Blob listing");
      },
    },
    fetchImpl: async (url) => {
      assert.equal(url, "https://blob.test/demo/benchmarks/part.step");
      return {
        ok: true,
        headers: {
          get: () => "application/step",
        },
        arrayBuffer: async () => stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength),
      };
    },
  });

  const access = await backend.resolveFileAssetAccess({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });
  const status = await backend.readStepSourceStatus({
    fileRef: "benchmarks/part.step",
    catalog,
  });
  const download = await backend.readFileAsset({
    fileRef: "benchmarks/part.step",
    asset: "output",
    catalog,
  });

  assert.equal(access.url, "https://blob.test/demo/benchmarks/part.step");
  assert.equal(status.step.status, "current");
  assert.equal(download.body.toString("utf-8"), stepBytes.toString("utf-8"));
});

test("read-only Vercel Blob backend downloads cataloged GLB artifact files", async () => {
  const glbBytes = Buffer.from("glb");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        url: "https://blob.test/demo/benchmarks/.part.step.glb",
        source: {
          file: "benchmarks/part.step",
          url: "https://blob.test/demo/benchmarks/part.step",
        },
      },
    ],
  };
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "demo",
    client: {
      list: async () => {
        throw new Error("read-only catalog URLs should avoid Blob listing");
      },
    },
    fetchImpl: async (url) => {
      assert.equal(url, "https://blob.test/demo/benchmarks/.part.step.glb");
      return {
        ok: true,
        headers: {
          get: () => "model/gltf-binary",
        },
        arrayBuffer: async () => glbBytes.buffer.slice(glbBytes.byteOffset, glbBytes.byteOffset + glbBytes.byteLength),
      };
    },
  });

  const access = await backend.resolveFileAssetAccess({
    fileRef: "benchmarks/part.step",
    asset: "artifact",
    catalog,
  });
  const download = await backend.readFileAsset({
    fileRef: "benchmarks/part.step",
    asset: "artifact",
    catalog,
  });

  assert.equal(access.asset, "artifact");
  assert.equal(access.url, "https://blob.test/demo/benchmarks/.part.step.glb");
  assert.equal(access.filename, ".part.step.glb");
  assert.equal(download.contentType, "model/gltf-binary");
  assert.equal(download.body.toString("utf-8"), "glb");
});

test("Vercel Blob backend keeps STEP source URLs separate from Python source code URLs", async () => {
  const stepBytes = Buffer.from("ISO-10303-21;\nEND-ISO-10303-21;\n");
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "parts/bracket.step",
        kind: "part",
        sourceKind: "python",
        url: "https://blob.test/models2/parts/.bracket.step.glb",
        step: {
          file: "parts/bracket.step",
          url: "https://blob.test/models2/parts/bracket.step",
        },
        source: {
          file: "parts/bracket.py",
          url: "https://blob.test/models2/parts/bracket.py",
        },
      },
    ],
  };
  const fetchedUrls = [];
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "https://blob.test/models2",
    fetchImpl: async (url) => {
      fetchedUrls.push(url);
      return {
        ok: true,
        headers: {
          get: () => "application/step",
        },
        arrayBuffer: async () => stepBytes.buffer.slice(stepBytes.byteOffset, stepBytes.byteOffset + stepBytes.byteLength),
      };
    },
  });

  const output = await backend.readFileAsset({
    fileRef: "parts/bracket.step",
    asset: "output",
    catalog,
  });
  const status = await backend.readStepSourceStatus({
    fileRef: "parts/bracket.step",
    catalog,
  });

  await assert.rejects(
    () => backend.readFileAsset({
      fileRef: "parts/bracket.step",
      asset: "source",
      catalog,
    }),
    /Source code is not available in Vercel Blob deployments/
  );
  assert.equal(output.file, "parts/bracket.step");
  assert.equal(output.body.toString("utf-8"), stepBytes.toString("utf-8"));
  assert.equal(status.step.status, "current");
  assert.deepEqual(fetchedUrls, [
    "https://blob.test/models2/parts/bracket.step",
  ]);
});

test("Vercel Blob backend refuses explicitly cataloged source code assets", async () => {
  const catalog = {
    schemaVersion: 4,
    entries: [
      {
        file: "benchmarks/part.step",
        kind: "part",
        source: {
          file: "benchmarks/part.py",
        },
      },
    ],
  };
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    client: {
      list: async () => {
        throw new Error("source code should not be looked up in Vercel Blob");
      },
    },
    fetchImpl: async () => {
      throw new Error("source code should not be fetched from Vercel Blob");
    },
    token: "test-token",
  });

  await assert.rejects(
    () => backend.resolveFileAssetAccess({
      fileRef: "benchmarks/part.step",
      asset: "source",
      catalog,
    }),
    /Source code is not available in Vercel Blob deployments/
  );
  await assert.rejects(
    () => backend.readFileAsset({
      fileRef: "benchmarks/part.step",
      asset: "source",
      catalog,
    }),
    /Source code is not available in Vercel Blob deployments/
  );
});

test("Vercel Blob backend never exposes STEP artifact generation", async () => {
  const backend = createVercelBlobAssetBackend();

  assert.equal(backend.canGenerateStepArtifacts, false);
  assert.equal("generateStepArtifact" in backend, false);
});

test("Vercel Blob backend can be constructed read-only for hosted deployments", async () => {
  const backend = createVercelBlobAssetBackend({
    readOnly: true,
    prefix: "https://blob.test/models2",
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => ({ schemaVersion: 4, url }),
    }),
  });

  assert.equal(backend.readOnly, true);
  assert.equal(backend.canGenerateStepArtifacts, false);
  assert.equal("writeAsset" in backend, false);
  assert.equal("writeCatalog" in backend, false);
  assert.equal("generateStepArtifact" in backend, false);
  assert.equal(backend.prefix, "models2");
  assert.equal(backend.catalogPath, "models2/catalog.json");
  assert.deepEqual(await backend.readCatalog(), {
    schemaVersion: 4,
    url: "https://blob.test/models2/catalog.json?_tcad_catalog=1",
  });
});

test("Vercel Blob backend caches catalog reads inside the TTL", async () => {
  const fetchCalls = [];
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    catalogCacheTtlMs: 60_000,
    fetchImpl: async (url) => {
      fetchCalls.push(url);
      return {
        ok: true,
        json: async () => ({ schemaVersion: 4, entries: [{ file: "parts/bracket.step" }] }),
      };
    },
  });

  const first = await backend.readCatalog();
  const second = await backend.readCatalog();
  assert.deepEqual(first, { schemaVersion: 4, entries: [{ file: "parts/bracket.step" }] });
  assert.equal(second, first);
  assert.equal(fetchCalls.length, 1);
});

test("Vercel Blob backend shares one in-flight catalog fetch across concurrent reads", async () => {
  let fetchCount = 0;
  let releaseFetch;
  const fetchGate = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    catalogCacheTtlMs: 60_000,
    fetchImpl: async () => {
      fetchCount += 1;
      await fetchGate;
      return {
        ok: true,
        json: async () => ({ schemaVersion: 4, entries: [] }),
      };
    },
  });

  const reads = Promise.all([backend.readCatalog(), backend.readCatalog(), backend.readCatalog()]);
  releaseFetch();
  await reads;
  assert.equal(fetchCount, 1);
});

test("Vercel Blob backend serves the cached catalog when a refresh fails", async () => {
  let failFetches = false;
  let fetchCount = 0;
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    catalogCacheTtlMs: 1,
    fetchImpl: async () => {
      fetchCount += 1;
      if (failFetches) {
        return { ok: false, status: 403, statusText: "Forbidden" };
      }
      return {
        ok: true,
        json: async () => ({ schemaVersion: 4, entries: [{ file: "parts/bracket.step" }] }),
      };
    },
  });

  const fresh = await backend.readCatalog();
  failFetches = true;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stale = await backend.readCatalog();
  assert.equal(stale, fresh);
  assert.equal(fetchCount, 2);
});

test("Vercel Blob backend surfaces catalog failures when no cached catalog exists", async () => {
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    catalogCacheTtlMs: 60_000,
    fetchImpl: async () => ({ ok: false, status: 403, statusText: "Forbidden" }),
  });

  await assert.rejects(
    () => backend.readCatalog(),
    /Failed to read Vercel Blob catalog: 403 Forbidden/
  );
});

test("Vercel Blob backend refreshCatalog bypasses the catalog TTL cache", async () => {
  let fetchCount = 0;
  const backend = createVercelBlobAssetBackend({
    prefix: "demo",
    catalogUrl: "https://blob.test/demo/catalog.json",
    catalogCacheTtlMs: 60_000,
    fetchImpl: async () => {
      fetchCount += 1;
      return {
        ok: true,
        json: async () => ({ schemaVersion: 4, entries: [], fetchCount }),
      };
    },
  });

  await backend.readCatalog();
  const refreshed = await backend.refreshCatalog();
  assert.equal(refreshed.fetchCount, 2);
  assert.equal(fetchCount, 2);
  const cached = await backend.readCatalog();
  assert.equal(cached, refreshed);
  assert.equal(fetchCount, 2);
});
