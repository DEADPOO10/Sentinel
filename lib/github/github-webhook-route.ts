import { parsePullRequestWebhookPayload, isSupportedPullRequestWebhookAction } from "./pull-request-webhook.ts";
import { verifyGitHubWebhookSignature } from "./webhook-signature.ts";
import type { PullRequestLifecycleProcessingInput, PullRequestLifecycleProcessingResult } from "../db/pull-request-lifecycle.ts";

export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

type GitHubWebhookRouteDependencies = {
  getSecret(): string | undefined;
  processPullRequest(input: PullRequestLifecycleProcessingInput): Promise<PullRequestLifecycleProcessingResult>;
};

class WebhookBodyTooLargeError extends Error {}

export function createGitHubWebhookPostHandler(dependencies: GitHubWebhookRouteDependencies) {
  return async function handleGitHubWebhook(request: Request): Promise<Response> {
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return safeResponse(415, "unsupported_content_type");
    }

    const event = getSafeHeader(request.headers.get("x-github-event"), 64);
    const deliveryId = getSafeHeader(request.headers.get("x-github-delivery"), 100);
    const signature = request.headers.get("x-hub-signature-256");
    if (!event || !deliveryId) return safeResponse(400, "missing_required_header");
    if (!signature) return safeResponse(401, "invalid_signature");

    const secret = dependencies.getSecret()?.trim();
    if (!secret) return safeResponse(503, "webhook_not_configured");

    let rawBody: Uint8Array;
    try {
      rawBody = await readBoundedBody(request, GITHUB_WEBHOOK_MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof WebhookBodyTooLargeError) return safeResponse(413, "payload_too_large");
      return safeResponse(400, "body_unavailable");
    }

    if (!verifyGitHubWebhookSignature(secret, signature, rawBody).valid) {
      return safeResponse(401, "invalid_signature");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
    } catch {
      return safeResponse(400, "malformed_json");
    }

    if (event === "ping") return safeResponse(200, "accepted");
    if (event !== "pull_request") return safeResponse(202, "ignored_event");

    const action = getPayloadAction(parsed);
    if (!action) return safeResponse(400, "malformed_payload");
    if (!isSupportedPullRequestWebhookAction(action)) return safeResponse(202, "ignored_action");

    const payload = parsePullRequestWebhookPayload(parsed);
    if (!payload) return safeResponse(400, "malformed_payload");

    try {
      const result = await dependencies.processPullRequest({ deliveryId, payload });
      return safeResponse(200, result.kind);
    } catch {
      console.error("[sentinel:github-webhook] processing_failed", {
        stage: "database_transaction",
        category: "retryable_database_error",
      });
      return safeResponse(500, "processing_failed");
    }
  };
}

async function readBoundedBody(request: Request, maximumBytes: number) {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new WebhookBodyTooLargeError();
  }

  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel();
      throw new WebhookBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isJsonContentType(value: string | null) {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function getSafeHeader(value: string | null, maximumLength: number) {
  return value
    && value.length > 0
    && value.length <= maximumLength
    && /^[A-Za-z0-9_.-]+$/.test(value)
    ? value
    : null;
}

function getPayloadAction(value: unknown) {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).action === "string"
    ? (value as Record<string, unknown>).action
    : null;
}

function safeResponse(status: number, result: string) {
  return Response.json({ result }, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}
