import semver from "semver";
import type { PackageDependency, PackageManifest } from "@/lib/github/package-json";
import { getLatestNpmPackageMetadata } from "@/lib/npm/registry";

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
  const startedAt = Date.now();
  const packageNames = [...new Set(manifest.dependencies.filter((dependency) => isSupportedSemverRange(dependency.version)).map((dependency) => dependency.name))];
  const releaseLookups = await mapWithConcurrency(packageNames, MAX_CONCURRENT_REQUESTS, async (packageName) => [packageName, await getLatestNpmPackageMetadata(packageName)] as const);
  const releases = new Map(releaseLookups.map(([packageName, lookup]) => [packageName, lookup.metadata] as const));
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

  logVersionIntelligenceDiagnostics({
    dependencyCount: manifest.dependencies.length,
    supportedPackageCount: packageNames.length,
    npmRequests: releaseLookups.filter(([, lookup]) => lookup.source === "network").length,
    cacheHits: releaseLookups.filter(([, lookup]) => lookup.source !== "network").length,
    durationMs: Date.now() - startedAt,
  });

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

function logVersionIntelligenceDiagnostics(details: {
  dependencyCount: number;
  supportedPackageCount: number;
  npmRequests: number;
  cacheHits: number;
  durationMs: number;
}) {
  if (process.env.NODE_ENV !== "production") {
    console.info("[sentinel:npm] version_intelligence_completed", details);
  }
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
