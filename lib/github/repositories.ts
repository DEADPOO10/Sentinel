import { headers } from "next/headers";
import { getToken } from "next-auth/jwt";
import { cache } from "react";
import { logger } from "@/lib/logger";

export type GitHubRepository = {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  language: string | null;
  default_branch: string;
  updated_at: string;
};

export type VerifiedGitHubRepository = {
  githubRepositoryId: number;
  owner: string;
  name: string;
  fullName: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  language: string | null;
  githubUrl: string;
};

type GitHubRepositoriesResult = { repositories: GitHubRepository[] } | { error: string };
type VerifiedGitHubRepositoryResult = { kind: "ready"; repository: VerifiedGitHubRepository } | { kind: "error"; error: string };
type GitHubAuthContext = { accessToken: string | null; userIdentifier?: string };

const GITHUB_OWNER_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z\d][A-Za-z\d._-]{0,99}$/;
const GIT_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const GITHUB_REQUEST_TIMEOUT_MS = 8_000;

class GitHubApiError extends Error {
  constructor(public readonly status: number) {
    super("GitHub repository request failed");
  }
}

export async function getGitHubRepositoriesForCurrentUser(): Promise<GitHubRepositoriesResult> {
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  const authContext = await getGitHubAuthContextForCurrentUser();
  logger.info("github.repositories.fetch_started", {
    service: "sentinel-github",
    operationId,
    userIdentifier: authContext?.userIdentifier,
    metadata: { operation: "list_repositories" },
  });

  const accessToken = authContext?.accessToken;
  if (!accessToken) {
    logger.warn("github.repositories.fetch_failed", {
      service: "sentinel-github",
      operationId,
      userIdentifier: authContext?.userIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: { category: "authorization_missing" },
    });
    return { error: "Your GitHub authorization needs to be refreshed. Sign out, then connect GitHub again." };
  }

  try {
    const repositories = await fetchGitHubRepositories(accessToken);
    logger.info("github.repositories.fetch_succeeded", {
      service: "sentinel-github",
      operationId,
      userIdentifier: authContext.userIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: { repositoryCount: repositories.length },
    });
    return { repositories };
  } catch (error) {
    logger.error("github.repositories.fetch_failed", {
      service: "sentinel-github",
      operationId,
      userIdentifier: authContext.userIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: { category: getGitHubFailureCategory(error) },
    });
    return { error: getUserFacingError(error) };
  }
}

/**
 * Confirms that the currently authenticated GitHub account can still access a
 * selected repository and returns only the metadata Sentinel persists.
 */
export async function getVerifiedGitHubRepositoryForCurrentUser(owner: string, repository: string): Promise<VerifiedGitHubRepositoryResult> {
  const operationId = crypto.randomUUID();
  const startedAt = Date.now();
  const repositoryIdentifier = `${owner}/${repository}`;
  const authContext = await getGitHubAuthContextForCurrentUser();
  logger.info("github.repository.fetch_started", {
    service: "sentinel-github",
    operationId,
    userIdentifier: authContext?.userIdentifier,
    repositoryIdentifier,
    metadata: { operation: "verify_repository_access" },
  });

  if (!isValidGitHubRepositoryIdentifier(owner, repository)) {
    logger.warn("github.repository.selection_failed", {
      service: "sentinel-github",
      operationId,
      userIdentifier: authContext?.userIdentifier,
      repositoryIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: { category: "invalid_repository_identifier" },
    });
    return { kind: "error", error: "This repository selection is invalid." };
  }

  const accessToken = authContext?.accessToken;
  if (!accessToken) {
    logger.warn("github.repository.selection_failed", {
      service: "sentinel-github",
      operationId,
      userIdentifier: authContext?.userIdentifier,
      repositoryIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: { category: "authorization_missing" },
    });
    return { kind: "error", error: "Your GitHub authorization needs to be refreshed. Sign out, then connect GitHub again." };
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, {
      headers: getGitHubHeaders(accessToken),
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });

    if (response.status === 404) {
      logger.warn("github.repository.selection_failed", {
        service: "sentinel-github",
        operationId,
        userIdentifier: authContext.userIdentifier,
        repositoryIdentifier,
        durationMs: Date.now() - startedAt,
        metadata: { category: "not_found" },
      });
      return { kind: "error", error: "This repository is no longer available to your GitHub account." };
    }
    if (!response.ok) throw new GitHubApiError(response.status);

    const verifiedRepository = parseVerifiedGitHubRepository(await response.json(), owner, repository);
    if (!verifiedRepository) {
      logger.error("github.repository.selection_failed", {
        service: "sentinel-github",
        operationId,
        userIdentifier: authContext.userIdentifier,
        repositoryIdentifier,
        durationMs: Date.now() - startedAt,
        metadata: { category: "invalid_response" },
      });
      return { kind: "error", error: "GitHub could not verify this repository. Please refresh and try again." };
    }

    logger.info("github.repository.fetch_succeeded", {
      service: "sentinel-github",
      operationId,
      userIdentifier: authContext.userIdentifier,
      repositoryIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: { operation: "verify_repository_access" },
    });
    return { kind: "ready", repository: verifiedRepository };
  } catch (error) {
    logger.error("github.repository.selection_failed", {
      service: "sentinel-github",
      operationId,
      userIdentifier: authContext.userIdentifier,
      repositoryIdentifier,
      durationMs: Date.now() - startedAt,
      metadata: { category: getGitHubFailureCategory(error) },
    });
    return { kind: "error", error: getRepositoryVerificationError(error) };
  }
}

const getGitHubAuthContextForCurrentUser = cache(async function getGitHubAuthContextForCurrentUser(): Promise<GitHubAuthContext | null> {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;

  const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const token = await getToken({
    req: { headers: await headers() },
    secret,
    secureCookie: authUrl ? authUrl.startsWith("https://") : process.env.NODE_ENV === "production",
  });

  if (!token) return null;
  return {
    accessToken: typeof token.githubAccessToken === "string" ? token.githubAccessToken : null,
    ...(typeof token.sub === "string" && token.sub.length > 0
      ? { userIdentifier: token.sub }
      : {}),
  };
});

export const getGitHubAccessTokenForCurrentUser = cache(async function getGitHubAccessTokenForCurrentUser() {
  return (await getGitHubAuthContextForCurrentUser())?.accessToken ?? null;
});

async function fetchGitHubRepositories(accessToken: string) {
  const repositories: GitHubRepository[] = [];
  let nextPage: string | null = "https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&sort=updated&direction=desc";

  while (nextPage) {
    const response = await fetch(nextPage, {
      headers: getGitHubHeaders(accessToken),
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) throw new GitHubApiError(response.status);

    const page = await response.json() as GitHubRepository[];
    if (!Array.isArray(page)) throw new GitHubApiError(response.status);

    repositories.push(...page);
    nextPage = getNextPage(response.headers.get("link"));
  }

  return repositories;
}

function getGitHubHeaders(accessToken: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "Sentinel",
    "X-GitHub-Api-Version": "2026-03-10",
  };
}

function parseVerifiedGitHubRepository(value: unknown, requestedOwner: string, requestedRepository: string): VerifiedGitHubRepository | null {
  if (!isRecord(value)) return null;

  const githubRepositoryId = value.id;
  if (!isRecord(value)
    || typeof githubRepositoryId !== "number"
    || !Number.isSafeInteger(githubRepositoryId)
    || githubRepositoryId <= 0
    || typeof value.name !== "string"
    || typeof value.full_name !== "string"
    || !isRecord(value.owner)
    || typeof value.owner.login !== "string"
    || typeof value.default_branch !== "string"
    || typeof value.html_url !== "string") {
    return null;
  }

  const owner = value.owner.login;
  const name = value.name;
  const fullName = value.full_name;
  if (!isValidGitHubRepositoryIdentifier(owner, name)
    || !sameGitHubIdentifier(owner, requestedOwner)
    || !sameGitHubIdentifier(name, requestedRepository)
    || fullName !== `${owner}/${name}`
    || !isSafeGitReference(value.default_branch)
    || !isMatchingGitHubUrl(value.html_url, fullName)) {
    return null;
  }

  const visibility = value.visibility === "public" || value.visibility === "private" || value.visibility === "internal"
    ? value.visibility
    : value.private === true
      ? "private"
      : value.private === false
        ? "public"
        : null;
  const language = typeof value.language === "string" && value.language.trim().length > 0 && value.language.length <= 100
    ? value.language.trim()
    : null;

  if (!visibility) return null;

  return {
    githubRepositoryId,
    owner,
    name,
    fullName,
    visibility,
    defaultBranch: value.default_branch,
    language,
    githubUrl: value.html_url,
  };
}

function isValidGitHubRepositoryIdentifier(owner: string, repository: string) {
  return GITHUB_OWNER_PATTERN.test(owner) && GITHUB_REPOSITORY_PATTERN.test(repository);
}

function isSafeGitReference(value: string) {
  return GIT_REFERENCE_PATTERN.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/");
}

function isMatchingGitHubUrl(value: string, fullName: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.replace(/^\//, "").toLowerCase() === fullName.toLowerCase();
  } catch {
    return false;
  }
}

function sameGitHubIdentifier(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getNextPage(linkHeader: string | null) {
  const nextPage = linkHeader?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  return nextPage?.startsWith("https://api.github.com/") ? nextPage : null;
}

function getUserFacingError(error: unknown) {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "GitHub rejected this authorization. Sign out, then connect GitHub again.";
    if (error.status === 403 || error.status === 429) return "GitHub cannot serve repositories right now. Please try again shortly.";
  }

  return "GitHub is unavailable right now. Please try again shortly.";
}

function getRepositoryVerificationError(error: unknown) {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "GitHub rejected this authorization. Sign out, then connect GitHub again.";
    if (error.status === 403 || error.status === 429) return "GitHub cannot verify this repository right now. Please try again shortly.";
  }

  return "GitHub is unavailable right now. Please try again shortly.";
}

function getGitHubFailureCategory(error: unknown) {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "authorization_rejected";
    if (error.status === 403) return "access_forbidden";
    if (error.status === 404) return "not_found";
    if (error.status === 429) return "rate_limited";
    if (error.status >= 500) return "provider_server_error";
    if (error.status >= 200 && error.status < 300) return "invalid_response";
    return "provider_http_error";
  }
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  return "network_or_request_error";
}
