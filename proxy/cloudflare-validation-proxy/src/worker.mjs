/**
 * This Worker deliberately has no credentials, storage bindings, or HMAC logic.
 * It passes the exact inbound request body and Sentinel's existing auth headers
 * through to the configured Modal validation endpoint.
 */
export const DEFAULT_MODAL_VALIDATION_URL =
  "https://deadpoo10--sentinel-validation-worker-web.modal.run/v1/validations";

const VALIDATION_PATH = "/v1/validations";

function safeLog(event, details = {}) {
  // Only fixed event categories and non-sensitive metadata may be logged here.
  console.log(JSON.stringify({ event, ...details }));
}

function upstreamUrl(env) {
  return env.MODAL_VALIDATION_URL || DEFAULT_MODAL_VALIDATION_URL;
}

function responseHeaders(upstreamHeaders) {
  // Deliberately expose only the response headers that are part of Sentinel's
  // validation contract. Do not synthesize or alter their values.
  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "x-sentinel-worker-signature"]) {
    const value = upstreamHeaders.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return headers;
}

export function hasOnlyNonSecretConfiguration(env) {
  return Object.keys(env).every((key) => key === "MODAL_VALIDATION_URL");
}

const worker = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== VALIDATION_PATH) {
      return new Response("Not found", {
        status: 404,
        headers: { "cache-control": "no-store" },
      });
    }

    // Read the original bytes once and send those same bytes upstream. This is
    // important because Modal validates Sentinel's signature against raw bytes.
    const body = await request.arrayBuffer();
    try {
      safeLog("request_forwarded");
      const upstream = await fetch(upstreamUrl(env), {
        method: "POST",
        // Clone all inbound headers. In particular, do not recalculate or
        // transform Sentinel's timestamp/signature/content-type values.
        headers: new Headers(request.headers),
        body,
        // There is deliberately no proxy-specific deadline. The caller and
        // Modal worker share Sentinel's documented five-minute job budget.
        // With request_signal_passthrough enabled, a client disconnect also
        // cancels this upstream request instead of leaving it open.
        signal: request.signal,
        // Explicitly prevent the Worker cache from serving or storing this.
        cf: { cacheTtl: 0, cacheEverything: false },
      });
      const upstreamBody = await upstream.arrayBuffer();
      safeLog("upstream_status", { status: upstream.status });
      return new Response(upstreamBody, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers),
      });
    } catch {
      if (request.signal.aborted) {
        safeLog("client_request_aborted");
        return new Response("Validation request was canceled", {
          status: 499,
          headers: { "cache-control": "no-store" },
        });
      }
      safeLog("upstream_request_failed");
      return new Response("Validation upstream unavailable", {
        status: 502,
        headers: { "cache-control": "no-store" },
      });
    }
  },
};

export default worker;
