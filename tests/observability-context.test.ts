import assert from "node:assert/strict";
import test from "node:test";
import {
  createOperationId,
  getOperationId,
  withOperationId,
} from "../lib/observability/context.ts";
import { logger } from "../lib/logger.ts";

test("operation IDs are opaque UUIDs", () => {
  const first = createOperationId();
  const second = createOperationId();

  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.notEqual(first, second);
});

test("operation context propagates across asynchronous work and stays isolated", async () => {
  const outerId = createOperationId();
  const innerId = createOperationId();
  assert.equal(getOperationId(), undefined);

  await withOperationId(outerId, async () => {
    assert.equal(getOperationId(), outerId);
    await Promise.resolve();
    assert.equal(getOperationId(), outerId);

    await withOperationId(innerId, async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(getOperationId(), innerId);
    });

    assert.equal(getOperationId(), outerId);
  });

  assert.equal(getOperationId(), undefined);
});

test("logger automatically includes the current operation ID", () => {
  const operationId = createOperationId();
  const originalInfo = console.info;
  const lines: unknown[][] = [];
  console.info = (...values: unknown[]) => { lines.push(values); };
  try {
    withOperationId(operationId, () => {
      logger.info("context.test", { operationId: "manual-fallback" });
    });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0][0] as string) as Record<string, unknown>;
  assert.equal(record.operationId, operationId);
});

test("unsafe operation IDs are rejected", () => {
  assert.throws(
    () => withOperationId("unsafe operation id", () => undefined),
    /safe opaque identifier/,
  );
});
