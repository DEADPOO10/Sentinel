import "server-only";

import { getGitHubAccessTokenForCurrentUser } from "@/lib/github/repositories";
import { isValidGitHubRepository } from "@/lib/github/package-json";

const GITHUB_API_ORIGIN = "https://api.github.com/";
const SOURCE_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build", "coverage", "vendor", "vendors", "generated", "__generated__"]);
const LOCKFILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"]);

export const REPOSITORY_USAGE_LIMITS = {
  maxFilesInspected: 24,
  maxFileSizeBytes: 50_000,
  maxMatchingFiles: 8,
  maxSnippetCharacters: 400,
  maxContextCharacters: 3_200,
  externalRequestTimeoutMs: 8_000,
} as const;

export type RepositoryDependencyUsage = {
  filePath: string;
  matchedReference: string;
  snippet: string;
};

export type RepositoryUsageContext = {
  inspectionStatus: "completed" | "unavailable";
  filesInspected: number;
  matchingFiles: number;
  usages: RepositoryDependencyUsage[];
};

type RepositoryDetails = { defaultBranch: string };
type CodeSearchResult = { path: string };
type RepositoryUsageFailureStage = "github_token" | "repository_access" | "code_search" | "response_parse" | "unknown";

class RepositoryUsageError extends Error {
  constructor(readonly stage: RepositoryUsageFailureStage, readonly httpStatus: number | null = null) {
    super(stage);
  }
}

export async function getRepositoryDependencyUsage(owner: string, repository: string, dependencyName: string): Promise<RepositoryUsageContext> {
  if (!isValidGitHubRepository(owner, repository) || !isSafeDependencyName(dependencyName)) return unavailableUsageContext();

  try {
    const accessToken = await getGitHubAccessTokenForCurrentUser();
    if (!accessToken) {
      logSafeUsageEvent("context_unavailable", { stage: "github_token" });
      return unavailableUsageContext();
    }

    // This request revalidates access before code search or file reads.
    const repositoryResponse = await fetchGitHubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, accessToken);
    if (!repositoryResponse.ok) {
      logSafeUsageEvent("context_unavailable", { stage: "repository_access", httpStatus: repositoryResponse.status, httpCategory: getHttpStatusCategory(repositoryResponse.status) });
      return unavailableUsageContext();
    }

    const repositoryDetails = parseRepositoryDetails(await repositoryResponse.json());
    if (!repositoryDetails) {
      logSafeUsageEvent("context_unavailable", { stage: "response_parse" });
      return unavailableUsageContext();
    }

    const candidatePaths = await findCandidateSourceFiles(owner, repository, dependencyName, accessToken);
    const inspectedFiles = await inspectCandidateFiles(candidatePaths, owner, repository, repositoryDetails.defaultBranch, dependencyName, accessToken);
    const usages = limitUsageContext(inspectedFiles);

    return {
      inspectionStatus: "completed",
      filesInspected: candidatePaths.length,
      matchingFiles: usages.length,
      usages,
    };
  } catch (error) {
    if (error instanceof RepositoryUsageError) {
      logSafeUsageEvent("context_unavailable", {
        stage: error.stage,
        httpStatus: error.httpStatus,
        httpCategory: error.httpStatus === null ? null : getHttpStatusCategory(error.httpStatus),
      });
    } else {
      logSafeUsageEvent("context_unavailable", { stage: "unknown", category: getRequestFailureCategory(error) });
    }
    return unavailableUsageContext();
  }
}

async function findCandidateSourceFiles(owner: string, repository: string, dependencyName: string, accessToken: string) {
  const searchUrl = new URL("/search/code", GITHUB_API_ORIGIN);
  searchUrl.searchParams.set("q", `${dependencyName} repo:${owner}/${repository}`);
  searchUrl.searchParams.set("per_page", String(REPOSITORY_USAGE_LIMITS.maxFilesInspected));

  const response = await fetch(searchUrl, {
    headers: githubHeaders(accessToken),
    cache: "no-store",
    signal: AbortSignal.timeout(REPOSITORY_USAGE_LIMITS.externalRequestTimeoutMs),
  });
  if (!response.ok) throw new RepositoryUsageError("code_search", response.status);

  const body: unknown = await response.json();
  if (!isRecord(body) || !Array.isArray(body.items)) throw new RepositoryUsageError("response_parse");

  const paths = new Set<string>();
  for (const item of body.items) {
    const result = parseCodeSearchResult(item);
    if (!result || !isInspectableSourcePath(result.path)) continue;
    paths.add(result.path);
    if (paths.size === REPOSITORY_USAGE_LIMITS.maxFilesInspected) break;
  }

  return [...paths];
}

async function inspectCandidateFiles(paths: string[], owner: string, repository: string, defaultBranch: string, dependencyName: string, accessToken: string) {
  const usages: RepositoryDependencyUsage[] = [];

  for (let index = 0; index < paths.length; index += 4) {
    const batch = paths.slice(index, index + 4);
    const results = await Promise.all(batch.map((path) => findDependencyUsageInFile(path, owner, repository, defaultBranch, dependencyName, accessToken)));
    for (const usage of results) {
      if (usage) usages.push(usage);
    }
  }

  return usages;
}

async function findDependencyUsageInFile(path: string, owner: string, repository: string, defaultBranch: string, dependencyName: string, accessToken: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await fetchGitHubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodedPath}?ref=${encodeURIComponent(defaultBranch)}`, accessToken);
  if (!response.ok) return null;

  const content = parseSourceContent(await response.json());
  if (!content || content.size > REPOSITORY_USAGE_LIMITS.maxFileSizeBytes) return null;

  const decoded = Buffer.from(content.base64, "base64");
  if (decoded.byteLength > REPOSITORY_USAGE_LIMITS.maxFileSizeBytes) return null;

  const source = decoded.toString("utf8");
  if (source.includes("\u0000")) return null;

  return findUsageInSource(path, source, dependencyName);
}

function findUsageInSource(filePath: string, source: string, dependencyName: string): RepositoryDependencyUsage | null {
  const patterns = getDependencyReferencePatterns(dependencyName);
  const lines = source.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;

      return {
        filePath,
        matchedReference: match[0].trim().slice(0, 240),
        snippet: getSnippet(lines, lineIndex),
      };
    }
  }

  return null;
}

function getDependencyReferencePatterns(dependencyName: string) {
  const specifier = `${escapeRegularExpression(dependencyName)}(?:/[A-Za-z0-9@._~/-]+)?`;
  return [
    new RegExp(`\\bimport\\s+(?:[^"']+?\\s+from\\s+)?["']${specifier}["']`),
    new RegExp(`\\brequire\\s*\\(\\s*["']${specifier}["']\\s*\\)`),
    new RegExp(`\\bimport\\s*\\(\\s*["']${specifier}["']\\s*\\)`),
  ];
}

function getSnippet(lines: string[], matchLineIndex: number) {
  const start = Math.max(0, matchLineIndex - 1);
  const end = Math.min(lines.length, matchLineIndex + 2);
  const snippet = lines.slice(start, end).join("\n").trim();
  return snippet.slice(0, REPOSITORY_USAGE_LIMITS.maxSnippetCharacters);
}

function limitUsageContext(usages: RepositoryDependencyUsage[]) {
  const limited: RepositoryDependencyUsage[] = [];
  let totalCharacters = 0;

  for (const usage of usages) {
    if (limited.length === REPOSITORY_USAGE_LIMITS.maxMatchingFiles) break;
    const characterCount = usage.filePath.length + usage.matchedReference.length + usage.snippet.length;
    if (totalCharacters + characterCount > REPOSITORY_USAGE_LIMITS.maxContextCharacters) break;
    limited.push(usage);
    totalCharacters += characterCount;
  }

  return limited;
}

async function fetchGitHubApi(path: string, accessToken: string) {
  return fetch(new URL(path, GITHUB_API_ORIGIN), {
    headers: githubHeaders(accessToken),
    cache: "no-store",
    signal: AbortSignal.timeout(REPOSITORY_USAGE_LIMITS.externalRequestTimeoutMs),
  });
}

function githubHeaders(accessToken: string) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "Sentinel",
    "X-GitHub-Api-Version": "2026-03-10",
  };
}

function parseRepositoryDetails(value: unknown): RepositoryDetails | null {
  return isRecord(value) && typeof value.default_branch === "string" ? { defaultBranch: value.default_branch } : null;
}

function parseCodeSearchResult(value: unknown): CodeSearchResult | null {
  return isRecord(value) && typeof value.path === "string" ? { path: value.path } : null;
}

function parseSourceContent(value: unknown) {
  if (!isRecord(value) || value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string" || typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) return null;
  return { base64: value.content, size: value.size };
}

function isInspectableSourcePath(path: string) {
  const segments = path.split("/");
  const basename = segments.at(-1)?.toLowerCase();
  if (!basename || segments.some((segment) => !segment || segment === "." || segment === ".." || EXCLUDED_DIRECTORIES.has(segment.toLowerCase()))) return false;
  if (basename.startsWith(".env") || LOCKFILE_NAMES.has(basename) || basename.includes(".min.") || basename.includes(".generated.") || basename.endsWith(".d.ts")) return false;

  const extension = basename.split(".").at(-1);
  return !!extension && SOURCE_EXTENSIONS.has(extension);
}

function isSafeDependencyName(value: string) {
  return value.length > 0 && value.length <= 214 && /^[a-zA-Z0-9@._/-]+$/.test(value);
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unavailableUsageContext(): RepositoryUsageContext {
  return { inspectionStatus: "unavailable", filesInspected: 0, matchingFiles: 0, usages: [] };
}

function getHttpStatusCategory(status: number) {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unexpected_http_status";
}

function getRequestFailureCategory(error: unknown) {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "network_or_response_error";
}

function logSafeUsageEvent(event: string, details: Record<string, string | number | null>) {
  console.error("[sentinel:repository-usage]", event, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
