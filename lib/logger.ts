import { createHash } from "node:crypto";
import { getOperationId } from "./observability/context.ts";

type LogLevel = "info" | "warn" | "error";
type LogIdentifier = string | number;

export type LogContext = {
  service?: string;
  environment?: string;
  operationId?: string;
  userIdentifier?: LogIdentifier;
  repositoryIdentifier?: LogIdentifier;
  durationMs?: number;
  metadata?: Record<string, unknown>;
};

type StructuredLog = {
  timestamp: string;
  level: LogLevel;
  event: string;
  service: string;
  environment: "production" | "preview" | "development" | "test" | "unknown";
  operationId?: string;
  userIdentifierHash?: string;
  repositoryIdentifierHash?: string;
  durationMs?: number;
  metadata: Record<string, unknown>;
};

const DEFAULT_SERVICE = "sentinel-web";
const REDACTED = "[REDACTED]";
const MAX_METADATA_DEPTH = 6;
const MAX_METADATA_ENTRIES = 50;
const MAX_ARRAY_ENTRIES = 50;
const MAX_STRING_LENGTH = 2_000;
const LOG_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVIRONMENTS = new Set(["production", "preview", "development", "test"] as const);

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "headers",
  "requestheaders",
  "responseheaders",
  "cookie",
  "cookies",
  "setcookie",
  "token",
  "accesstoken",
  "refreshtoken",
  "githubtoken",
  "githubaccesstoken",
  "openaiapikey",
  "apikey",
  "password",
  "passwd",
  "privatekey",
  "credential",
  "credentials",
]);

const PROHIBITED_CONTENT_KEYS = new Set([
  "body",
  "rawbody",
  "requestbody",
  "responsebody",
  "webhookbody",
  "payload",
  "prompt",
  "prompts",
  "inputtext",
  "sourcecode",
  "repositorycontents",
  "filecontent",
  "filecontents",
  "content",
  "snippet",
  "diff",
  "patch",
  "archive",
  "commandoutput",
  "stdout",
  "stderr",
]);

const RAW_IDENTITY_KEYS = new Set([
  "userid",
  "githubuserid",
  "repositoryid",
  "githubrepositoryid",
  "repository",
  "repositoryname",
  "repositoryfullname",
  "repositoryurl",
  "owner",
  "email",
  "username",
  "login",
]);

/** Server-side JSON logger for Next.js routes, actions, and Server Components. */
export const logger = {
  info(event: string, context: LogContext = {}) {
    emit("info", event, context);
  },
  warn(event: string, context: LogContext = {}) {
    emit("warn", event, context);
  },
  error(event: string, context: LogContext = {}) {
    emit("error", event, context);
  },
};

/** Deterministic pseudonymous identifier for joining safe operational events. */
export function hashLogIdentifier(value: LogIdentifier, namespace = "generic") {
  return createHash("sha256")
    .update(`sentinel-log-v1\u0000${namespace}\u0000${String(value)}`)
    .digest("hex");
}

function emit(level: LogLevel, event: string, context: LogContext) {
  const record = createLogRecord(level, event, context);
  const line = safelySerialize(record);

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.info(line);
  }
}

function createLogRecord(level: LogLevel, event: string, context: LogContext): StructuredLog {
  const operationId = getSafeLabel(getOperationId()) ?? getSafeLabel(context.operationId);
  const durationMs = getSafeDuration(context.durationMs);
  return {
    timestamp: new Date().toISOString(),
    level,
    event: getSafeLabel(event) ?? "invalid_event",
    service: getSafeLabel(context.service) ?? DEFAULT_SERVICE,
    environment: getEnvironment(context.environment),
    ...(operationId ? { operationId } : {}),
    ...(isLogIdentifier(context.userIdentifier)
      ? { userIdentifierHash: hashLogIdentifier(context.userIdentifier, "user") }
      : {}),
    ...(isLogIdentifier(context.repositoryIdentifier)
      ? { repositoryIdentifierHash: hashLogIdentifier(context.repositoryIdentifier, "repository") }
      : {}),
    ...(durationMs === null ? {} : { durationMs }),
    metadata: sanitizeMetadata(context.metadata),
  };
}

function sanitizeMetadata(value: Record<string, unknown> | undefined) {
  if (!value) return {};
  const seen = new WeakSet<object>();
  const sanitized = sanitizeValue(value, 0, seen);
  return isPlainRecord(sanitized) ? sanitized : {};
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_METADATA_DEPTH) return "[MAX_DEPTH]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "symbol" || typeof value === "function") {
    return "[UNSUPPORTED_VALUE]";
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (value instanceof Error) {
    return {
      name: getSafeErrorName(value.name),
      message: redactString(value.message),
    };
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return "[BINARY_REDACTED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const entries = value.slice(0, MAX_ARRAY_ENTRIES).map((item) => sanitizeValue(item, depth + 1, seen));
    if (value.length > MAX_ARRAY_ENTRIES) entries.push(`[${value.length - MAX_ARRAY_ENTRIES} MORE ITEMS]`);
    return entries;
  }

  if (!isPlainRecord(value)) return "[UNSUPPORTED_OBJECT]";
  const result: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, MAX_METADATA_ENTRIES)) {
    const safeKey = getSafeMetadataKey(key);
    if (!safeKey) continue;
    result[safeKey] = mustRedactKey(key)
      ? REDACTED
      : sanitizeValue(item, depth + 1, seen);
  }
  if (entries.length > MAX_METADATA_ENTRIES) {
    result.truncatedFieldCount = entries.length - MAX_METADATA_ENTRIES;
  }
  return result;
}

function mustRedactKey(key: string) {
  const normalized = normalizeKey(key);
  return SENSITIVE_KEYS.has(normalized)
    || PROHIBITED_CONTENT_KEYS.has(normalized)
    || RAW_IDENTITY_KEYS.has(normalized)
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("privatekey")
    || normalized.includes("apikey")
    || normalized.endsWith("token")
    || normalized.endsWith("credential")
    || normalized.endsWith("body");
}

function redactString(value: string) {
  let redacted = value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED)
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, REDACTED)
    .replace(/\b(?:postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s]+/gi, "[REDACTED_CONNECTION_URL]")
    .replace(/\bhttps?:\/\/[^\s/:@]+:[^\s/@]+@[^\s]+/gi, "[REDACTED_CREDENTIAL_URL]")
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|api[-_ ]?key|private[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[REDACTED]");

  redacted = [...redacted]
    .map((character) => character === "\n" || character === "\t" || character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127 ? character : "?")
    .join("");
  return redacted.length <= MAX_STRING_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_STRING_LENGTH)}…[TRUNCATED]`;
}

function safelySerialize(record: StructuredLog) {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      event: "logger_serialization_failed",
      service: DEFAULT_SERVICE,
      environment: getEnvironment(),
      metadata: {},
    });
  }
}

function getEnvironment(value?: string): StructuredLog["environment"] {
  const candidate = value ?? process.env.VERCEL_ENV ?? process.env.NODE_ENV;
  return ENVIRONMENTS.has(candidate as "production" | "preview" | "development" | "test")
    ? candidate as StructuredLog["environment"]
    : "unknown";
}

function getSafeLabel(value: unknown) {
  return typeof value === "string" && LOG_LABEL_PATTERN.test(value) ? value : null;
}

function getSafeMetadataKey(value: string) {
  const normalized = [...value]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join("")
    .slice(0, 128);
  return normalized || null;
}

function getSafeErrorName(value: string) {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value) ? value : "Error";
}

function getSafeDuration(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function normalizeKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isLogIdentifier(value: unknown): value is LogIdentifier {
  return typeof value === "number"
    ? Number.isSafeInteger(value)
    : typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
