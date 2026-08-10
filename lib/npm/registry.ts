import "server-only";

import semver from "semver";

const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org/";

export const NPM_REGISTRY_LIMITS = {
  requestTimeoutMs: 8_000,
  maxLatestMetadataBytes: 256_000,
  cacheTtlMs: 5 * 60_000,
  maxCacheEntries: 200,
} as const;

export type NpmLatestPackageMetadata = {
  latestVersion: string;
  publishedAt: string | null;
  repository: string | { url: string } | null;
};

export type NpmLatestPackageMetadataLookup = {
  metadata: NpmLatestPackageMetadata | null;
  source: "network" | "cache" | "shared_request";
};

type CachedMetadata = { metadata: NpmLatestPackageMetadata; expiresAt: number };

const globalForNpmRegistry = globalThis as unknown as {
  sentinelNpmLatestMetadataCache?: Map<string, CachedMetadata>;
  sentinelNpmLatestMetadataRequests?: Map<string, Promise<NpmLatestPackageMetadata | null>>;
};

/**
 * Reads a single, current npm version document rather than the multi-version package
 * document. The process cache holds only normalized metadata and is strictly bounded.
 */
export async function getLatestNpmPackageMetadata(packageName: string): Promise<NpmLatestPackageMetadataLookup> {
  const cacheKey = getSafePackageName(packageName);
  if (!cacheKey) return { metadata: null, source: "network" };

  const cache = getCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      refreshCacheEntry(cache, cacheKey, cached);
      return { metadata: cached.metadata, source: "cache" };
    }
    cache.delete(cacheKey);
  }

  const requests = getRequests();
  const sharedRequest = requests.get(cacheKey);
  if (sharedRequest) return { metadata: await sharedRequest, source: "shared_request" };

  const request = fetchLatestMetadata(cacheKey);
  requests.set(cacheKey, request);
  try {
    const metadata = await request;
    if (metadata) addToCache(cache, cacheKey, metadata);
    return { metadata, source: "network" };
  } finally {
    if (requests.get(cacheKey) === request) requests.delete(cacheKey);
  }
}

async function fetchLatestMetadata(packageName: string): Promise<NpmLatestPackageMetadata | null> {
  try {
    // The npm registry's documented package-version endpoint accepts the `latest`
    // tag and returns one version document instead of a complete packument.
    const response = await fetch(new URL(`${encodeURIComponent(packageName)}/latest`, NPM_REGISTRY_ORIGIN), {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(NPM_REGISTRY_LIMITS.requestTimeoutMs),
    });
    if (!response.ok) return null;

    const value = await readBoundedJson(response, NPM_REGISTRY_LIMITS.maxLatestMetadataBytes);
    return getLatestMetadata(value);
  } catch {
    return null;
  }
}

function getLatestMetadata(value: unknown): NpmLatestPackageMetadata | null {
  if (!isRecord(value) || typeof value.version !== "string") return null;

  const latestVersion = semver.valid(value.version);
  if (!latestVersion || semver.prerelease(latestVersion)) return null;

  return {
    latestVersion,
    publishedAt: getPublishedAt(value, latestVersion),
    repository: getSafeRepository(value.repository),
  };
}

function getPublishedAt(value: Record<string, unknown>, latestVersion: string) {
  const directDate = getSafeDate(value.date) ?? getSafeDate(value.publishedAt) ?? getSafeDate(value.publish_time);
  if (directDate) return directDate;

  return isRecord(value.time) ? getSafeDate(value.time[latestVersion]) : null;
}

function getSafeRepository(value: unknown): NpmLatestPackageMetadata["repository"] {
  if (typeof value === "string") return getSafeText(value, 2_048);
  if (!isRecord(value)) return null;

  const url = getSafeText(value.url, 2_048);
  return url ? { url } : null;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body?.getReader();
  if (!reader) return null;

  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const combined = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(combined));
  } catch {
    return null;
  }
}

function getCache() {
  if (!globalForNpmRegistry.sentinelNpmLatestMetadataCache) {
    globalForNpmRegistry.sentinelNpmLatestMetadataCache = new Map();
  }
  return globalForNpmRegistry.sentinelNpmLatestMetadataCache;
}

function getRequests() {
  if (!globalForNpmRegistry.sentinelNpmLatestMetadataRequests) {
    globalForNpmRegistry.sentinelNpmLatestMetadataRequests = new Map();
  }
  return globalForNpmRegistry.sentinelNpmLatestMetadataRequests;
}

function refreshCacheEntry(cache: Map<string, CachedMetadata>, key: string, entry: CachedMetadata) {
  cache.delete(key);
  cache.set(key, entry);
}

function addToCache(cache: Map<string, CachedMetadata>, key: string, metadata: NpmLatestPackageMetadata) {
  cache.delete(key);
  while (cache.size >= NPM_REGISTRY_LIMITS.maxCacheEntries) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    cache.delete(oldestKey);
  }
  cache.set(key, { metadata, expiresAt: Date.now() + NPM_REGISTRY_LIMITS.cacheTtlMs });
}

function getSafePackageName(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 214 && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function getSafeText(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= maximumLength && !/[\u0000-\u001F\u007F]/.test(normalized) ? normalized : null;
}

function getSafeDate(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
