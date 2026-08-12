import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  DEFAULT_MODAL_VALIDATION_URL,
  hasOnlyNonSecretConfiguration,
} from "../src/worker.mjs";

const target = "https://modal.example/v1/validations";
const env = { MODAL_VALIDATION_URL: target };

async function withFetch(fakeFetch, run) {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  globalThis.fetch = fakeFetch;
  console.log = () => {};
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
}

test("rejects every method and path except POST /v1/validations", async () => {
  let called = false;
  await withFetch(async () => { called = true; }, async () => {
    for (const request of [
      new Request("https://proxy.example/v1/validations", { method: "GET" }),
      new Request("https://proxy.example/other", { method: "POST" }),
    ]) {
      const response = await worker.fetch(request, env, {});
      assert.equal(response.status, 404);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  });
  assert.equal(called, false);
});

test("forwards exact body bytes and Sentinel auth headers unchanged", async () => {
  const payload = new Uint8Array([0, 255, 1, 128, 65]);
  let request;
  await withFetch(async (url, init) => {
    assert.equal(url, target);
    assert.deepEqual(new Uint8Array(init.body), payload);
    assert.equal(init.headers.get("x-sentinel-request-timestamp"), "1712345678");
    assert.equal(init.headers.get("x-sentinel-request-signature"), "sha256=abc123");
    assert.equal(init.headers.get("content-type"), "application/octet-stream");
    assert.equal(init.signal, request.signal);
    return new Response(new Uint8Array([9]), { status: 202 });
  }, async () => {
    request = new Request("https://proxy.example/v1/validations", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "x-sentinel-request-timestamp": "1712345678",
        "x-sentinel-request-signature": "sha256=abc123",
      },
      body: payload,
    });
    assert.equal((await worker.fetch(request, env, {})).status, 202);
  });
});

test("passes Modal status, raw response body, and contract headers through", async () => {
  const upstreamBytes = new Uint8Array([255, 0, 42]);
  await withFetch(async () => new Response(upstreamBytes, {
    status: 422,
    headers: {
      "content-type": "application/json",
      "cache-control": "private, no-store",
      "x-sentinel-worker-signature": "sha256=response-signature",
      "x-unrelated": "not forwarded",
    },
  }), async () => {
    const response = await worker.fetch(new Request("https://proxy.example/v1/validations", {
      method: "POST", body: "{}",
    }), env, {});
    assert.equal(response.status, 422);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), upstreamBytes);
    assert.equal(response.headers.get("content-type"), "application/json");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("x-sentinel-worker-signature"), "sha256=response-signature");
    assert.equal(response.headers.get("x-unrelated"), null);
  });
});

test("does not impose an artificial upstream deadline on a long-running validation", async () => {
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => {
    throw new Error("proxy must not schedule an upstream timeout");
  };
  try {
    await withFetch(async () => {
      // The response is intentionally delayed relative to the unit test. The
      // assertion that no proxy timer was scheduled proves it can outlive the
      // former 10-second cutoff.
      await new Promise((resolve) => originalSetTimeout(resolve, 15));
      return new Response("finished", { status: 200 });
    }, async () => {
      const response = await worker.fetch(new Request("https://proxy.example/v1/validations", {
        method: "POST", body: "{}",
      }), env, {});
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "finished");
    });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test("cancels the upstream request when the incoming request is aborted", async () => {
  const controller = new AbortController();
  await withFetch(async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) {
      reject(new Error("client disconnected"));
      return;
    }
    init.signal.addEventListener("abort", () => reject(new Error("client disconnected")), { once: true });
  }), async () => {
    const responsePromise = worker.fetch(new Request("https://proxy.example/v1/validations", {
      method: "POST", body: "{}", signal: controller.signal,
    }), env, {});
    controller.abort();
    const response = await responsePromise;
    assert.equal(response.status, 499);
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("normalizes upstream failures without exposing error details", async () => {
  await withFetch(async () => { throw new Error("DNS lookup leaked.example failed"); }, async () => {
    const response = await worker.fetch(new Request("https://proxy.example/v1/validations", {
      method: "POST", body: "{}",
    }), env, {});
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Validation upstream unavailable");
  });
});

test("adds no-store when an upstream response omits cache-control", async () => {
  await withFetch(async () => new Response("{}", { status: 200 }), async () => {
    const response = await worker.fetch(new Request("https://proxy.example/v1/validations", {
      method: "POST", body: "{}",
    }), env, {});
    assert.equal(response.headers.get("cache-control"), "no-store");
  });
});

test("uses only a non-secret Modal URL binding and has a documented default", () => {
  assert.equal(DEFAULT_MODAL_VALIDATION_URL,
    "https://deadpoo10--sentinel-validation-worker-web.modal.run/v1/validations");
  assert.equal(hasOnlyNonSecretConfiguration({ MODAL_VALIDATION_URL: target }), true);
  assert.equal(hasOnlyNonSecretConfiguration({ MODAL_VALIDATION_URL: target, GITHUB_TOKEN: "x" }), false);
});
