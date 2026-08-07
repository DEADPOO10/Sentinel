import semver from "semver";
import type { PackageDependency, PackageManifest } from "@/lib/github/package-json";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org/";
const MAX_CONCURRENT_REQUESTS = 8;

export type DependencyStatus = "up-to-date" | "update-available" | "ahead-of-npm-latest" | "unknown";
export type ReleaseChangeType = "major" | "minor" | "patch";
export type ReleaseRisk = "low" | "medium" | "high";

export type CheckedPackageDependency = PackageDependency & {
  latestVersion: string | null;
  publishedAt: string | null;
  changeType: ReleaseChangeType | null;
  risk: ReleaseRisk | null;
  status: DependencyStatus;
};

export type CheckedPackageManifest = Omit<PackageManifest, "dependencies"> & {
  dependencies: CheckedPackageDependency[];
  summary: {
    total: number;
    upToDate: number;
    updatesAvailable: number;
    aheadOfNpmLatest: number;
    unknown: number;
    majorUpdates: number;
    minorUpdates: number;
    patchUpdates: number;
    highRiskUpdates: number;
  };
};

export async function checkDependencyVersions(manifest: PackageManifest): Promise<CheckedPackageManifest> {
  const packageNames = [...new Set(manifest.dependencies.filter((dependency) => isSupportedSemverRange(dependency.version)).map((dependency) => dependency.name))];
  const releases = new Map(await mapWithConcurrency(packageNames, MAX_CONCURRENT_REQUESTS, async (packageName) => [packageName, await getLatestStableRelease(packageName)] as const));
  const dependencies = manifest.dependencies.map((dependency) => checkDependency(dependency, releases.get(dependency.name) ?? null));
  const summary = dependencies.reduce((counts, dependency) => {
    if (dependency.status === "up-to-date") counts.upToDate += 1;
    if (dependency.status === "update-available") counts.updatesAvailable += 1;
    if (dependency.status === "ahead-of-npm-latest") counts.aheadOfNpmLatest += 1;
    if (dependency.status === "unknown") counts.unknown += 1;
    if (dependency.changeType === "major") counts.majorUpdates += 1;
    if (dependency.changeType === "minor") counts.minorUpdates += 1;
    if (dependency.changeType === "patch") counts.patchUpdates += 1;
    if (dependency.risk === "high") counts.highRiskUpdates += 1;
    return counts;
  }, { total: dependencies.length, upToDate: 0, updatesAvailable: 0, aheadOfNpmLatest: 0, unknown: 0, majorUpdates: 0, minorUpdates: 0, patchUpdates: 0, highRiskUpdates: 0 });

  return { ...manifest, dependencies, summary };
}

function checkDependency(dependency: PackageDependency, release: NpmRelease | null): CheckedPackageDependency {
  if (!isSupportedSemverRange(dependency.version) || !release) {
    return createCheckedDependency(dependency, null, null, null, null, "unknown");
  }

  const minimumDeclaredVersion = semver.minVersion(dependency.version);
  if (!minimumDeclaredVersion) {
    return createCheckedDependency(dependency, release.latestVersion, release.publishedAt, null, null, "unknown");
  }

  if (semver.satisfies(release.latestVersion, dependency.version, { includePrerelease: false })) {
    return createCheckedDependency(dependency, release.latestVersion, release.publishedAt, null, null, "up-to-date");
  }

  if (semver.gt(minimumDeclaredVersion.version, release.latestVersion)) {
    return createCheckedDependency(dependency, release.latestVersion, release.publishedAt, null, null, "ahead-of-npm-latest");
  }

  const changeType = getChangeType(minimumDeclaredVersion.version, release.latestVersion);
  if (!changeType) return createCheckedDependency(dependency, release.latestVersion, release.publishedAt, null, null, "unknown");

  return createCheckedDependency(dependency, release.latestVersion, release.publishedAt, changeType, getRisk(changeType), "update-available");
}

function createCheckedDependency(dependency: PackageDependency, latestVersion: string | null, publishedAt: string | null, changeType: ReleaseChangeType | null, risk: ReleaseRisk | null, status: DependencyStatus): CheckedPackageDependency {
  return { ...dependency, latestVersion, publishedAt, changeType, risk, status };
}

function getChangeType(currentVersion: string, latestVersion: string): ReleaseChangeType | null {
  if (semver.major(latestVersion) !== semver.major(currentVersion)) return "major";
  if (semver.minor(latestVersion) !== semver.minor(currentVersion)) return "minor";
  if (semver.patch(latestVersion) !== semver.patch(currentVersion)) return "patch";
  return null;
}

function getRisk(changeType: ReleaseChangeType): ReleaseRisk {
  if (changeType === "major") return "high";
  if (changeType === "minor") return "medium";
  return "low";
}

function isSupportedSemverRange(version: string) {
  const value = version.trim();
  if (!value || /^(?:workspace|file|link|git|github|gitlab|bitbucket|npm):/i.test(value)) return false;
  if (/^(?:https?:|ssh:|git\+|git@)/i.test(value)) return false;
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)) return false;

  return semver.validRange(value) !== null;
}

type NpmRelease = { latestVersion: string; publishedAt: string | null };

async function getLatestStableRelease(packageName: string): Promise<NpmRelease | null> {
  try {
    const response = await fetch(new URL(encodeURIComponent(packageName), NPM_REGISTRY_ORIGIN), {
      headers: { Accept: "application/json" },
      next: { revalidate: 3600 },
    });
    if (!response.ok) return null;

    const metadata: unknown = await response.json();
    const latestVersion = getLatestDistTag(metadata);
    if (!latestVersion || semver.prerelease(latestVersion)) return null;

    const stableVersion = semver.valid(latestVersion);
    if (!stableVersion) return null;

    return { latestVersion: stableVersion, publishedAt: getPublishedAt(metadata, latestVersion) };
  } catch {
    return null;
  }
}

function getLatestDistTag(metadata: unknown) {
  if (!isRecord(metadata)) return null;

  const distTags = metadata["dist-tags"];
  if (!isRecord(distTags)) return null;

  return typeof distTags.latest === "string" ? distTags.latest : null;
}

function getPublishedAt(metadata: unknown, version: string) {
  if (!isRecord(metadata) || !isRecord(metadata.time)) return null;

  const publishedAt = metadata.time[version];
  return typeof publishedAt === "string" && Number.isFinite(Date.parse(publishedAt)) ? publishedAt : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mapWithConcurrency<T, Result>(items: T[], concurrency: number, mapper: (item: T) => Promise<Result>) {
  const results: Result[] = Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
