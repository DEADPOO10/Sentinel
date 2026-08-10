import "server-only";

import { requireUser } from "@/lib/auth/session";
import { getPrismaClient } from "@/lib/db/prisma";

const GITHUB_LOGIN_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;

export async function upsertSentinelUser() {
  const sessionUser = await requireUser();
  const githubUserId = getSafeText(sessionUser.id, 128);
  const githubLogin = getSafeGitHubLogin(sessionUser.username);
  if (!githubUserId || !githubLogin) throw new Error("The authenticated GitHub profile is incomplete.");

  const name = getSafeText(sessionUser.name, 256);
  const email = getSafeText(sessionUser.email, 320);
  const avatarUrl = getSafeHttpsUrl(sessionUser.image, 2_048);

  return getPrismaClient().user.upsert({
    where: { githubUserId },
    update: {
      githubLogin,
      ...(name ? { name } : {}),
      ...(email ? { email } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    },
    create: {
      githubUserId,
      githubLogin,
      name,
      email,
      avatarUrl,
    },
    select: {
      id: true,
      githubUserId: true,
      githubLogin: true,
      name: true,
      email: true,
      avatarUrl: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

function getSafeGitHubLogin(value: string | undefined) {
  return value && GITHUB_LOGIN_PATTERN.test(value) ? value : null;
}

function getSafeText(value: string | null | undefined, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function getSafeHttpsUrl(value: string | null | undefined, maximumLength: number) {
  const normalized = getSafeText(value, maximumLength);
  if (!normalized) return null;

  try {
    return new URL(normalized).protocol === "https:" ? normalized : null;
  } catch {
    return null;
  }
}
