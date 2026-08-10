import "server-only";

import { getGitHubAccessTokenForCurrentUser } from "@/lib/github/repositories";
import { isValidGitHubRepository, type PackageDependency } from "@/lib/github/package-json";
import type { RepositoryUsageContext } from "@/lib/github/dependency-usage";

const GITHUB_API_ORIGIN = "https://api.github.com/";
const GITHUB_RAW_ORIGIN = "https://raw.githubusercontent.com/";
const SOURCE_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build", "coverage", "vendor", "vendors", "generated", "__generated__"]);

export const PROPOSED_FIX_CONTEXT_LIMITS = {
  maxFiles: 4,
  maxSourceFiles: 3,
  maxBytesPerFile: 32_000,
  maxSnippetCharacters: 800,
  maxCombinedCodeCharacters: 12_000,
  externalRequestTimeoutMs: 8_000,
} as const;

export type ProposedFixContextFile = {
  path: string;
  content: string;
};

export type ProposedFixContext = {
  status: "ready" | "unavailable";
  files: ProposedFixContextFile[];
};

export async function getProposedFixContext(owner: string, repository: string, dependency: PackageDependency, usage: RepositoryUsageContext, ref?: string): Promise<ProposedFixContext> {
  if (!isValidGitHubRepository(owner, repository)) return unavailableContext();

  const accessToken = await getGitHubAccessTokenForCurrentUser();
  if (!accessToken) return unavailableContext();

  try {
    // Revalidates authenticated repository access before any source-file read.
    const repositoryResponse = await fetchGitHubApi(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, accessToken);
    if (!repositoryResponse.ok) return unavailableContext();

    const defaultBranch = getDefaultBranch(await repositoryResponse.json());
    const sourceRef = ref && isSafeGitReference(ref) ? ref : defaultBranch;
    if (!sourceRef) return unavailableContext();

    const packageJson = createPackageJsonDependencyContext(dependency);
    const sourceUsages = deduplicateUsages(usage).slice(0, PROPOSED_FIX_CONTEXT_LIMITS.maxSourceFiles);
    const sourceFiles = await fetchSourceFiles(sourceUsages, owner, repository, sourceRef, accessToken, packageJson.length);

    return { status: "ready", files: [{ path: "package.json", content: packageJson }, ...sourceFiles] };
  } catch {
    return unavailableContext();
  }
}

function createPackageJsonDependencyContext(dependency: PackageDependency) {
  const section = dependency.type === "dependency" ? "dependencies" : dependency.type === "devDependency" ? "devDependencies" : dependency.type === "peerDependency" ? "peerDependencies" : "optionalDependencies";
  return JSON.stringify({ [section]: { [dependency.name]: dependency.version } }, null, 2);
}

function deduplicateUsages(usage: RepositoryUsageContext) {
  const paths = new Set<string>();
  return usage.usages.filter((item) => {
    if (!isSafeSourcePath(item.filePath) || paths.has(item.filePath)) return false;
    paths.add(item.filePath);
    return true;
  });
}

async function fetchSourceFiles(usages: RepositoryUsageContext["usages"], owner: string, repository: string, defaultBranch: string, accessToken: string, initialCharacters: number) {
  const files: ProposedFixContextFile[] = [];
  let combinedCharacters = initialCharacters;

  for (const usage of usages) {
    const content = await fetchBoundedSourceFile(usage, owner, repository, defaultBranch, accessToken);
    if (!content) continue;

    const nextSize = usage.filePath.length + content.length;
    if (combinedCharacters + nextSize > PROPOSED_FIX_CONTEXT_LIMITS.maxCombinedCodeCharacters) break;
    files.push({ path: usage.filePath, content });
    combinedCharacters += nextSize;
  }

  return files;
}

async function fetchBoundedSourceFile(usage: RepositoryUsageContext["usages"][number], owner: string, repository: string, defaultBranch: string, accessToken: string) {
  try {
    const rawPath = [owner, repository, defaultBranch, ...usage.filePath.split("/")].map(encodeURIComponent).join("/");
    const response = await fetch(new URL(rawPath, GITHUB_RAW_ORIGIN), {
      headers: {
        ...githubHeaders(accessToken),
        Range: `bytes=0-${PROPOSED_FIX_CONTEXT_LIMITS.maxBytesPerFile - 1}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(PROPOSED_FIX_CONTEXT_LIMITS.externalRequestTimeoutMs),
    });
    if (!response.ok) return getSafeSnippet(usage.snippet);

    const source = await readBoundedText(response, PROPOSED_FIX_CONTEXT_LIMITS.maxBytesPerFile);
    if (source.includes("\u0000")) return null;
    const matchIndex = source.indexOf(usage.matchedReference);
    return getSafeSnippet(matchIndex >= 0 ? getSurroundingSourceSnippet(source, matchIndex, usage.matchedReference.length) : usage.snippet);
  } catch {
    return getSafeSnippet(usage.snippet);
  }
}

function getSurroundingSourceSnippet(source: string, matchIndex: number, matchLength: number) {
  const start = Math.max(0, source.lastIndexOf("\n", Math.max(0, matchIndex - 300)) + 1);
  const endLine = source.indexOf("\n", matchIndex + matchLength + 300);
  return source.slice(start, endLine === -1 ? Math.min(source.length, matchIndex + matchLength + 300) : endLine).trim();
}

function getSafeSnippet(value: string) {
  const snippet = value.slice(0, PROPOSED_FIX_CONTEXT_LIMITS.maxSnippetCharacters).trim();
  if (!snippet || hasLikelyCredentialLiteral(snippet)) return null;
  return snippet;
}

function hasLikelyCredentialLiteral(value: string) {
  return /\b(?:api[_-]?key|secret|token|password|credential)\b\s*[:=]\s*["'][^"']{4,}/i.test(value);
}

async function fetchGitHubApi(path: string, accessToken: string) {
  return fetch(new URL(path, GITHUB_API_ORIGIN), {
    headers: githubHeaders(accessToken),
    cache: "no-store",
    signal: AbortSignal.timeout(PROPOSED_FIX_CONTEXT_LIMITS.externalRequestTimeoutMs),
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

function getDefaultBranch(value: unknown) {
  return isRecord(value) && typeof value.default_branch === "string" ? value.default_branch : null;
}

function isSafeSourcePath(path: string) {
  const segments = path.split("/");
  const basename = segments.at(-1)?.toLowerCase();
  if (!basename || segments.some((segment) => !segment || segment === "." || segment === ".." || EXCLUDED_DIRECTORIES.has(segment.toLowerCase()))) return false;
  if (basename.startsWith(".env") || basename.includes(".min.") || basename.includes(".generated.") || basename.endsWith(".d.ts")) return false;

  const extension = basename.split(".").at(-1);
  return !!extension && SOURCE_EXTENSIONS.has(extension);
}

function isSafeGitReference(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.endsWith("/");
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

function unavailableContext(): ProposedFixContext {
  return { status: "unavailable", files: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
