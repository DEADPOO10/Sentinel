import semver from "semver";
import type { PackageDependency, PackageManifest } from "@/lib/github/package-json";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org/";
const MAX_CONCURRENT_REQUESTS = 8;

export type DependencyStatus = "up-to-date" | "update-available" | "ahead-of-npm-latest" | "unknown";

export type CheckedPackageDependency = PackageDependency & {
  latestVersion: string | null;
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
  };
};

export async function checkDependencyVersions(manifest: PackageManifest): Promise<CheckedPackageManifest> {
  const packageNames = [...new Set(manifest.dependencies.filter((dependency) => isSupportedSemverRange(dependency.version)).map((dependency) => dependency.name))];
  const latestVersions = new Map(await mapWithConcurrency(packageNames, MAX_CONCURRENT_REQUESTS, async (packageName) => [packageName, await getLatestStableVersion(packageName)] as const));
  const dependencies = manifest.dependencies.map((dependency) => checkDependency(dependency, latestVersions.get(dependency.name) ?? null));
  const summary = dependencies.reduce((counts, dependency) => {
    if (dependency.status === "up-to-date") counts.upToDate += 1;
    if (dependency.status === "update-available") counts.updatesAvailable += 1;
    if (dependency.status === "ahead-of-npm-latest") counts.aheadOfNpmLatest += 1;
    if (dependency.status === "unknown") counts.unknown += 1;
    return counts;
  }, { total: dependencies.length, upToDate: 0, updatesAvailable: 0, aheadOfNpmLatest: 0, unknown: 0 });

  return { ...manifest, dependencies, summary };
}

function checkDependency(dependency: PackageDependency, latestVersion: string | null): CheckedPackageDependency {
  if (!isSupportedSemverRange(dependency.version) || !latestVersion) {
    return { ...dependency, latestVersion: null, status: "unknown" };
  }

  if (semver.satisfies(latestVersion, dependency.version, { includePrerelease: false })) {
    return { ...dependency, latestVersion, status: "up-to-date" };
  }

  const minimumDeclaredVersion = semver.minVersion(dependency.version);
  if (minimumDeclaredVersion && semver.gt(minimumDeclaredVersion.version, latestVersion)) {
    return { ...dependency, latestVersion, status: "ahead-of-npm-latest" };
  }

  return {
    ...dependency,
    latestVersion,
    status: "update-available",
  };
}

function isSupportedSemverRange(version: string) {
  const value = version.trim();
  if (!value || /^(?:workspace|file|link|git|github|gitlab|bitbucket|npm):/i.test(value)) return false;
  if (/^(?:https?:|ssh:|git\+|git@)/i.test(value)) return false;
  if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(value)) return false;

  return semver.validRange(value) !== null;
}

async function getLatestStableVersion(packageName: string) {
  try {
    const response = await fetch(new URL(encodeURIComponent(packageName), NPM_REGISTRY_ORIGIN), {
      headers: { Accept: "application/vnd.npm.install-v1+json" },
      next: { revalidate: 3600 },
    });
    if (!response.ok) return null;

    const metadata: unknown = await response.json();
    const latestVersion = getLatestDistTag(metadata);
    if (!latestVersion || semver.prerelease(latestVersion)) return null;

    return semver.valid(latestVersion);
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
