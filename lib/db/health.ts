import "server-only";

import { getPrismaClient, isDatabaseConfigured } from "@/lib/db/prisma";

export async function getDatabaseHealth(): Promise<{ databaseReachable: boolean }> {
  if (!isDatabaseConfigured()) return { databaseReachable: false };

  try {
    await getPrismaClient().$queryRaw`SELECT 1`;
    return { databaseReachable: true };
  } catch {
    return { databaseReachable: false };
  }
}
