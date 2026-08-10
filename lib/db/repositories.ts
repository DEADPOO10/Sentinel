import "server-only";

import { requireUser } from "@/lib/auth/session";
import { getPrismaClient } from "@/lib/db/prisma";
import { upsertSentinelUser } from "@/lib/db/sentinel-user";

const GITHUB_OWNER_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z\d][A-Za-z\d._-]{0,99}$/;
const GIT_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const REPOSITORY_VISIBILITIES = new Set(["public", "private", "internal"]);

export type SentinelRepositoryInput = {
  githubRepositoryId: number | string;
  owner: string;
  name: string;
  fullName: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  language?: string | null;
  githubUrl: string;
};

export async function upsertSentinelRepository(input: SentinelRepositoryInput) {
  const repository = getRepositoryData(input);
  if (!repository) throw new Error("The GitHub repository data is incomplete.");

  return getPrismaClient().repository.upsert({
    where: { githubRepositoryId: repository.githubRepositoryId },
    update: repository,
    create: repository,
  });
}

export async function connectRepositoryToCurrentSentinelUser(input: SentinelRepositoryInput) {
  const [user, repository] = await Promise.all([
    upsertSentinelUser(),
    upsertSentinelRepository(input),
  ]);

  return getPrismaClient().userRepository.upsert({
    where: {
      userId_repositoryId: {
        userId: user.id,
        repositoryId: repository.id,
      },
    },
    update: {},
    create: {
      userId: user.id,
      repositoryId: repository.id,
    },
    select: {
      id: true,
      createdAt: true,
      repository: {
        select: {
          id: true,
          githubRepositoryId: true,
          owner: true,
          name: true,
          fullName: true,
          visibility: true,
          defaultBranch: true,
          language: true,
          githubUrl: true,
        },
      },
    },
  });
}

export async function listRepositoriesConnectedByCurrentSentinelUser() {
  const sessionUser = await requireUser();
  const githubUserId = getSafeGitHubUserId(sessionUser.id);
  if (!githubUserId) return [];

  const user = await getPrismaClient().user.findUnique({
    where: { githubUserId },
    select: {
      repositories: {
        orderBy: { createdAt: "desc" },
        select: {
          createdAt: true,
          repository: {
            select: {
              id: true,
              githubRepositoryId: true,
              owner: true,
              name: true,
              fullName: true,
              visibility: true,
              defaultBranch: true,
              language: true,
              githubUrl: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  });

  return user?.repositories ?? [];
}

function getRepositoryData(input: SentinelRepositoryInput) {
  const githubRepositoryId = getSafeGitHubRepositoryId(input.githubRepositoryId);
  if (!githubRepositoryId || !GITHUB_OWNER_PATTERN.test(input.owner) || !GITHUB_REPOSITORY_PATTERN.test(input.name) || input.fullName !== `${input.owner}/${input.name}` || !REPOSITORY_VISIBILITIES.has(input.visibility) || !isSafeGitReference(input.defaultBranch)) return null;

  const githubUrl = getSafeGitHubUrl(input.githubUrl, input.fullName);
  const language = getSafeText(input.language, 100);
  if (!githubUrl) return null;

  return {
    githubRepositoryId,
    owner: input.owner,
    name: input.name,
    fullName: input.fullName,
    visibility: input.visibility.toUpperCase() as "PUBLIC" | "PRIVATE" | "INTERNAL",
    defaultBranch: input.defaultBranch,
    language,
    githubUrl,
  };
}

function getSafeGitHubRepositoryId(value: number | string) {
  const normalized = typeof value === "number" ? String(value) : value;
  return /^(?:0|[1-9]\d{0,18})$/.test(normalized) ? normalized : null;
}

function getSafeGitHubUserId(value: string) {
  return value.length > 0 && value.length <= 128 && !/[\u0000-\u001F\u007F]/.test(value) ? value : null;
}

function getSafeGitHubUrl(value: string, fullName: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.replace(/^\//, "").toLowerCase() === fullName.toLowerCase() ? url.toString() : null;
  } catch {
    return null;
  }
}

function getSafeText(value: string | null | undefined, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function isSafeGitReference(value: string) {
  return GIT_REFERENCE_PATTERN.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/");
}
