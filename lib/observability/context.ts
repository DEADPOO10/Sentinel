import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

type OperationContext = Readonly<{ operationId: string }>;

const operationContext = new AsyncLocalStorage<OperationContext>();
const OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Creates a non-semantic identifier suitable for correlating one operation. */
export function createOperationId() {
  return randomUUID();
}

/** Returns the identifier for the current asynchronous operation, if present. */
export function getOperationId() {
  return operationContext.getStore()?.operationId;
}

/** Runs synchronous or asynchronous work inside an isolated operation context. */
export function withOperationId<T>(operationId: string, operation: () => T): T {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw new TypeError("Operation ID must be a safe opaque identifier.");
  }

  return operationContext.run(Object.freeze({ operationId }), operation);
}
