import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  sentinelPrisma?: PrismaClient;
};

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("Sentinel database is not configured.");
  }
}

class DatabaseConfigurationError extends Error {
  constructor() {
    super("Sentinel database configuration is invalid.");
  }
}

export function isDatabaseConfigured() {
  return typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim().length > 0;
}

export function getPrismaClient() {
  if (globalForPrisma.sentinelPrisma) return globalForPrisma.sentinelPrisma;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new DatabaseNotConfiguredError();

  const pool = new Pool({
    connectionString: createVerifyFullConnectionString(connectionString),
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  const adapter = new PrismaPg(pool, { disposeExternalPool: true });
  const client = new PrismaClient({ adapter });
  globalForPrisma.sentinelPrisma = client;

  return client;
}

/** Keeps secrets in the environment while enforcing strict TLS for every runtime connection. */
function createVerifyFullConnectionString(connectionString: string) {
  try {
    const url = new URL(connectionString);
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new DatabaseConfigurationError();

    url.searchParams.set("sslmode", "verify-full");
    return url.toString();
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) throw error;
    throw new DatabaseConfigurationError();
  }
}
