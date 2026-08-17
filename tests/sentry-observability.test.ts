import assert from "node:assert/strict";
import test from "node:test";
import type { ErrorEvent } from "@sentry/nextjs";
import {
  filterSensitiveSentryIntegrations,
  sanitizeSentryEvent,
} from "../lib/observability/sentry.ts";

test("Sentry event sanitizer removes request, identity, content, and dependency data", () => {
  const event: ErrorEvent = {
    type: undefined,
    event_id: "event-id",
    environment: "production",
    release: "release-123",
    message: "prompt and access token should not leave Sentinel",
    request: {
      url: "https://sentinel.example/private/repository",
      headers: { authorization: "Bearer private-token", cookie: "session=private" },
      cookies: { session: "private" },
      data: "private request body",
    },
    user: { id: "private-user", email: "private@example.test" },
    modules: { "private-package": "1.2.3" },
    extra: {
      prompt: "private prompt",
      repositoryContents: "private repository source",
    },
    breadcrumbs: [{ message: "private breadcrumb", data: { token: "private" } }],
    contexts: { response: { headers: { authorization: "private" } } },
    exception: {
      values: [{
        type: "ProviderError",
        value: "Authorization: Bearer private-token",
        mechanism: { type: "generic", handled: false, data: { body: "private" } },
        stacktrace: {
          frames: [{
            filename: "lib/example.ts?token=private",
            function: "runValidation",
            lineno: 42,
            colno: 7,
            context_line: "const secret = privateToken",
            pre_context: ["private source"],
            post_context: ["private source"],
            vars: { secret: "private" },
          }],
        },
      }],
    },
  };

  const sanitized = sanitizeSentryEvent(event, {
    operationId: "operation-123",
    environment: "production",
    release: "release-123",
    runtime: "server",
  });
  const serialized = JSON.stringify(sanitized);

  assert.equal(sanitized.request, undefined);
  assert.equal(sanitized.user, undefined);
  assert.equal(sanitized.modules, undefined);
  assert.equal(sanitized.extra, undefined);
  assert.equal(sanitized.breadcrumbs, undefined);
  assert.equal(sanitized.message, undefined);
  assert.equal(sanitized.tags?.sentinel_operation_id, "operation-123");
  assert.equal(sanitized.environment, "production");
  assert.equal(sanitized.release, "release-123");
  assert.equal(sanitized.exception?.values?.[0]?.value, "Unhandled application error");
  assert.equal(sanitized.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename, "lib/example.ts");

  for (const forbidden of [
    "private-token",
    "private-user",
    "private@example.test",
    "private-package",
    "private prompt",
    "private repository source",
    "private breadcrumb",
    "private request body",
    "const secret",
    "private source",
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("Sentry integration filter removes content-bearing default collectors", () => {
  const retained = filterSensitiveSentryIntegrations([
    { name: "GlobalHandlers" },
    { name: "OnUnhandledRejection" },
    { name: "RequestData" },
    { name: "ContextLines" },
    { name: "LocalVariablesAsync" },
    { name: "Modules" },
    { name: "Breadcrumbs" },
    { name: "Console" },
  ]);

  assert.deepEqual(
    retained.map((integration) => integration.name),
    ["GlobalHandlers", "OnUnhandledRejection"],
  );
});

test("Sentry sanitizer omits invalid operation, environment, and release labels", () => {
  const sanitized = sanitizeSentryEvent(
    { type: undefined, message: "private original message" },
    {
      operationId: "unsafe operation id",
      environment: "unsafe environment",
      release: "unsafe release value",
      runtime: "edge",
    },
  );

  assert.equal(sanitized.message, "Application error");
  assert.equal(sanitized.environment, "unknown");
  assert.equal(sanitized.release, undefined);
  assert.equal(sanitized.tags?.sentinel_operation_id, undefined);
});
