import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { getGitHubAccessTokenForCurrentUser } from "@/lib/github/repositories";
import { isValidGitHubRepository } from "@/lib/github/package-json";
import type { ImpactAnalysisSnapshot } from "@/lib/impact-analysis-ticket";
import type { ProposedFix } from "@/lib/openai/proposed-fix";
import type { ProposedFixValidationResult } from "@/lib/validation/proposed-fix-validation";

const GITHUB_API_ORIGIN = "https://api.github.com/";
const GITHUB_API_VERSION = "2026-03-10";
const SOURCE_EXTENSIONS = new Set(["js", "jsx", "ts", "tsx", "mjs", "cjs"]);
const EXCLUDED_DIRECTORY_NAMES = new Set(["node_modules", ".next", "dist", "build", "coverage", "vendor", "vendors", "generated", "__generated__"]);
const PROHIBITED_FILE_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", ".npmrc", ".yarnrc", ".yarnrc.yml", ".pypirc", "credentials", "credentials.json", "secrets", "secrets.json", "id_rsa"]);

export const DRAFT_PULL_REQUEST_LIMITS = {
  requestTimeoutMs: 15_000,
  maxFiles: 4,
  maxSourceFileBytes: 128 * 1024,
  maxCombinedFileBytes: 256 * 1024,
  maxTreeResponseBytes: 8 * 1024 * 1024,
  maxOpenPullRequestsExamined: 100,
  maxBranchNameLength: 96,
  maxBranchAttempts: 4,
} as const;

type GitHubHttpCategory = "rate_limited" | "server_error" | "client_error";
type DraftPullRequestFailureCategory = "github_authorization" | "repository_access" | "write_access" | "repository_restricted" | "stale_base" | "dependency_changed" | "base_commit_unavailable" | "tree_unavailable" | "change_verification" | "prohibited_file" | "github_api" | "timeout" | "request_error" | "branch_creation" | "pull_request_creation";
type TreeEntry = { path: string; mode: "100644" | "100755"; type: "blob"; size: number | null };
type VerifiedFileChange = { path: string; mode: "100644" | "100755"; content: string };

export type GitHubRepositoryBase = {
  owner: string;
  repository: string;
  defaultBranch: string;
  baseCommitSha: string;
  writeAccess: boolean;
};

export type GitHubRepositoryBaseResult =
  | { kind: "ready"; repository: GitHubRepositoryBase }
  | { kind: "error"; category: DraftPullRequestFailureCategory };

export type DraftPullRequestActionResult =
  | {
    kind: "created";
    prNumber: number;
    prUrl: string;
    branchName: string;
    baseBranch: string;
    commitSha: string;
    draft: true;
    dependencyName: string;
    declaredVersion: string;
    targetVersion: string;
  }
  | {
    kind: "existing";
    prNumber: number;
    prUrl: string;
    branchName: string;
    baseBranch: string;
    commitSha: string;
    draft: boolean;
    dependencyName: string;
    declaredVersion: string;
    targetVersion: string;
  }
  | { kind: "error"; error: string };

type ExistingDraftPullRequestResult = {
  kind: "existing";
  prNumber: number;
  prUrl: string;
  branchName: string;
  baseBranch: string;
  commitSha: string;
  draft: boolean;
  dependencyName: string;
  declaredVersion: string;
  targetVersion: string;
};

export type VerifiedDraftPullRequestInput = {
  owner: string;
  repository: string;
  defaultBranch: string;
  baseCommitSha: string;
  dependency: {
    name: string;
    declaredVersion: string;
    latestVersion: string;
    changeType: "major" | "minor" | "patch";
    risk: "low" | "medium" | "high";
    dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
  };
  proposedFix: ProposedFix;
  validation: ProposedFixValidationResult;
  impactAnalysis: ImpactAnalysisSnapshot;
  proposedChangeIdentifier: string;
};

class DraftPullRequestError extends Error {
  constructor(
    readonly category: DraftPullRequestFailureCategory,
    readonly stage: string,
    readonly status: number | null = null,
  ) {
    super(category);
  }
}

export async function getGitHubRepositoryBaseForCurrentUser(owner: string, repository: string, requireWriteAccess = false): Promise<GitHubRepositoryBaseResult> {
  if (!isValidGitHubRepository(owner, repository)) return { kind: "error", category: "repository_access" };

  const accessToken = await getGitHubAccessTokenForCurrentUser();
  if (!accessToken) return { kind: "error", category: "github_authorization" };

  try {
    return { kind: "ready", repository: await getGitHubRepositoryBase(owner, repository, accessToken, requireWriteAccess) };
  } catch (error) {
    if (error instanceof DraftPullRequestError) return { kind: "error", category: error.category };
    return { kind: "error", category: "request_error" };
  }
}

export async function createDraftPullRequestFromVerifiedChanges(input: VerifiedDraftPullRequestInput): Promise<DraftPullRequestActionResult> {
  if (process.env.SENTINEL_PR_CREATION_ENABLED !== "true") {
    return { kind: "error", error: "Draft pull request creation is disabled in this environment." };
  }

  const accessToken = await getGitHubAccessTokenForCurrentUser();
  if (!accessToken) return { kind: "error", error: "GitHub authorization is unavailable. Reconnect GitHub and try again." };

  let createdBranch: string | null = null;
  let potentiallyCreatedBranch: string | null = null;
  let createdCommitSha: string | null = null;
  let pullRequestCreationAttempted = false;
  try {
    logSafePrEvent("creation_started", { stage: "preflight", repository: `${input.owner}/${input.repository}`, baseCommitSha: input.baseCommitSha });
    const repositoryBase = await getGitHubRepositoryBase(input.owner, input.repository, accessToken, true);
    if (!matchesValidatedBase(repositoryBase, input)) return staleBaseResult();

    const existingPullRequest = await findExistingDraftPullRequest(input, accessToken);
    if (existingPullRequest) return existingPullRequest;

    const baseCommit = await getBaseCommit(input, accessToken);
    const baseTree = await getBaseTree(input, baseCommit.treeSha, accessToken);
    const verifiedChanges = await reconstructVerifiedChanges(input, baseTree, accessToken);
    if (verifiedChanges.length === 0) {
      throw new DraftPullRequestError("change_verification", "reconstruct_changes");
    }

    const treeEntries = await Promise.all(verifiedChanges.map(async (change) => ({
      path: change.path,
      mode: change.mode,
      type: "blob" as const,
      sha: await createBlob(input, change.content, accessToken),
    })));
    const treeSha = await createTree(input, baseCommit.treeSha, treeEntries, accessToken);
    createdCommitSha = await createCommit(input, treeSha, accessToken);
    logSafePrEvent("commit_created", { commitSha: createdCommitSha });

    createdBranch = await createUniqueSentinelBranch(input, createdCommitSha, accessToken, (branchName) => {
      potentiallyCreatedBranch = branchName;
    });
    logSafePrEvent("branch_created", { branchName: createdBranch, commitSha: createdCommitSha });

    const finalRepositoryBase = await getGitHubRepositoryBase(input.owner, input.repository, accessToken, true);
    if (!matchesValidatedBase(finalRepositoryBase, input)) {
      throw new DraftPullRequestError("stale_base", "pre_pull_request");
    }

    const duplicateAfterBranchCreation = await findExistingDraftPullRequest(input, accessToken);
    if (duplicateAfterBranchCreation) {
      const cleanupSucceeded = await deleteNewSentinelBranch(input, createdBranch, createdCommitSha, accessToken);
      if (!cleanupSucceeded) return branchCleanupFailureResult(createdBranch);
      return duplicateAfterBranchCreation;
    }

    pullRequestCreationAttempted = true;
    const pullRequest = await createDraftPullRequest(input, createdBranch, accessToken);
    logSafePrEvent("pull_request_created", { prNumber: pullRequest.prNumber, branchName: createdBranch });
    return {
      kind: "created",
      prNumber: pullRequest.prNumber,
      prUrl: pullRequest.prUrl,
      branchName: createdBranch,
      baseBranch: input.defaultBranch,
      commitSha: createdCommitSha,
      draft: true,
      dependencyName: input.dependency.name,
      declaredVersion: input.dependency.declaredVersion,
      targetVersion: input.dependency.latestVersion,
    };
  } catch (error) {
    const cleanupBranch = createdBranch ?? potentiallyCreatedBranch;
    if (pullRequestCreationAttempted && isAmbiguousPullRequestCreationError(error)) {
      const existingLookup = await findExistingDraftPullRequestSafely(input, accessToken);
      if (existingLookup.kind === "found") return existingLookup.pullRequest;
      if (existingLookup.kind === "missing") {
        logSafePrEvent("idempotency_lookup_missing", { stage: "post_pull_request_attempt" });
      }
      return ambiguousPullRequestCreationResult(cleanupBranch);
    }

    const cleanupSucceeded = cleanupBranch && createdCommitSha
      ? await deleteNewSentinelBranch(input, cleanupBranch, createdCommitSha, accessToken)
      : true;
    if (!cleanupSucceeded && cleanupBranch) return branchCleanupFailureResult(cleanupBranch);
    return getDraftPullRequestErrorResult(error);
  }
}

export function getProposedChangeIdentifier(input: Pick<VerifiedDraftPullRequestInput, "owner" | "repository" | "baseCommitSha" | "dependency" | "proposedFix">) {
  return createHash("sha256").update(JSON.stringify({
    owner: input.owner.toLowerCase(),
    repository: input.repository.toLowerCase(),
    baseCommitSha: input.baseCommitSha,
    dependencyName: input.dependency.name,
    targetVersion: input.dependency.latestVersion,
    proposedFix: input.proposedFix,
  })).digest("base64url").slice(0, 32);
}

async function getGitHubRepositoryBase(owner: string, repository: string, accessToken: string, requireWriteAccess: boolean): Promise<GitHubRepositoryBase> {
  const response = await requestGitHub(owner, repository, accessToken, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`, "repository_access");
  const details = parseRepositoryDetails(await readBoundedJson(response, 512 * 1024));
  if (!details) throw new DraftPullRequestError("repository_access", "repository_response_parse", response.status);
  if (!sameGitHubIdentifier(details.owner, owner) || !sameGitHubIdentifier(details.repository, repository)) {
    throw new DraftPullRequestError("repository_access", "repository_identity", response.status);
  }
  if (details.archived || details.disabled) throw new DraftPullRequestError("repository_restricted", "repository_state", response.status);
  if (requireWriteAccess && !details.writeAccess) throw new DraftPullRequestError("write_access", "repository_permissions", response.status);

  const reference = await requestGitHub(owner, repository, accessToken, "GET", `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/heads/${encodeURIComponent(details.defaultBranch)}`, "base_reference");
  const baseCommitSha = parseReferenceSha(await readBoundedJson(reference, 256 * 1024));
  if (!baseCommitSha) throw new DraftPullRequestError("base_commit_unavailable", "base_reference_parse", reference.status);

  return {
    owner: details.owner,
    repository: details.repository,
    defaultBranch: details.defaultBranch,
    baseCommitSha,
    writeAccess: details.writeAccess,
  };
}

async function getBaseCommit(input: VerifiedDraftPullRequestInput, accessToken: string) {
  const response = await requestGitHub(input.owner, input.repository, accessToken, "GET", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/commits/${encodeURIComponent(input.baseCommitSha)}`, "base_commit");
  const commit = parseCommit(await readBoundedJson(response, 256 * 1024));
  if (!commit || commit.sha !== input.baseCommitSha) throw new DraftPullRequestError("base_commit_unavailable", "base_commit_parse", response.status);
  return commit;
}

async function getBaseTree(input: VerifiedDraftPullRequestInput, treeSha: string, accessToken: string) {
  const response = await requestGitHub(input.owner, input.repository, accessToken, "GET", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`, "base_tree");
  const tree = parseTree(await readBoundedJson(response, DRAFT_PULL_REQUEST_LIMITS.maxTreeResponseBytes));
  if (!tree) throw new DraftPullRequestError("tree_unavailable", "base_tree_parse", response.status);
  return new Map(tree.entries.map((entry) => [entry.path, entry]));
}

async function reconstructVerifiedChanges(input: VerifiedDraftPullRequestInput, baseTree: Map<string, TreeEntry>, accessToken: string) {
  const changes: VerifiedFileChange[] = [];
  const paths = new Set<string>();
  let combinedBytes = 0;

  const addVerifiedFile = async (path: string, update: (content: string) => string | null) => {
    if (paths.has(path) || changes.length >= DRAFT_PULL_REQUEST_LIMITS.maxFiles) {
      throw new DraftPullRequestError("change_verification", "duplicate_or_excess_file");
    }
    const entry = baseTree.get(path);
    if (!entry || entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new DraftPullRequestError("change_verification", "tree_file_verification");
    }

    const file = await fetchTextFileAtCommit(input, path, accessToken);
    combinedBytes += file.byteLength;
    if (combinedBytes > DRAFT_PULL_REQUEST_LIMITS.maxCombinedFileBytes) {
      throw new DraftPullRequestError("change_verification", "combined_file_size");
    }
    const updatedContent = update(file.content);
    if (updatedContent === null || updatedContent === file.content) {
      throw new DraftPullRequestError("change_verification", "exact_change_verification");
    }
    paths.add(path);
    changes.push({ path, mode: entry.mode, content: updatedContent });
  };

  if (input.proposedFix.packageJsonChange.required) {
    await addVerifiedFile("package.json", (content) => updateVerifiedPackageJson(content, input));
  }

  for (const file of input.proposedFix.files) {
    if (!isAllowedSourceFilePath(file.path)) {
      throw new DraftPullRequestError("prohibited_file", "source_path");
    }
    await addVerifiedFile(file.path, (content) => replaceExactVerifiedSnippet(content, file.originalSnippet, file.proposedSnippet));
  }

  return changes;
}

async function fetchTextFileAtCommit(input: VerifiedDraftPullRequestInput, path: string, accessToken: string) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await requestGitHub(input.owner, input.repository, accessToken, "GET", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${encodedPath}?ref=${encodeURIComponent(input.baseCommitSha)}`, "file_read");
  const maximumResponseBytes = Math.ceil(DRAFT_PULL_REQUEST_LIMITS.maxSourceFileBytes * 1.5) + 16 * 1024;
  const file = parseContentFile(await readBoundedJson(response, maximumResponseBytes));
  if (!file || file.byteLength > DRAFT_PULL_REQUEST_LIMITS.maxSourceFileBytes) {
    throw new DraftPullRequestError("change_verification", "file_content_verification", response.status);
  }
  return file;
}

async function createBlob(input: VerifiedDraftPullRequestInput, content: string, accessToken: string) {
  const response = await requestGitHub(input.owner, input.repository, accessToken, "POST", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/blobs`, "create_blob", {
    content: Buffer.from(content, "utf8").toString("base64"),
    encoding: "base64",
  });
  const sha = parseShaResponse(await readBoundedJson(response, 256 * 1024));
  if (!sha) throw new DraftPullRequestError("github_api", "create_blob_parse", response.status);
  return sha;
}

async function createTree(input: VerifiedDraftPullRequestInput, baseTreeSha: string, entries: Array<{ path: string; mode: "100644" | "100755"; type: "blob"; sha: string }>, accessToken: string) {
  const response = await requestGitHub(input.owner, input.repository, accessToken, "POST", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/trees`, "create_tree", {
    base_tree: baseTreeSha,
    tree: entries,
  });
  const sha = parseShaResponse(await readBoundedJson(response, 256 * 1024));
  if (!sha) throw new DraftPullRequestError("github_api", "create_tree_parse", response.status);
  return sha;
}

async function createCommit(input: VerifiedDraftPullRequestInput, treeSha: string, accessToken: string) {
  const response = await requestGitHub(input.owner, input.repository, accessToken, "POST", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/commits`, "create_commit", {
    message: getCommitMessage(input.dependency.name, input.dependency.latestVersion),
    tree: treeSha,
    parents: [input.baseCommitSha],
  });
  const sha = parseShaResponse(await readBoundedJson(response, 256 * 1024));
  if (!sha) throw new DraftPullRequestError("github_api", "create_commit_parse", response.status);
  return sha;
}

async function createUniqueSentinelBranch(input: VerifiedDraftPullRequestInput, commitSha: string, accessToken: string, onPotentiallyCreatedBranch: (branchName: string) => void) {
  for (let attempt = 0; attempt < DRAFT_PULL_REQUEST_LIMITS.maxBranchAttempts; attempt += 1) {
    const branchName = createSentinelBranchName(input.dependency.name, input.dependency.latestVersion);
    if (branchName === input.defaultBranch) continue;
    try {
      const response = await requestGitHub(input.owner, input.repository, accessToken, "POST", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/refs`, "create_branch", {
        ref: `refs/heads/${branchName}`,
        sha: commitSha,
      });
      if (response.status === 201) return branchName;
      throw new DraftPullRequestError("branch_creation", "create_branch_status", response.status);
    } catch (error) {
      if (isAmbiguousGitWriteError(error)) onPotentiallyCreatedBranch(branchName);
      if (error instanceof DraftPullRequestError && error.status === 422 && attempt + 1 < DRAFT_PULL_REQUEST_LIMITS.maxBranchAttempts) continue;
      if (error instanceof DraftPullRequestError && error.category === "github_api") {
        throw new DraftPullRequestError("branch_creation", error.stage, error.status);
      }
      throw error;
    }
  }
  throw new DraftPullRequestError("branch_creation", "branch_collision");
}

async function createDraftPullRequest(input: VerifiedDraftPullRequestInput, branchName: string, accessToken: string) {
  try {
    const response = await requestGitHub(input.owner, input.repository, accessToken, "POST", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`, "create_pull_request", {
      title: getCommitMessage(input.dependency.name, input.dependency.latestVersion),
      head: branchName,
      base: input.defaultBranch,
      draft: true,
      maintainer_can_modify: false,
      body: createPullRequestBody(input),
    });
    const pullRequest = parsePullRequest(await readBoundedJson(response, 512 * 1024));
    if (!pullRequest) throw new DraftPullRequestError("pull_request_creation", "create_pull_request_parse", response.status);
    return pullRequest;
  } catch (error) {
    if (error instanceof DraftPullRequestError) throw new DraftPullRequestError("pull_request_creation", error.stage, error.status);
    throw error;
  }
}

async function findExistingDraftPullRequest(input: VerifiedDraftPullRequestInput, accessToken: string): Promise<ExistingDraftPullRequestResult | null> {
  const response = await requestGitHub(input.owner, input.repository, accessToken, "GET", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls?state=open&base=${encodeURIComponent(input.defaultBranch)}&per_page=${DRAFT_PULL_REQUEST_LIMITS.maxOpenPullRequestsExamined}`, "find_existing_pull_request");
  const pullRequests = parsePullRequestList(await readBoundedJson(response, 2 * 1024 * 1024));
  if (!pullRequests) throw new DraftPullRequestError("github_api", "existing_pull_request_parse", response.status);

  const marker = getPullRequestMarker(input.proposedChangeIdentifier);
  const existing = pullRequests.find((pullRequest) => pullRequest.body?.includes(marker) && pullRequest.branchName.startsWith("sentinel/") && sameRepositoryFullName(pullRequest.repositoryFullName, input.owner, input.repository));
  return existing ? {
    kind: "existing",
    prNumber: existing.prNumber,
    prUrl: existing.prUrl,
    branchName: existing.branchName,
    baseBranch: input.defaultBranch,
    commitSha: existing.commitSha,
    draft: existing.draft,
    dependencyName: input.dependency.name,
    declaredVersion: input.dependency.declaredVersion,
    targetVersion: input.dependency.latestVersion,
  } : null;
}

async function findExistingDraftPullRequestSafely(input: VerifiedDraftPullRequestInput, accessToken: string): Promise<{ kind: "found"; pullRequest: ExistingDraftPullRequestResult } | { kind: "missing" | "unavailable" }> {
  try {
    const pullRequest = await findExistingDraftPullRequest(input, accessToken);
    return pullRequest ? { kind: "found", pullRequest } : { kind: "missing" };
  } catch {
    logSafePrEvent("idempotency_lookup_unavailable", { stage: "post_pull_request_attempt" });
    return { kind: "unavailable" };
  }
}

async function deleteNewSentinelBranch(input: VerifiedDraftPullRequestInput, branchName: string, expectedCommitSha: string, accessToken: string) {
  if (!branchName.startsWith("sentinel/") || branchName === input.defaultBranch || !isSafeGitSha(expectedCommitSha)) return false;
  logSafePrEvent("cleanup_attempted", { branchName, stage: "delete_branch" });
  try {
    const reference = await requestGitHub(input.owner, input.repository, accessToken, "GET", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/ref/heads/${encodeURIComponent(branchName)}`, "cleanup_branch_reference");
    const referenceSha = parseReferenceSha(await readBoundedJson(reference, 256 * 1024));
    if (!referenceSha || !sameGitSha(referenceSha, expectedCommitSha)) {
      logSafePrEvent("cleanup_finished", { branchName, status: "skipped_commit_mismatch" });
      return false;
    }
  } catch (error) {
    if (error instanceof DraftPullRequestError && error.status === 404) {
      logSafePrEvent("cleanup_finished", { branchName, status: "already_absent" });
      return true;
    }
    const category = error instanceof DraftPullRequestError && error.category === "timeout" ? "timeout" : "failed";
    logSafePrEvent("cleanup_finished", { branchName, status: category });
    return false;
  }

  try {
    await requestGitHub(input.owner, input.repository, accessToken, "DELETE", `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/git/refs/heads/${encodeURIComponent(branchName)}`, "cleanup_branch");
    logSafePrEvent("cleanup_finished", { branchName, status: "deleted" });
    return true;
  } catch (error) {
    if (error instanceof DraftPullRequestError && error.status === 404) {
      logSafePrEvent("cleanup_finished", { branchName, status: "already_absent" });
      return true;
    }
    const category = error instanceof DraftPullRequestError && error.category === "timeout" ? "timeout" : "failed";
    logSafePrEvent("cleanup_finished", { branchName, status: category });
    return false;
  }
}

async function requestGitHub(owner: string, repository: string, accessToken: string, method: "GET" | "POST" | "DELETE", path: string, stage: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(new URL(path, GITHUB_API_ORIGIN), {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "Sentinel",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: "no-store",
      signal: AbortSignal.timeout(DRAFT_PULL_REQUEST_LIMITS.requestTimeoutMs),
    });
  } catch (error) {
    const category: DraftPullRequestFailureCategory = isTimeoutError(error) ? "timeout" : "request_error";
    logSafePrEvent("request_failed", { stage, category, repository: `${owner}/${repository}` });
    throw new DraftPullRequestError(category, stage);
  }

  const expectedStatus = method === "POST" ? [201] : method === "DELETE" ? [204] : [200];
  if (!expectedStatus.includes(response.status)) {
    const category = getHttpCategory(response.status, response.headers);
    logSafePrEvent("api_error", { stage, status: response.status, category, repository: `${owner}/${repository}` });
    throw new DraftPullRequestError("github_api", stage, response.status);
  }
  return response;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new DraftPullRequestError("github_api", "response_too_large", response.status);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new DraftPullRequestError("github_api", "response_body_unavailable", response.status);
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > maximumBytes) {
      await reader.cancel();
      throw new DraftPullRequestError("github_api", "response_too_large", response.status);
    }
    chunks.push(value);
  }

  try {
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    return JSON.parse(buffer.toString("utf8")) as unknown;
  } catch {
    throw new DraftPullRequestError("github_api", "response_json_parse", response.status);
  }
}

function parseRepositoryDetails(value: unknown) {
  if (!isRecord(value) || typeof value.name !== "string" || !isRecord(value.owner) || typeof value.owner.login !== "string" || typeof value.default_branch !== "string" || !isRecord(value.permissions)) return null;
  if (!isSafeBranchName(value.default_branch)) return null;
  return {
    owner: value.owner.login,
    repository: value.name,
    defaultBranch: value.default_branch,
    writeAccess: value.permissions.push === true,
    archived: value.archived === true,
    disabled: value.disabled === true,
  };
}

function parseReferenceSha(value: unknown) {
  if (!isRecord(value) || !isRecord(value.object) || value.object.type !== "commit" || typeof value.object.sha !== "string" || !isSafeGitSha(value.object.sha)) return null;
  return value.object.sha;
}

function parseCommit(value: unknown) {
  if (!isRecord(value) || typeof value.sha !== "string" || !isSafeGitSha(value.sha) || !isRecord(value.tree) || typeof value.tree.sha !== "string" || !isSafeGitSha(value.tree.sha)) return null;
  return { sha: value.sha, treeSha: value.tree.sha };
}

function parseTree(value: unknown) {
  if (!isRecord(value) || value.truncated === true || !Array.isArray(value.tree)) return null;
  const entries = value.tree.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || (entry.mode !== "100644" && entry.mode !== "100755") || entry.type !== "blob") return [];
    if (!isSafeRepositoryFilePath(entry.path)) return [];
    return [{ path: entry.path, mode: entry.mode, type: entry.type, size: typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0 ? entry.size : null } satisfies TreeEntry];
  });
  return entries.length === value.tree.filter((entry) => isRecord(entry) && entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")).length ? { entries } : null;
}

function parseContentFile(value: unknown) {
  if (!isRecord(value) || value.type !== "file" || value.encoding !== "base64" || typeof value.content !== "string" || typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) return null;
  try {
    const bytes = Buffer.from(value.content.replace(/\s/g, ""), "base64");
    if (bytes.byteLength !== value.size || bytes.includes(0)) return null;
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), byteLength: bytes.byteLength };
  } catch {
    return null;
  }
}

function parseShaResponse(value: unknown) {
  return isRecord(value) && typeof value.sha === "string" && isSafeGitSha(value.sha) ? value.sha : null;
}

function parsePullRequest(value: unknown) {
  if (!isRecord(value) || typeof value.number !== "number" || !Number.isSafeInteger(value.number) || typeof value.html_url !== "string" || value.draft !== true) return null;
  return { prNumber: value.number, prUrl: value.html_url };
}

function parsePullRequestList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const pullRequests = value.flatMap((item) => {
    if (!isRecord(item) || typeof item.number !== "number" || !Number.isSafeInteger(item.number) || typeof item.html_url !== "string" || typeof item.body !== "string" || typeof item.draft !== "boolean" || !isRecord(item.head) || typeof item.head.ref !== "string" || typeof item.head.sha !== "string" || !isSafeGitSha(item.head.sha) || !isRecord(item.head.repo) || typeof item.head.repo.full_name !== "string") return [];
    return [{
      prNumber: item.number,
      prUrl: item.html_url,
      body: item.body,
      draft: item.draft,
      branchName: item.head.ref,
      commitSha: item.head.sha,
      repositoryFullName: item.head.repo.full_name,
    }];
  });
  return pullRequests;
}

function updateVerifiedPackageJson(content: string, input: VerifiedDraftPullRequestInput) {
  const section = getDependencySection(input.dependency.dependencyType);
  if (!section || !input.proposedFix.packageJsonChange.required) return null;
  if (input.proposedFix.packageJsonChange.dependency !== input.dependency.name || input.proposedFix.packageJsonChange.from !== input.dependency.declaredVersion || input.proposedFix.packageJsonChange.to !== input.dependency.latestVersion) return null;

  try {
    const manifest: unknown = JSON.parse(content);
    if (!isRecord(manifest) || !isRecord(manifest[section]) || manifest[section][input.dependency.name] !== input.dependency.declaredVersion) return null;
  } catch {
    return null;
  }

  const valueLocation = findJsonObjectStringValue(content, section, input.dependency.name);
  if (!valueLocation || valueLocation.value !== input.dependency.declaredVersion) return null;
  return `${content.slice(0, valueLocation.start)}${JSON.stringify(input.dependency.latestVersion)}${content.slice(valueLocation.end)}`;
}

function replaceExactVerifiedSnippet(content: string, originalSnippet: string, proposedSnippet: string) {
  if (!originalSnippet || !proposedSnippet || hasUnsafeTextControlCharacters(originalSnippet) || hasUnsafeTextControlCharacters(proposedSnippet)) return null;
  const firstIndex = content.indexOf(originalSnippet);
  if (firstIndex === -1 || firstIndex !== content.lastIndexOf(originalSnippet)) return null;
  return `${content.slice(0, firstIndex)}${proposedSnippet}${content.slice(firstIndex + originalSnippet.length)}`;
}

function findJsonObjectStringValue(content: string, objectKey: string, memberKey: string) {
  let cursor = skipJsonWhitespace(content, 0);
  if (content[cursor] !== "{") return null;
  cursor += 1;
  let objectMatches = 0;
  let memberLocation: { start: number; end: number; value: string } | null = null;

  while (true) {
    cursor = skipJsonWhitespace(content, cursor);
    if (content[cursor] === "}") break;
    const key = readJsonString(content, cursor);
    if (!key) return null;
    cursor = skipJsonWhitespace(content, key.end);
    if (content[cursor] !== ":") return null;
    const valueStart = skipJsonWhitespace(content, cursor + 1);
    if (key.value === objectKey) {
      objectMatches += 1;
      const foundMember = findJsonStringMemberInObject(content, valueStart, memberKey);
      if (!foundMember || memberLocation) return null;
      memberLocation = foundMember;
    }
    const valueEnd = skipJsonValue(content, valueStart);
    if (valueEnd === null) return null;
    cursor = skipJsonWhitespace(content, valueEnd);
    if (content[cursor] === "}") break;
    if (content[cursor] !== ",") return null;
    cursor += 1;
  }

  return objectMatches === 1 ? memberLocation : null;
}

function findJsonStringMemberInObject(content: string, start: number, memberKey: string) {
  let cursor = skipJsonWhitespace(content, start);
  if (content[cursor] !== "{") return null;
  cursor += 1;
  let matches = 0;
  let memberLocation: { start: number; end: number; value: string } | null = null;

  while (true) {
    cursor = skipJsonWhitespace(content, cursor);
    if (content[cursor] === "}") break;
    const key = readJsonString(content, cursor);
    if (!key) return null;
    cursor = skipJsonWhitespace(content, key.end);
    if (content[cursor] !== ":") return null;
    const valueStart = skipJsonWhitespace(content, cursor + 1);
    if (key.value === memberKey) {
      const value = readJsonString(content, valueStart);
      if (!value) return null;
      matches += 1;
      memberLocation = value;
    }
    const valueEnd = skipJsonValue(content, valueStart);
    if (valueEnd === null) return null;
    cursor = skipJsonWhitespace(content, valueEnd);
    if (content[cursor] === "}") break;
    if (content[cursor] !== ",") return null;
    cursor += 1;
  }

  return matches === 1 ? memberLocation : null;
}

function readJsonString(content: string, start: number) {
  if (content[start] !== "\"") return null;
  let cursor = start + 1;
  let escaped = false;
  while (cursor < content.length) {
    const character = content[cursor];
    if (!escaped && character === "\"") {
      const end = cursor + 1;
      try {
        const value: unknown = JSON.parse(content.slice(start, end));
        return typeof value === "string" ? { start, end, value } : null;
      } catch {
        return null;
      }
    }
    if (!escaped && character === "\\") escaped = true;
    else escaped = false;
    cursor += 1;
  }
  return null;
}

function skipJsonValue(content: string, start: number): number | null {
  const cursor = skipJsonWhitespace(content, start);
  const character = content[cursor];
  if (character === "\"") return readJsonString(content, cursor)?.end ?? null;
  if (character === "{") return skipJsonObject(content, cursor);
  if (character === "[") return skipJsonArray(content, cursor);
  const primitive = content.slice(cursor).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
  return primitive ? cursor + primitive.length : null;
}

function skipJsonObject(content: string, start: number): number | null {
  let cursor = start + 1;
  while (true) {
    cursor = skipJsonWhitespace(content, cursor);
    if (content[cursor] === "}") return cursor + 1;
    const key = readJsonString(content, cursor);
    if (!key) return null;
    cursor = skipJsonWhitespace(content, key.end);
    if (content[cursor] !== ":") return null;
    const valueEnd = skipJsonValue(content, cursor + 1);
    if (valueEnd === null) return null;
    cursor = skipJsonWhitespace(content, valueEnd);
    if (content[cursor] === "}") return cursor + 1;
    if (content[cursor] !== ",") return null;
    cursor += 1;
  }
}

function skipJsonArray(content: string, start: number): number | null {
  let cursor = start + 1;
  while (true) {
    cursor = skipJsonWhitespace(content, cursor);
    if (content[cursor] === "]") return cursor + 1;
    const valueEnd = skipJsonValue(content, cursor);
    if (valueEnd === null) return null;
    cursor = skipJsonWhitespace(content, valueEnd);
    if (content[cursor] === "]") return cursor + 1;
    if (content[cursor] !== ",") return null;
    cursor += 1;
  }
}

function skipJsonWhitespace(content: string, cursor: number) {
  while (cursor < content.length && /\s/.test(content[cursor])) cursor += 1;
  return cursor;
}

function createSentinelBranchName(dependencyName: string, targetVersion: string) {
  const dependencySegment = sanitizeBranchSegment(dependencyName, "dependency", 48);
  const majorVersion = targetVersion.match(/\d+/)?.[0] ?? "update";
  const suffix = randomBytes(4).toString("hex");
  const branch = `sentinel/${dependencySegment}-${majorVersion}-${suffix}`;
  return branch.slice(0, DRAFT_PULL_REQUEST_LIMITS.maxBranchNameLength).replace(/[-./]+$/, "");
}

function sanitizeBranchSegment(value: string, fallback: string, maximumLength: number) {
  const normalized = value.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, maximumLength).replace(/-+$/, "") || fallback;
}

function createPullRequestBody(input: VerifiedDraftPullRequestInput) {
  const files = [
    ...(input.proposedFix.packageJsonChange.required ? ["package.json"] : []),
    ...input.proposedFix.files.map((file) => file.path),
  ];
  const validationLines = [
    `- Install: ${formatValidationStatus(input.validation.install.status)}`,
    ...input.validation.checks.map((check) => `- ${formatCheckName(check.name)}: ${formatValidationStatus(check.status)}`),
  ];
  const warningLines = input.validation.warnings.length > 0
    ? `\nWarnings:\n${input.validation.warnings.map((warning) => `- ${toSafePullRequestText(warning)}`).join("\n")}`
    : "";
  const analysisSummary = toSafePullRequestText(input.impactAnalysis.summary);
  const riskExplanation = toSafePullRequestText(input.impactAnalysis.riskExplanation);

  return `## Sentinel maintenance update

Dependency:
${input.dependency.name}

Declared:
${input.dependency.declaredVersion}

Target:
${input.dependency.latestVersion}

Change:
${capitalize(input.dependency.changeType)}

Risk:
${capitalize(input.dependency.risk)}

## Why this update was proposed

${analysisSummary}

${riskExplanation}

## Changes

${files.map((path) => `- ${path}`).join("\n")}

## Validation

${validationLines.join("\n")}${warningLines}

## Important

Generated by Sentinel. Automated validation does not guarantee correctness. Developer review is required before merge.

${getPullRequestMarker(input.proposedChangeIdentifier)}`;
}

function getCommitMessage(dependencyName: string, targetVersion: string) {
  return `chore(deps): update ${dependencyName} to ${targetVersion}`.slice(0, 240);
}

function getPullRequestMarker(proposedChangeIdentifier: string) {
  return `<!-- sentinel-change-id:${proposedChangeIdentifier} -->`;
}

function toSafePullRequestText(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 1_000);
  if (!normalized || /\b(?:safe to merge|bug[- ]free|production[- ]ready|tests? (?:pass|passed))\b/i.test(normalized)) {
    return "Sentinel identified this update for developer review based on the verified dependency and validation context.";
  }
  return normalized;
}

function formatValidationStatus(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCheckName(name: string) {
  if (name === "typecheck") return "Typecheck";
  if (name === "test") return "Tests";
  return capitalize(name);
}

function capitalize(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function matchesValidatedBase(repository: GitHubRepositoryBase, input: VerifiedDraftPullRequestInput) {
  return sameGitHubIdentifier(repository.owner, input.owner)
    && sameGitHubIdentifier(repository.repository, input.repository)
    && repository.writeAccess
    && repository.defaultBranch === input.defaultBranch
    && repository.baseCommitSha === input.baseCommitSha;
}

function staleBaseResult(): DraftPullRequestActionResult {
  return { kind: "error", error: "The repository changed after validation. Run analysis and validation again before creating a PR." };
}

function branchCleanupFailureResult(branchName: string): DraftPullRequestActionResult {
  return { kind: "error", error: `Draft PR creation did not finish. Sentinel could not confirm cleanup of ${branchName}; inspect or remove that branch manually before retrying.` };
}

function ambiguousPullRequestCreationResult(branchName: string | null): DraftPullRequestActionResult {
  const branchDetail = branchName ? ` Sentinel left ${branchName} in place so an existing pull request is not accidentally broken.` : "";
  return { kind: "error", error: `GitHub did not confirm whether the draft pull request was created. Check GitHub before retrying.${branchDetail}` };
}

function getDraftPullRequestErrorResult(error: unknown): DraftPullRequestActionResult {
  if (error instanceof DraftPullRequestError) {
    if (error.category === "stale_base") return staleBaseResult();
    if (error.category === "github_authorization") return { kind: "error", error: "GitHub authorization is unavailable. Reconnect GitHub and try again." };
    if (error.category === "write_access" || error.category === "repository_restricted") return { kind: "error", error: "GitHub write access could not be verified for this repository." };
    if (error.category === "dependency_changed") return { kind: "error", error: "This dependency no longer has the expected update. Run analysis and validation again." };
    if (error.category === "change_verification" || error.category === "prohibited_file") return { kind: "error", error: "Sentinel could not revalidate the proposed changes against the validated repository commit." };
    if (error.category === "branch_creation") return { kind: "error", error: "GitHub could not create a new Sentinel branch for this draft PR." };
    if (error.category === "pull_request_creation") return { kind: "error", error: "GitHub could not create the draft pull request. Please try again." };
  }
  return { kind: "error", error: "GitHub could not create the draft pull request. Please try again." };
}

function getDependencySection(type: VerifiedDraftPullRequestInput["dependency"]["dependencyType"]) {
  if (type === "dependency") return "dependencies";
  if (type === "devDependency") return "devDependencies";
  if (type === "peerDependency") return "peerDependencies";
  return "optionalDependencies";
}

function isAllowedSourceFilePath(path: string) {
  if (!isSafeRepositoryFilePath(path) || path === "package.json") return false;
  const segments = path.split("/");
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const basename = segments.at(-1)?.toLowerCase();
  if (!basename || lowerSegments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment) || PROHIBITED_FILE_NAMES.has(segment) || segment.startsWith(".env"))) return false;
  if (lowerSegments[0] === ".github" && lowerSegments[1] === "workflows") return false;
  if (lowerSegments.some((segment) => segment === "secrets" || segment === "credentials" || segment === "credentials.json")) return false;
  if (basename.startsWith(".env") || PROHIBITED_FILE_NAMES.has(basename) || /^(?:generated|secrets?|credentials?)(?:[._-]|$)/i.test(basename) || basename.includes(".min.") || basename.includes(".generated.") || basename.includes(".gen.") || basename.endsWith(".d.ts")) return false;
  const extension = basename.split(".").at(-1);
  return !!extension && SOURCE_EXTENSIONS.has(extension);
}

function isSafeRepositoryFilePath(path: string) {
  if (!path || path.length > 1_000 || path.startsWith("/") || path.includes("\\") || /[\u0000-\u001F\u007F]/.test(path)) return false;
  return path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

function isSafeGitSha(value: string) {
  return /^[a-f\d]{40,64}$/i.test(value);
}

function isSafeBranchName(value: string) {
  return value.length > 0 && value.length <= 255 && !value.includes("\0") && !value.startsWith("/") && !value.endsWith("/") && !value.includes("..") && !value.includes("//");
}

function sameGitHubIdentifier(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function sameRepositoryFullName(fullName: string, owner: string, repository: string) {
  return fullName.toLowerCase() === `${owner}/${repository}`.toLowerCase();
}

function sameGitSha(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function hasUnsafeTextControlCharacters(value: string) {
  return /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function isAmbiguousGitWriteError(error: unknown) {
  return error instanceof DraftPullRequestError && (error.category === "timeout" || error.category === "request_error");
}

function isAmbiguousPullRequestCreationError(error: unknown) {
  if (!(error instanceof DraftPullRequestError)) return true;
  return error.category === "pull_request_creation" && (error.status === null || error.status === 201);
}

function isTimeoutError(error: unknown) {
  return error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError");
}

function getHttpCategory(status: number, headers?: Headers): GitHubHttpCategory {
  if (status === 429 || (status === 403 && headers?.get("x-ratelimit-remaining") === "0")) return "rate_limited";
  if (status >= 500) return "server_error";
  return "client_error";
}

function logSafePrEvent(event: string, details: Record<string, string | number | boolean | null>) {
  console.error("[sentinel:pr]", event, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
