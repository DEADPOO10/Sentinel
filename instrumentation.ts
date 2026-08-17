import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  errorContext,
) => {
  Sentry.captureRequestError(error, request, errorContext);

  if (process.env.NEXT_RUNTIME !== "edge") {
    const { logger } = await import("./lib/logger.ts");
    logger.error("sentry.request_error_captured", {
      service: "sentinel-web",
      metadata: {
        runtime: "nodejs",
        routerKind: errorContext.routerKind,
        routeType: errorContext.routeType,
      },
    });
  }
};
