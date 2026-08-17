import type { ErrorEvent } from "@sentry/nextjs";

type NamedIntegration = { name: string };

type SentryEventContext = {
  operationId?: string;
  environment?: string;
  release?: string;
  runtime: "client" | "edge" | "server";
};

const OMITTED_INTEGRATIONS = new Set([
  "Breadcrumbs",
  "Console",
  "ContextLines",
  "LocalVariables",
  "LocalVariablesAsync",
  "Modules",
  "RequestData",
]);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+/@:-]{0,199}$/;
const SAFE_ERROR_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const SAFE_FRAME_TEXT_PATTERN = /^[A-Za-z0-9_./@:[\]<>$() -]{1,300}$/;

/** Removes default SDK collectors that could retain application or customer content. */
export function filterSensitiveSentryIntegrations<T extends NamedIntegration>(integrations: T[]) {
  return integrations.filter((integration) => !OMITTED_INTEGRATIONS.has(integration.name));
}

/**
 * Produces the minimal error envelope Sentinel permits Sentry to receive.
 * Raw messages, requests, user data, breadcrumbs, locals, modules, and source
 * context are intentionally omitted even when an upstream integration adds them.
 */
export function sanitizeSentryEvent(
  event: ErrorEvent,
  context: SentryEventContext,
): ErrorEvent {
  const operationId = getSafeIdentifier(context.operationId);
  const environment = getSafeIdentifier(context.environment)
    ?? getSafeIdentifier(event.environment)
    ?? "unknown";
  const release = getSafeRelease(context.release) ?? getSafeRelease(event.release);

  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: event.platform,
    logger: "sentinel",
    environment,
    ...(release ? { release } : {}),
    sdk: event.sdk,
    exception: sanitizeExceptions(event.exception),
    tags: {
      sentinel_runtime: context.runtime,
      sentinel_environment: environment,
      ...(operationId ? { sentinel_operation_id: operationId } : {}),
      ...(release ? { sentinel_release: release } : {}),
    },
    contexts: {
      sentinel: {
        runtime: context.runtime,
        environment,
        ...(operationId ? { operationId } : {}),
        ...(release ? { release } : {}),
      },
    },
    ...(!event.exception ? { message: "Application error" } : {}),
  };
}

function sanitizeExceptions(exception: ErrorEvent["exception"]): ErrorEvent["exception"] {
  if (!exception?.values?.length) return undefined;

  return {
    values: exception.values.map((value) => ({
      type: getSafeErrorType(value.type),
      value: "Unhandled application error",
      ...(value.mechanism
        ? {
            mechanism: {
              type: getSafeIdentifier(value.mechanism.type) ?? "generic",
              ...(typeof value.mechanism.handled === "boolean"
                ? { handled: value.mechanism.handled }
                : {}),
            },
          }
        : {}),
      ...(value.stacktrace?.frames?.length
        ? {
            stacktrace: {
              frames: value.stacktrace.frames.map((frame) => ({
                filename: getSafeFrameText(frame.filename),
                function: getSafeFrameText(frame.function),
                module: getSafeFrameText(frame.module),
                platform: getSafeIdentifier(frame.platform),
                lineno: getSafePositiveInteger(frame.lineno),
                colno: getSafePositiveInteger(frame.colno),
                ...(typeof frame.in_app === "boolean" ? { in_app: frame.in_app } : {}),
              })),
              ...(value.stacktrace.frames_omitted
                ? { frames_omitted: value.stacktrace.frames_omitted }
                : {}),
            },
          }
        : {}),
    })),
  };
}

function getSafeIdentifier(value: unknown) {
  return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value) ? value : undefined;
}

function getSafeRelease(value: unknown) {
  return typeof value === "string" && SAFE_RELEASE_PATTERN.test(value) ? value : undefined;
}

function getSafeErrorType(value: unknown) {
  return typeof value === "string" && SAFE_ERROR_TYPE_PATTERN.test(value) ? value : "Error";
}

function getSafeFrameText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const withoutQuery = value.split(/[?#]/, 1)[0];
  return SAFE_FRAME_TEXT_PATTERN.test(withoutQuery) ? withoutQuery : undefined;
}

function getSafePositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
