import { getGitHubAccessTokenForCurrentUser } from "@/lib/github/repositories";

const GITHUB_API_ORIGIN = "https://api.github.com/";
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z\d][A-Za-z\d._-]{0,99}$/;

export type GitHubRepositoryDetails = {
  name: string;
  owner: string;
  defaultBranch: string;
};

export type PackageDependency = {
  name: string;
  version: string;
  type: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
};

export type PackageManifest = {
  name: string | null;
  version: string | null;
  dependencies: PackageDependency[];
};

export type GitHubPackageJsonResult =
  | { kind: "ready"; repository: GitHubRepositoryDetails; manifest: PackageManifest }
  | { kind: "no-package-json"; repository: GitHubRepositoryDetails }
  | { kind: "invalid-package-json"; repository: GitHubRepositoryDetails }
  | { kind: "not-found" }
  | { kind: "error"; error: string };

type DependencyType = PackageDependency["type"];

class GitHubApiError extends Error {
  constructor(public readonly status: number) {
    super("GitHub package.json request failed");
  }
}

export function isValidGitHubRepository(owner: string, repository: string) {
  return GITHUB_OWNER_PATTERN.test(owner) && GITHUB_REPOSITORY_PATTERN.test(repository);
}

export async function getGitHubPackageJson(owner: string, repository: string): Promise<GitHubPackageJsonResult> {
  if (!isValidGitHubRepository(owner, repository)) return { kind: "not-found" };

  const accessToken = await getGitHubAccessTokenForCurrentUser();
  if (!accessToken) {
    return { kind: "error", error: "Your GitHub authorization needs to be refreshed. Sign out, then connect GitHub again." };
  }

  try {
    const repositoryResponse = await fetchGitHubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, accessToken);
    if (repositoryResponse.status === 404) return { kind: "not-found" };
    if (!repositoryResponse.ok) throw new GitHubApiError(repositoryResponse.status);

    const repositoryDetails = parseRepositoryDetails(await repositoryResponse.json());
    if (!repositoryDetails) throw new GitHubApiError(repositoryResponse.status);

    const packageJsonResponse = await fetchGitHubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/package.json?ref=${encodeURIComponent(repositoryDetails.defaultBranch)}`, accessToken);
    if (packageJsonResponse.status === 404) return { kind: "no-package-json", repository: repositoryDetails };
    if (!packageJsonResponse.ok) throw new GitHubApiError(packageJsonResponse.status);

    const packageJsonContent = parseContentResponse(await packageJsonResponse.json());
    if (!packageJsonContent) return { kind: "no-package-json", repository: repositoryDetails };

    const manifest = parsePackageManifest(packageJsonContent);
    return manifest ? { kind: "ready", repository: repositoryDetails, manifest } : { kind: "invalid-package-json", repository: repositoryDetails };
  } catch (error) {
    return { kind: "error", error: getUserFacingError(error) };
  }
}

async function fetchGitHubApi(path: string, accessToken: string) {
  return fetch(new URL(path, GITHUB_API_ORIGIN), {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "Sentinel",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    cache: "no-store",
  });
}

function parseRepositoryDetails(value: unknown): GitHubRepositoryDetails | null {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.owner) || typeof value.owner.login !== "string" || typeof value.default_branch !== "string") return null;

  return { name: value.name, owner: value.owner.login, defaultBranch: value.default_branch };
}

function parseContentResponse(value: unknown) {
  if (!isRecord(value) || value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string") return null;

  return value.content;
}

function parsePackageManifest(encodedContent: string): PackageManifest | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(encodedContent, "base64").toString("utf8").replace(/^\uFEFF/, ""));
    if (!isRecord(value)) return { name: null, version: null, dependencies: [] };

    return {
      name: typeof value.name === "string" ? value.name : null,
      version: typeof value.version === "string" ? value.version : null,
      dependencies: [
        ...parseDependencies(value.dependencies, "dependency"),
        ...parseDependencies(value.devDependencies, "devDependency"),
        ...parseDependencies(value.peerDependencies, "peerDependency"),
        ...parseDependencies(value.optionalDependencies, "optionalDependency"),
      ].sort((left, right) => left.name.localeCompare(right.name) || left.type.localeCompare(right.type)),
    };
  } catch {
    return null;
  }
}

function parseDependencies(value: unknown, type: DependencyType): PackageDependency[] {
  if (!isRecord(value)) return [];

  return Object.entries(value).flatMap(([name, version]) => typeof version === "string" ? [{ name, version, type }] : []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getUserFacingError(error: unknown) {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "GitHub rejected this authorization. Sign out, then connect GitHub again.";
    if (error.status === 403 || error.status === 429) return "GitHub cannot serve this repository right now. Please try again shortly.";
  }

  return "GitHub is unavailable right now. Please try again shortly.";
}
