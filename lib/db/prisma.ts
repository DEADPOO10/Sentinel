import "server-only";

import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as {
  sentinelPrisma?: PrismaClient;
};

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("Sentinel database is not configured.");
  }
}

export function isDatabaseConfigured() {
  return typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL.trim().length > 0;
}

export function getPrismaClient() {
  if (globalForPrisma.sentinelPrisma) return globalForPrisma.sentinelPrisma;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new DatabaseNotConfiguredError();

  const adapter = new PrismaPg({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  const client = new PrismaClient({ adapter });
  globalForPrisma.sentinelPrisma = client;

  return client;
}
