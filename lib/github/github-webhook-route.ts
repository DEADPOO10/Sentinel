import { parsePullRequestWebhookPayload, isSupportedPullRequestWebhookAction } from "./pull-request-webhook.ts";
import { verifyGitHubWebhookSignature } from "./webhook-signature.ts";
import type { PullRequestLifecycleProcessingInput, PullRequestLifecycleProcessingResult } from "../db/pull-request-lifecycle.ts";
import { logger } from "../logger.ts";
import { createOperationId, getOperationId, withOperationId } from "../observability/context.ts";

export const GITHUB_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const GITHUB_WEBHOOK_MINIMUM_SECRET_LENGTH = 32;
const OBVIOUS_WEBHOOK_SECRET_PATTERN = /^(?:example|changeme|test|secret|default|placeholder|replaceme)+$/;
const OBVIOUS_WEBHOOK_SECRET_VALUES = new Set([
  "githubwebhooksecret",
  "replacewitharandomwebhooksecret",
  "yourgithubwebhooksecret",
  "yourwebhooksecret",
]);

type GitHubWebhookRouteDependencies = {
  getSecret(): string | undefined;
  processPullRequest(input: PullRequestLifecycleProcessingInput): Promise<PullRequestLifecycleProcessingResult>;
};

class WebhookBodyTooLargeError extends Error {}

export function createGitHubWebhookPostHandler(dependencies: GitHubWebhookRouteDependencies) {
  return function handleGitHubWebhook(request: Request): Promise<Response> {
    const operationId = getOperationId() ?? createOperationId();
    return withOperationId(
      operationId,
      () => handleGitHubWebhookWithContext(request, dependencies),
    );
  };
}

async function handleGitHubWebhookWithContext(
  request: Request,
  dependencies: GitHubWebhookRouteDependencies,
): Promise<Response> {
  const startedAt = Date.now();
  let eventType: string | null = null;
  let deliveryIdForLogs: string | null = null;
  const respond = (
    status: number,
    result: string,
    metadata: Record<string, unknown> = {},
    repositoryIdentifier?: string,
  ) => {
    const context = {
      service: "sentinel-github-webhook",
      repositoryIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: {
        result,
        httpStatus: status,
        ...(eventType ? { eventType } : {}),
        ...(deliveryIdForLogs ? { deliveryId: deliveryIdForLogs } : {}),
        ...metadata,
      },
    };
    if (status >= 500) logger.error("github_webhook.completed", context);
    else if (status >= 400) logger.warn("github_webhook.completed", context);
    else logger.info("github_webhook.completed", context);
    return safeResponse(status, result);
  };

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return respond(415, "unsupported_content_type");
  }

  const event = getSafeHeader(request.headers.get("x-github-event"), 64);
  const deliveryId = getSafeHeader(request.headers.get("x-github-delivery"), 100);
  const signature = request.headers.get("x-hub-signature-256");
  eventType = event;
  deliveryIdForLogs = deliveryId;
  if (!event || !deliveryId) return respond(400, "missing_required_header");
  if (!signature) return respond(401, "invalid_signature");

  const secret = getConfiguredWebhookSecret(dependencies.getSecret());
  if (!secret) return respond(503, "webhook_not_configured");

  logger.info("github_webhook.started", {
    service: "sentinel-github-webhook",
    metadata: { eventType: event, deliveryId },
  });

  let rawBody: Uint8Array;
  try {
    rawBody = await readBoundedBody(request, GITHUB_WEBHOOK_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) return respond(413, "payload_too_large");
    return respond(400, "body_unavailable");
  }

  if (!verifyGitHubWebhookSignature(secret, signature, rawBody).valid) {
    return respond(401, "invalid_signature");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody)) as unknown;
  } catch {
    return respond(400, "malformed_json");
  }

  if (event === "ping") return respond(200, "accepted");
  if (event !== "pull_request") return respond(202, "ignored_event");

  const action = getPayloadAction(parsed);
  if (!action) return respond(400, "malformed_payload");
  if (!isSupportedPullRequestWebhookAction(action)) return respond(202, "ignored_action");

  const payload = parsePullRequestWebhookPayload(parsed);
  if (!payload) return respond(400, "malformed_payload", { action });

  try {
    const result = await dependencies.processPullRequest({ deliveryId, payload });
    return respond(200, result.kind, { action }, payload.repository.githubRepositoryId);
  } catch {
    return respond(500, "processing_failed", {
      action,
      stage: "database_transaction",
      category: "retryable_database_error",
    }, payload.repository.githubRepositoryId);
  }
}

function getConfiguredWebhookSecret(value: string | undefined) {
  const secret = value?.trim();
  if (!secret || secret.length < GITHUB_WEBHOOK_MINIMUM_SECRET_LENGTH) return null;

  const normalized = secret.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (
    !normalized
    || OBVIOUS_WEBHOOK_SECRET_PATTERN.test(normalized)
    || OBVIOUS_WEBHOOK_SECRET_VALUES.has(normalized)
  ) {
    return null;
  }

  return secret;
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
