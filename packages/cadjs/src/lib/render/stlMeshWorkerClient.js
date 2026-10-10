let workers = null;
let roundRobin = 0;
let nextRequestId = 1;
const pendingRequests = new Map();
const requestWorker = new Map();

function poolSize() {
  const hc = (typeof navigator !== "undefined" && Number(navigator.hardwareConcurrency)) || 4;
  return Math.max(2, Math.min(8, Math.floor(hc) - 1));
}

function makeAbortError() {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function stlWorkerSupported() {
  return typeof Worker === "function" && typeof URL === "function";
}

function settleWorkerRequest(message) {
  const request = pendingRequests.get(message.id);
  if (!request) {
    return;
  }
  pendingRequests.delete(message.id);
  requestWorker.delete(message.id);
  request.cleanup();
  if (message.ok) {
    request.resolve(message.meshData);
    return;
  }
  const error = new Error(message.error?.message || "Failed to load STL mesh in worker.");
  error.name = message.error?.name || "Error";
  request.reject(error);
}

function makeWorker() {
  const worker = new Worker(new URL("./stlMeshWorker.js", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event) => {
    settleWorkerRequest(event.data || {});
  });
  worker.addEventListener("error", (event) => {
    const error = new Error(event?.message || "STL mesh worker failed.");
    for (const [id, assigned] of [...requestWorker.entries()]) {
      if (assigned !== worker) {
        continue;
      }
      const request = pendingRequests.get(id);
      if (request) {
        pendingRequests.delete(id);
        request.cleanup();
        request.reject(error);
      }
      requestWorker.delete(id);
    }
    try {
      worker.terminate?.();
    } catch {
      // ignore
    }
    if (workers) {
      const index = workers.indexOf(worker);
      if (index >= 0) {
        workers.splice(index, 1);
      }
    }
  });
  return worker;
}

function ensurePool() {
  if (!stlWorkerSupported()) {
    return null;
  }
  if (!workers || workers.length === 0) {
    try {
      workers = Array.from({ length: poolSize() }, () => makeWorker());
    } catch {
      workers = null;
      return null;
    }
  }
  return workers;
}

export function loadStlMeshDataInWorker(url, { signal } = {}) {
  const pool = ensurePool();
  if (!pool || pool.length === 0) {
    return null;
  }
  if (signal?.aborted) {
    return Promise.reject(makeAbortError());
  }

  const worker = pool[roundRobin % pool.length];
  roundRobin += 1;

  const id = nextRequestId;
  nextRequestId += 1;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener?.("abort", abort);
    };
    const abort = () => {
      pendingRequests.delete(id);
      requestWorker.delete(id);
      cleanup();
      worker.postMessage({ type: "cancel", id });
      reject(makeAbortError());
    };
    pendingRequests.set(id, { resolve, reject, cleanup });
    requestWorker.set(id, worker);
    signal?.addEventListener?.("abort", abort, { once: true });
    worker.postMessage({ type: "loadStl", id, url });
  });
}
