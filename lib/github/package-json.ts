import { getGitHubAccessTokenForCurrentUser } from "@/lib/github/repositories";
import { checkDependencyVersions, type CheckedPackageManifest } from "@/lib/npm/dependency-versions";

const GITHUB_API_ORIGIN = "https://api.github.com/";
const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
const GITHUB_OWNER_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z\d][A-Za-z\d._-]{0,99}$/;

export type GitHubRepositoryDetails = {
  githubRepositoryId: number;
  name: string;
  owner: string;
  fullName: string;
  visibility: "public" | "private" | "internal";
  defaultBranch: string;
  language: string | null;
  githubUrl: string;
  baseCommitSha: string | null;
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
  | { kind: "ready"; repository: GitHubRepositoryDetails; manifest: CheckedPackageManifest }
  | { kind: "no-package-json"; repository: GitHubRepositoryDetails }
  | { kind: "invalid-package-json"; repository: GitHubRepositoryDetails }
  | { kind: "not-found" }
  | { kind: "error"; error: string };

export type GitHubPackageManifestResult =
  | { kind: "ready"; repository: GitHubRepositoryDetails; manifest: PackageManifest }
  | { kind: "no-package-json"; repository: GitHubRepositoryDetails }
  | { kind: "invalid-package-json"; repository: GitHubRepositoryDetails }
  | { kind: "not-found" }
  | { kind: "error"; error: string };

export type GitHubRepositoryDetailsResult =
  | { kind: "ready"; repository: GitHubRepositoryDetails }
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
  const result = await getGitHubPackageManifest(owner, repository);
  if (result.kind !== "ready") return result;

  return {
    kind: "ready",
    repository: result.repository,
    manifest: await checkDependencyVersions(result.manifest),
  };
}

/**
 * Fetches only the repository and package.json data needed to render the
 * repository shell. Version intelligence intentionally happens separately so
 * a slow npm response cannot block the first useful page content.
 */
export async function getGitHubPackageManifest(owner: string, repository: string): Promise<GitHubPackageManifestResult> {
  const repositoryResult = await getGitHubRepositoryDetails(owner, repository);
  if (repositoryResult.kind !== "ready") return repositoryResult;

  return getGitHubPackageManifestForRepository(repositoryResult.repository);
}

/**
 * Uses the current user's GitHub token to verify access and return the small
 * repository identity needed for the first useful page content. Package and
 * commit reads deliberately remain a later stage so the header can stream.
 */
export async function getGitHubRepositoryDetails(owner: string, repository: string): Promise<GitHubRepositoryDetailsResult> {
  if (!isValidGitHubRepository(owner, repository)) return { kind: "not-found" };

  const accessToken = await getGitHubAccessTokenForCurrentUser();
  if (!accessToken) return { kind: "error", error: "Your GitHub authorization needs to be refreshed. Sign out, then connect GitHub again." };

  try {
    const repositoryResponse = await fetchGitHubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, accessToken);
    if (repositoryResponse.status === 404) return { kind: "not-found" };
    if (!repositoryResponse.ok) throw new GitHubApiError(repositoryResponse.status);

    const repositoryDetails = parseRepositoryDetails(await repositoryResponse.json(), owner, repository);
    if (!repositoryDetails) throw new GitHubApiError(repositoryResponse.status);

    return { kind: "ready", repository: repositoryDetails };
  } catch (error) {
    return { kind: "error", error: getUserFacingError(error) };
  }
}

/** Fetches the commit-pinned package manifest after repository access is verified. */
export async function getGitHubPackageManifestForRepository(repository: GitHubRepositoryDetails): Promise<GitHubPackageManifestResult> {
  if (!isVerifiedRepositoryDetails(repository)) return { kind: "not-found" };

  const accessToken = await getGitHubAccessTokenForCurrentUser();
  if (!accessToken) return { kind: "error", error: "Your GitHub authorization needs to be refreshed. Sign out, then connect GitHub again." };

  try {
    const repositoryDetails = { ...repository };

    // Keep the content tied to the exact commit recorded for the scan. Reading
    // both from a moving branch concurrently could persist findings against a
    // different revision when a push lands between the two GitHub requests.
    const baseCommitSha = await getDefaultBranchCommitSha(repositoryDetails.owner, repositoryDetails.name, repositoryDetails.defaultBranch, accessToken);
    repositoryDetails.baseCommitSha = baseCommitSha;

    const packageJsonResponse = await fetchGitHubApi(`/repos/${encodeURIComponent(repositoryDetails.owner)}/${encodeURIComponent(repositoryDetails.name)}/contents/package.json?ref=${encodeURIComponent(baseCommitSha ?? repositoryDetails.defaultBranch)}`, accessToken);

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
    signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
  });
}

function parseRepositoryDetails(value: unknown, requestedOwner: string, requestedRepository: string): GitHubRepositoryDetails | null {
  if (!isRecord(value) || typeof value.id !== "number" || !Number.isSafeInteger(value.id) || value.id <= 0 || typeof value.name !== "string" || !isRecord(value.owner) || typeof value.owner.login !== "string" || typeof value.full_name !== "string" || typeof value.default_branch !== "string" || typeof value.html_url !== "string") return null;

  const owner = value.owner.login;
  const name = value.name;
  const visibility = value.visibility === "public" || value.visibility === "private" || value.visibility === "internal" ? value.visibility : value.private === true ? "private" : value.private === false ? "public" : null;
  const fullName = value.full_name;
  if (!visibility || !isValidGitHubRepository(owner, name) || !sameGitHubIdentifier(owner, requestedOwner) || !sameGitHubIdentifier(name, requestedRepository) || fullName !== `${owner}/${name}` || !isSafeGitReference(value.default_branch) || !isMatchingGitHubUrl(value.html_url, fullName)) return null;

  return { githubRepositoryId: value.id, name, owner, fullName, visibility, defaultBranch: value.default_branch, language: typeof value.language === "string" && value.language.trim().length > 0 && value.language.length <= 100 ? value.language.trim() : null, githubUrl: value.html_url, baseCommitSha: null };
}

async function getDefaultBranchCommitSha(owner: string, repository: string, defaultBranch: string, accessToken: string) {
  try {
    const response = await fetchGitHubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, accessToken);
    if (!response.ok) return null;

    const value: unknown = await response.json();
    return isRecord(value) && isRecord(value.object) && value.object.type === "commit" && typeof value.object.sha === "string" && /^[a-f\d]{40,64}$/i.test(value.object.sha)
      ? value.object.sha
      : null;
  } catch {
    return null;
  }
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

function isSafeGitReference(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value) && !value.includes("..") && !value.includes("//") && !value.endsWith("/");
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

function isVerifiedRepositoryDetails(value: GitHubRepositoryDetails) {
  return Number.isSafeInteger(value.githubRepositoryId)
    && value.githubRepositoryId > 0
    && isValidGitHubRepository(value.owner, value.name)
    && value.fullName === `${value.owner}/${value.name}`
    && (value.visibility === "public" || value.visibility === "private" || value.visibility === "internal")
    && isSafeGitReference(value.defaultBranch)
    && isMatchingGitHubUrl(value.githubUrl, value.fullName)
    && (value.language === null || (typeof value.language === "string" && value.language.length <= 100));
}

function getUserFacingError(error: unknown) {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "GitHub rejected this authorization. Sign out, then connect GitHub again.";
    if (error.status === 403 || error.status === 429) return "GitHub cannot serve this repository right now. Please try again shortly.";
  }

  return "GitHub is unavailable right now. Please try again shortly.";
}
