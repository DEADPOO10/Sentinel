import "server-only";

import semver from "semver";
import { getGitHubAccessTokenForCurrentUser } from "@/lib/github/repositories";
import { isValidGitHubRepository } from "@/lib/github/package-json";
import type { ReleaseChangeType } from "@/lib/npm/dependency-versions";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org/";
const GITHUB_API_ORIGIN = "https://api.github.com/";
const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com/";
const CHANGELOG_PATHS = ["CHANGELOG.md", "CHANGELOG", "HISTORY.md", "HISTORY"];

export const RELEASE_INFORMATION_LIMITS = {
  maxReleasesExamined: 12,
  maxChangelogBytesFetched: 60_000,
  maxReleaseNoteCharacters: 3_600,
  externalRequestTimeoutMs: 8_000,
  maxNpmMetadataBytes: 1_000_000,
  maxGitHubReleaseResponseBytes: 120_000,
} as const;

export type ReleaseEvidence = {
  title: string;
  tag: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  hasBreakingChangeIndicator: boolean;
  hasMigrationIndicator: boolean;
};

export type ReleaseInformationContext = {
  availability: "available" | "unavailable";
  source: "npm-metadata" | "github-releases" | "changelog" | "unavailable";
  packageName: string;
  declaredVersionRange: string;
  baseVersion: string | null;
  latestVersion: string;
  changeType: ReleaseChangeType;
  latestPublishedAt: string | null;
  releasesExamined: number;
  breakingChangeIndicators: number;
  migrationIndicators: number;
  evidence: ReleaseEvidence[];
};

type ReleaseInformationInput = {
  packageName: string;
  declaredVersionRange: string;
  latestVersion: string;
  changeType: ReleaseChangeType;
  latestPublishedAt: string | null;
};

type NpmMetadata = {
  repository: GitHubRepositoryReference | null;
  releases: ReleaseEvidence[];
};

type GitHubRepositoryReference = { owner: string; repository: string };

export async function getReleaseInformation(input: ReleaseInformationInput): Promise<ReleaseInformationContext> {
  const baseVersion = getBaseVersion(input.declaredVersionRange);
  const unavailable = createUnavailableContext(input, baseVersion);
  if (!baseVersion || !semver.valid(input.latestVersion) || semver.prerelease(input.latestVersion)) return unavailable;

  try {
    const npmMetadata = await getNpmMetadata(input, baseVersion);
    if (!npmMetadata) return unavailable;

    let githubToken: string | null = null;
    try {
      githubToken = await getGitHubAccessTokenForCurrentUser();
    } catch (error) {
      logSafeReleaseEvent("release_context_unavailable", { stage: "github_token", category: getFailureCategory(error) });
    }

    if (githubToken && npmMetadata.repository) {
      const githubReleaseEvidence = await getGitHubReleaseEvidence(npmMetadata.repository, baseVersion, input.latestVersion, githubToken);
      if (githubReleaseEvidence.some((release) => release.excerpt)) return createAvailableContext(input, baseVersion, "github-releases", githubReleaseEvidence);

      const changelogEvidence = await getChangelogEvidence(npmMetadata.repository, baseVersion, input.latestVersion, githubToken);
      if (changelogEvidence.length > 0) return createAvailableContext(input, baseVersion, "changelog", changelogEvidence);
      if (githubReleaseEvidence.length > 0) return createAvailableContext(input, baseVersion, "github-releases", githubReleaseEvidence);
    }

    return npmMetadata.releases.length > 0 ? createAvailableContext(input, baseVersion, "npm-metadata", npmMetadata.releases) : unavailable;
  } catch (error) {
    logSafeReleaseEvent("release_context_unavailable", { stage: "release_information", category: getFailureCategory(error) });
    return unavailable;
  }
}

async function getNpmMetadata(input: ReleaseInformationInput, baseVersion: string): Promise<NpmMetadata | null> {
  try {
    const response = await fetch(new URL(encodeURIComponent(input.packageName), NPM_REGISTRY_ORIGIN), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(RELEASE_INFORMATION_LIMITS.externalRequestTimeoutMs),
    });
    if (!response.ok) {
      logSafeReleaseEvent("release_context_unavailable", { stage: "npm_metadata", httpStatus: response.status, httpCategory: getHttpStatusCategory(response.status) });
      return null;
    }

    const metadata = parseJson(await readBoundedText(response, RELEASE_INFORMATION_LIMITS.maxNpmMetadataBytes));
    if (!isRecord(metadata)) {
      logSafeReleaseEvent("release_context_unavailable", { stage: "npm_metadata_parse" });
      return null;
    }

    return {
      repository: getGitHubRepositoryReference(metadata.repository),
      releases: getNpmReleaseEvidence(metadata, baseVersion, input.latestVersion),
    };
  } catch (error) {
    logSafeReleaseEvent("release_context_unavailable", { stage: "npm_metadata", category: getFailureCategory(error) });
    return null;
  }
}

function getNpmReleaseEvidence(metadata: Record<string, unknown>, baseVersion: string, latestVersion: string) {
  if (!isRecord(metadata.time)) return [];

  const releases = Object.entries(metadata.time).flatMap(([version, publishedAt]) => {
    if (typeof publishedAt !== "string" || !isVersionInUpgradePath(version, baseVersion, latestVersion) || !isValidDate(publishedAt)) return [];
    return [{
      title: `npm ${version}`,
      tag: `v${version}`,
      publishedAt,
      excerpt: null,
      hasBreakingChangeIndicator: false,
      hasMigrationIndicator: false,
    }];
  });

  return releases.sort((left, right) => Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? "")).slice(0, RELEASE_INFORMATION_LIMITS.maxReleasesExamined);
}

async function getGitHubReleaseEvidence(source: GitHubRepositoryReference, baseVersion: string, latestVersion: string, accessToken: string) {
  try {
    const releasesUrl = new URL(`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}/releases`, GITHUB_API_ORIGIN);
    releasesUrl.searchParams.set("per_page", String(RELEASE_INFORMATION_LIMITS.maxReleasesExamined));
    const response = await fetch(releasesUrl, {
      headers: githubHeaders(accessToken),
      cache: "no-store",
      signal: AbortSignal.timeout(RELEASE_INFORMATION_LIMITS.externalRequestTimeoutMs),
    });
    if (!response.ok) {
      logSafeReleaseEvent("release_context_unavailable", { stage: "github_releases", httpStatus: response.status, httpCategory: getHttpStatusCategory(response.status) });
      return [];
    }

    const body = parseJson(await readBoundedText(response, RELEASE_INFORMATION_LIMITS.maxGitHubReleaseResponseBytes));
    if (!Array.isArray(body)) {
      logSafeReleaseEvent("release_context_unavailable", { stage: "github_releases_parse" });
      return [];
    }

    return limitEvidence(body.flatMap((release) => parseGitHubRelease(release, baseVersion, latestVersion)));
  } catch (error) {
    logSafeReleaseEvent("release_context_unavailable", { stage: "github_releases", category: getFailureCategory(error) });
    return [];
  }
}

function parseGitHubRelease(value: unknown, baseVersion: string, latestVersion: string) {
  if (!isRecord(value) || value.draft === true || typeof value.tag_name !== "string") return [];
  const version = semver.valid(value.tag_name);
  if (!version || semver.prerelease(version) || !isVersionInUpgradePath(version, baseVersion, latestVersion)) return [];

  const body = typeof value.body === "string" ? value.body : "";
  return [{
    title: typeof value.name === "string" && value.name.trim() ? truncateText(value.name.trim(), 160) : value.tag_name,
    tag: value.tag_name,
    publishedAt: typeof value.published_at === "string" && isValidDate(value.published_at) ? value.published_at : null,
    excerpt: createExcerpt(body),
    hasBreakingChangeIndicator: hasBreakingChangeIndicator(body),
    hasMigrationIndicator: hasMigrationIndicator(body),
  }];
}

async function getChangelogEvidence(source: GitHubRepositoryReference, baseVersion: string, latestVersion: string, accessToken: string) {
  const defaultBranch = await getDefaultBranch(source, accessToken);
  if (!defaultBranch) return [];

  for (const path of CHANGELOG_PATHS) {
    try {
      const response = await fetchChangelogRange(source, defaultBranch, path, accessToken);
      if (response.status === 404) continue;
      if (!response.ok) {
        logSafeReleaseEvent("release_context_unavailable", { stage: "changelog", httpStatus: response.status, httpCategory: getHttpStatusCategory(response.status) });
        return [];
      }

      return limitEvidence(extractChangelogEvidence(await readBoundedText(response, RELEASE_INFORMATION_LIMITS.maxChangelogBytesFetched), baseVersion, latestVersion));
    } catch (error) {
      logSafeReleaseEvent("release_context_unavailable", { stage: "changelog", category: getFailureCategory(error) });
      return [];
    }
  }

  return [];
}

function extractChangelogEvidence(changelog: string, baseVersion: string, latestVersion: string) {
  if (changelog.includes("\u0000")) return [];

  const lines = changelog.split(/\r?\n/);
  const evidence: ReleaseEvidence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const version = getVersionFromHeading(lines[index]);
    if (!version || !isVersionInUpgradePath(version, baseVersion, latestVersion)) continue;

    const sectionLines: string[] = [];
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      if (getVersionFromHeading(lines[nextIndex])) break;
      sectionLines.push(lines[nextIndex]);
    }

    const section = sectionLines.join("\n");
    evidence.push({
      title: `Changelog ${version}`,
      tag: `v${version}`,
      publishedAt: null,
      excerpt: createExcerpt(section),
      hasBreakingChangeIndicator: hasBreakingChangeIndicator(section),
      hasMigrationIndicator: hasMigrationIndicator(section),
    });
    if (evidence.length === RELEASE_INFORMATION_LIMITS.maxReleasesExamined) break;
  }

  return evidence;
}

function getVersionFromHeading(line: string) {
  const match = line.match(/^#{1,6}\s+(?:\[)?v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\])?/i);
  return match ? semver.valid(match[1]) : null;
}

function createAvailableContext(input: ReleaseInformationInput, baseVersion: string, source: ReleaseInformationContext["source"], evidence: ReleaseEvidence[]): ReleaseInformationContext {
  return {
    availability: "available",
    source,
    packageName: input.packageName,
    declaredVersionRange: input.declaredVersionRange,
    baseVersion,
    latestVersion: input.latestVersion,
    changeType: input.changeType,
    latestPublishedAt: input.latestPublishedAt,
    releasesExamined: evidence.length,
    breakingChangeIndicators: evidence.filter((release) => release.hasBreakingChangeIndicator).length,
    migrationIndicators: evidence.filter((release) => release.hasMigrationIndicator).length,
    evidence,
  };
}

function createUnavailableContext(input: ReleaseInformationInput, baseVersion: string | null): ReleaseInformationContext {
  return {
    availability: "unavailable",
    source: "unavailable",
    packageName: input.packageName,
    declaredVersionRange: input.declaredVersionRange,
    baseVersion,
    latestVersion: input.latestVersion,
    changeType: input.changeType,
    latestPublishedAt: input.latestPublishedAt,
    releasesExamined: 0,
    breakingChangeIndicators: 0,
    migrationIndicators: 0,
    evidence: [],
  };
}

function limitEvidence(evidence: ReleaseEvidence[]) {
  const limited: ReleaseEvidence[] = [];
  let characterCount = 0;

  for (const release of evidence) {
    if (limited.length === RELEASE_INFORMATION_LIMITS.maxReleasesExamined) break;
    const releaseCharacterCount = release.title.length + (release.tag?.length ?? 0) + (release.excerpt?.length ?? 0);
    if (characterCount + releaseCharacterCount > RELEASE_INFORMATION_LIMITS.maxReleaseNoteCharacters) break;
    limited.push(release);
    characterCount += releaseCharacterCount;
  }

  return limited;
}

function createExcerpt(value: string) {
  const normalized = value.replace(/[`*_>#]/g, "").replace(/\s+/g, " ").trim();
  return normalized ? truncateText(normalized, 700) : null;
}

function truncateText(value: string, maximumLength: number) {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1).trimEnd()}…`;
}

function hasBreakingChangeIndicator(value: string) {
  return /\b(?:breaking(?:\s+changes?)?|backwards?[-\s]?incompatible|incompatible)\b/i.test(value);
}

function hasMigrationIndicator(value: string) {
  return /\b(?:migration|migrate|migration guide|upgrade guide|codemod)\b/i.test(value);
}

function getBaseVersion(range: string) {
  const minimumVersion = semver.minVersion(range);
  return minimumVersion && !semver.prerelease(minimumVersion.version) ? minimumVersion.version : null;
}

function isVersionInUpgradePath(version: string, baseVersion: string, latestVersion: string) {
  const stableVersion = semver.valid(version);
  return !!stableVersion && !semver.prerelease(stableVersion) && semver.gt(stableVersion, baseVersion) && (stableVersion === latestVersion || !semver.gt(stableVersion, latestVersion));
}

function getGitHubRepositoryReference(value: unknown): GitHubRepositoryReference | null {
  const url = typeof value === "string" ? value : isRecord(value) && typeof value.url === "string" ? value.url : null;
  if (!url) return null;

  const shorthand = url.match(/^(?:github:)?([A-Za-z\d-]+)\/([A-Za-z\d._-]+?)(?:\.git)?$/i);
  const githubUrl = url.match(/github\.com[/:]([A-Za-z\d-]+)\/([A-Za-z\d._-]+?)(?:\.git)?(?:[/?#].*)?$/i);
  const match = shorthand ?? githubUrl;
  if (!match || !isValidGitHubRepository(match[1], match[2])) return null;

  return { owner: match[1], repository: match[2] };
}

async function getDefaultBranch(source: GitHubRepositoryReference, accessToken: string) {
  try {
    const response = await fetch(new URL(`/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repository)}`, GITHUB_API_ORIGIN), {
      headers: githubHeaders(accessToken),
      cache: "no-store",
      signal: AbortSignal.timeout(RELEASE_INFORMATION_LIMITS.externalRequestTimeoutMs),
    });
    if (!response.ok) {
      logSafeReleaseEvent("release_context_unavailable", { stage: "github_default_branch", httpStatus: response.status, httpCategory: getHttpStatusCategory(response.status) });
      return null;
    }
    const body = parseJson(await readBoundedText(response, 20_000));
    if (!isRecord(body) || typeof body.default_branch !== "string") {
      logSafeReleaseEvent("release_context_unavailable", { stage: "github_default_branch_parse" });
      return null;
    }
    return body.default_branch;
  } catch (error) {
    logSafeReleaseEvent("release_context_unavailable", { stage: "github_default_branch", category: getFailureCategory(error) });
    return null;
  }
}

async function fetchChangelogRange(source: GitHubRepositoryReference, defaultBranch: string, path: string, accessToken: string) {
  const rawPath = [source.owner, source.repository, defaultBranch, path].map(encodeURIComponent).join("/");
  return fetch(new URL(rawPath, GITHUB_RAW_ORIGIN), {
    headers: { ...githubHeaders(accessToken), Range: `bytes=0-${RELEASE_INFORMATION_LIMITS.maxChangelogBytesFetched - 1}` },
    cache: "no-store",
    signal: AbortSignal.timeout(RELEASE_INFORMATION_LIMITS.externalRequestTimeoutMs),
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

async function readBoundedText(response: Response, maximumBytes: number) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) throw new Error("Response exceeded the configured size limit");

  const reader = response.body?.getReader();
  if (!reader) throw new Error("Response body was unavailable");

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      throw new Error("Response exceeded the configured size limit");
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isValidDate(value: string) {
  return Number.isFinite(Date.parse(value));
}

function getHttpStatusCategory(status: number) {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unexpected_http_status";
}

function getFailureCategory(error: unknown) {
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
  return "network_or_response_error";
}

function logSafeReleaseEvent(event: string, details: Record<string, string | number | null>) {
  console.error("[sentinel:release-information]", event, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
