"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#f5f5ef] text-[#171817]">
        <main className="mx-auto flex min-h-screen max-w-xl items-center px-6 py-16">
          <section className="w-full rounded-3xl border border-[#d5d6ce] bg-white p-8 shadow-sm">
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[#67685f]">
              Sentinel
            </p>
            <h1 className="mt-4 text-3xl font-semibold tracking-[-0.03em]">
              Something went wrong
            </h1>
            <p className="mt-3 text-sm leading-6 text-[#67685f]">
              The error was recorded safely. You can retry without changing repository data.
            </p>
            <button
              type="button"
              onClick={reset}
              className="mt-6 rounded-full border border-[#171817] bg-[#d8ff42] px-5 py-2.5 text-sm font-semibold text-[#171817] transition hover:bg-[#cbef3d] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#171817]"
            >
              Try again
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
