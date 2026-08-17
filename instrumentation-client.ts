import * as Sentry from "@sentry/nextjs";
import {
  filterSensitiveSentryIntegrations,
  sanitizeSentryEvent,
} from "./lib/observability/sentry.ts";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  sendDefaultPii: false,
  tracesSampleRate: 0,
  enableLogs: false,
  maxBreadcrumbs: 0,
  integrations: filterSensitiveSentryIntegrations,
  beforeBreadcrumb: () => null,
  beforeSend: (event) => sanitizeSentryEvent(event, {
    runtime: "client",
  }),
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
