export const DRAFT_PR_MAX_BRANCH_NAME_LENGTH = 96;
export const DRAFT_PR_MAX_BODY_CHARACTERS = 12_000;
export const DRAFT_PR_SUPPORTED_ROOT_LOCKFILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

export type DraftPrPublicErrorCategory =
  | "pr_creation_disabled"
  | "validation_required"
  | "validation_not_eligible"
  | "repository_changed_since_validation"
  | "proposed_fix_stale"
  | "source_changes_not_allowed"
  | "lockfile_artifact_required"
  | "validated_lockfile_required"
  | "validated_lockfile_invalid"
  | "github_write_permission_required"
  | "branch_conflict"
  | "github_write_failed";

export type DraftPrValidation = {
  overallStatus: "passed" | "failed" | "partial" | "unable_to_validate";
  baseBranch: string | null;
  baseCommitSha: string | null;
  install: { status: "passed" | "failed" | "skipped"; summary: string };
  checks: Array<{
    name: "typecheck" | "lint" | "test" | "build";
    status: "passed" | "failed" | "skipped" | "timed_out";
    durationMs: number;
    summary: string;
  }>;
  warnings: string[];
  partialReasons: Array<"skipped_checks" | "no_lockfile_fallback" | "cleanup_unconfirmed" | "validation_timeout">;
};

type DraftPrProposal = {
  files: Array<{ path: string }>;
  packageJsonChange: {
    required: boolean;
    dependency: string;
    from: string;
    to: string;
  };
};

type DraftPrDependency = {
  name: string;
  declaredVersion: string;
  latestVersion: string;
  dependencyType: "dependency" | "devDependency" | "peerDependency" | "optionalDependency";
};

type DraftPrDescriptionInput = {
  defaultBranch: string;
  dependency: {
    name: string;
    declaredVersion: string;
    latestVersion: string;
  };
  validation: DraftPrValidation;
  impactAnalysis: { summary: string };
  proposedChangeIdentifier: string;
};

export function isDraftPullRequestCreationEnabled(value: string | undefined) {
  return value === "true";
}

/** One authoritative eligibility decision shared by ticket issuance and PR creation. */
export function isDraftPrValidationEligible(result: DraftPrValidation | null | undefined) {
  if (!result) return false;
  if (!result.baseBranch || !result.baseCommitSha || result.install.status !== "passed") return false;
  if (result.checks.some((check) => check.status === "failed" || check.status === "timed_out")) return false;

  const hasPassedCheck = result.checks.some((check) => check.status === "passed");
  if (!hasPassedCheck) return false;

  if (result.overallStatus === "passed") {
    return result.partialReasons.length === 0 && result.checks.every((check) => check.status === "passed");
  }
  if (result.overallStatus !== "partial" || result.partialReasons.length === 0) return false;

  return result.partialReasons.every((reason) => reason === "skipped_checks" || reason === "no_lockfile_fallback");
}

/** V1 authorizes package.json only and refuses to leave a root lockfile stale. */
export function getAuthorizedDraftPrChangeFailure(
  proposal: DraftPrProposal,
  repositoryPaths: Iterable<string>,
  validatedPackageLockArtifact: { kind: "npm_package_lock"; path: "package-lock.json" } | null = null,
): "source_changes_not_allowed" | "package_json_change_required" | "lockfile_artifact_required" | "validated_lockfile_required" | "validated_lockfile_invalid" | null {
  const authorization = getAuthorizedDraftPrFilePaths(proposal, repositoryPaths, validatedPackageLockArtifact);
  return authorization.kind === "authorized" ? null : authorization.category;
}

export function getAuthorizedDraftPrFilePaths(
  proposal: DraftPrProposal,
  repositoryPaths: Iterable<string>,
  validatedPackageLockArtifact: { kind: "npm_package_lock"; path: "package-lock.json" } | null = null,
): { kind: "authorized"; paths: ["package.json"] | ["package.json", "package-lock.json"] } | { kind: "rejected"; category: "source_changes_not_allowed" | "package_json_change_required" | "lockfile_artifact_required" | "validated_lockfile_required" | "validated_lockfile_invalid" } {
  if (proposal.files.length > 0) return { kind: "rejected", category: "source_changes_not_allowed" };
  if (!proposal.packageJsonChange.required) return { kind: "rejected", category: "package_json_change_required" };
  const rootPaths = new Set(repositoryPaths);
  const hasNpmPackageLock = rootPaths.has("package-lock.json");
  const hasUnsupportedLockfile = [...DRAFT_PR_SUPPORTED_ROOT_LOCKFILES].some((path) => path !== "package-lock.json" && rootPaths.has(path));
  if (hasUnsupportedLockfile) return { kind: "rejected", category: "lockfile_artifact_required" };
  if (hasNpmPackageLock && !validatedPackageLockArtifact) return { kind: "rejected", category: "validated_lockfile_required" };
  if (!hasNpmPackageLock && validatedPackageLockArtifact) return { kind: "rejected", category: "validated_lockfile_invalid" };
  if (hasNpmPackageLock) {
    if (validatedPackageLockArtifact?.kind !== "npm_package_lock" || validatedPackageLockArtifact.path !== "package-lock.json") return { kind: "rejected", category: "validated_lockfile_invalid" };
    return { kind: "authorized", paths: ["package.json", "package-lock.json"] };
  }
  return { kind: "authorized", paths: ["package.json"] };
}

export function updateAuthorizedPackageJson(
  content: string,
  dependency: DraftPrDependency,
  change: DraftPrProposal["packageJsonChange"],
) {
  const section = getDependencySection(dependency.dependencyType);
  if (!change.required
    || change.dependency !== dependency.name
    || change.from !== dependency.declaredVersion
    || change.to !== dependency.latestVersion) return null;

  try {
    const manifest: unknown = JSON.parse(content);
    if (!isRecord(manifest)
      || !isRecord(manifest[section])
      || manifest[section][dependency.name] !== dependency.declaredVersion) return null;
  } catch {
    return null;
  }

  const valueLocation = findJsonObjectStringValue(content, section, dependency.name);
  if (!valueLocation || valueLocation.value !== dependency.declaredVersion) return null;
  return `${content.slice(0, valueLocation.start)}${JSON.stringify(dependency.latestVersion)}${content.slice(valueLocation.end)}`;
}

export function isValidatedRepositoryHeadCurrent(input: {
  expected: { owner: string; repository: string; defaultBranch: string; baseCommitSha: string };
  actual: { owner: string; repository: string; defaultBranch: string; baseCommitSha: string; writeAccess: boolean };
}) {
  return input.actual.writeAccess
    && input.actual.owner.toLowerCase() === input.expected.owner.toLowerCase()
    && input.actual.repository.toLowerCase() === input.expected.repository.toLowerCase()
    && input.actual.defaultBranch === input.expected.defaultBranch
    && input.actual.baseCommitSha.toLowerCase() === input.expected.baseCommitSha.toLowerCase();
}

export function isMatchingSentinelPullRequest(input: {
  body: string;
  branchName: string;
  repositoryFullName: string;
  owner: string;
  repository: string;
  proposedChangeIdentifier: string;
}) {
  return input.body.includes(getDraftPrMarker(input.proposedChangeIdentifier))
    && input.branchName.startsWith("sentinel/deps/")
    && input.repositoryFullName.toLowerCase() === `${input.owner}/${input.repository}`.toLowerCase();
}

export function createDraftPrRequestCoordinator<T>() {
  const active = new Map<string, Promise<T>>();
  return {
    run(key: string, create: () => Promise<T>) {
      const existing = active.get(key);
      if (existing) return existing;
      const request = create().finally(() => active.delete(key));
      active.set(key, request);
      return request;
    },
  };
}

export function createSentinelBranchName(
  dependencyName: string,
  proposedChangeIdentifier: string,
) {
  const dependencySegment = sanitizeBranchSegment(dependencyName, "dependency", 48);
  const suffix = proposedChangeIdentifier.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12) || "proposal";
  const branch = `sentinel/deps/${dependencySegment}/${suffix}`;
  return branch.slice(0, DRAFT_PR_MAX_BRANCH_NAME_LENGTH).replace(/[-./]+$/, "");
}

export function createDraftPullRequestPayload(input: DraftPrDescriptionInput, branchName: string) {
  return {
    title: getDraftPrCommitMessage(input.dependency.name, input.dependency.latestVersion),
    head: branchName,
    base: input.defaultBranch,
    draft: true as const,
    maintainer_can_modify: false,
    body: createDraftPullRequestBody(input),
  };
}

export function createDraftPrBranchPayload(branchName: string, commitSha: string) {
  return {
    ref: `refs/heads/${branchName}`,
    sha: commitSha,
  };
}

export function getDraftPrCommitMessage(dependencyName: string, targetVersion: string) {
  const safeDependency = safeInlineText(dependencyName, 214) || "dependency";
  const safeVersion = safeInlineText(targetVersion, 100) || "new version";
  return `chore(deps): update ${safeDependency} to ${safeVersion}`.slice(0, 240);
}

export function createDraftPullRequestBody(input: DraftPrDescriptionInput) {
  const summary = redactSensitiveText(input.impactAnalysis.summary);
  const checks = [
    `- Install: ${formatStatus(input.validation.install.status)}`,
    ...input.validation.checks.map((check) => `- ${formatCheckName(check.name)}: ${formatStatus(check.status)}`),
  ];
  const body = `## Summary

Dependency upgrade proposed by Sentinel.

## Change

${safeInlineText(input.dependency.name, 214)}: ${safeInlineText(input.dependency.declaredVersion, 300)} → ${safeInlineText(input.dependency.latestVersion, 300)}

## AI Impact Analysis

${summary || "Sentinel identified this update for developer review."}

## Validation

Overall result: ${formatStatus(input.validation.overallStatus)}

${checks.join("\n")}

## Safety

- Created as Draft
- Human review required
- Sentinel does not auto-merge

${getDraftPrMarker(input.proposedChangeIdentifier)}`;

  return body.slice(0, DRAFT_PR_MAX_BODY_CHARACTERS);
}

function sanitizeBranchSegment(value: string, fallback: string, maximumLength: number) {
  const normalized = value.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, maximumLength).replace(/-+$/, "") || fallback;
}

function safeInlineText(value: string, maximumLength: number) {
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximumLength);
}

function redactSensitiveText(value: string) {
  const normalized = safeInlineText(value, 1_000)
    .replace(/\b(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]{16,}\b/g, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    .replace(/\b(?:postgres(?:ql)?):\/\/\S+/gi, "[redacted]")
    .replace(/\b(?:AUTH_SECRET|DATABASE_URL|OPENAI_API_KEY|SENTINEL_VALIDATION_WORKER_SHARED_SECRET)\s*[=:]\s*\S+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  if (/\b(?:safe to merge|bug[- ]free|production[- ]ready|tests? (?:pass|passed))\b/i.test(normalized)) {
    return "Sentinel identified this update for developer review based on the verified dependency and validation context.";
  }
  return normalized;
}

function formatStatus(status: string) {
  return status.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatCheckName(name: string) {
  if (name === "typecheck") return "Typecheck";
  if (name === "test") return "Tests";
  return name ? `${name[0].toUpperCase()}${name.slice(1)}` : name;
}

function getDraftPrMarker(proposedChangeIdentifier: string) {
  return `<!-- sentinel-change-id:${proposedChangeIdentifier} -->`;
}

function getDependencySection(type: DraftPrDependency["dependencyType"]) {
  if (type === "dependency") return "dependencies";
  if (type === "devDependency") return "devDependencies";
  if (type === "peerDependency") return "peerDependencies";
  return "optionalDependencies";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
