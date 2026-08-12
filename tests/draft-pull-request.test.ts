import assert from "node:assert/strict";
import test from "node:test";
import {
  DRAFT_PR_MAX_BODY_CHARACTERS,
  createDraftPrBranchPayload,
  createDraftPrRequestCoordinator,
  createDraftPullRequestBody,
  createDraftPullRequestPayload,
  createSentinelBranchName,
  getAuthorizedDraftPrChangeFailure,
  isDraftPrValidationEligible,
  isDraftPullRequestCreationEnabled,
  isMatchingSentinelPullRequest,
  isValidatedRepositoryHeadCurrent,
  updateAuthorizedPackageJson,
  type DraftPrValidation,
} from "../lib/github/draft-pull-request-policy.ts";

const baseCommitSha = "a".repeat(40);

function validation(overrides: Partial<DraftPrValidation> = {}): DraftPrValidation {
  return {
    overallStatus: "passed",
    baseBranch: "main",
    baseCommitSha,
    install: { status: "passed", summary: "Installed with lifecycle scripts disabled." },
    checks: ["typecheck", "lint", "test", "build"].map((name) => ({
      name: name as "typecheck" | "lint" | "test" | "build",
      status: "passed" as const,
      durationMs: 10,
      summary: "Completed.",
    })),
    warnings: [],
    partialReasons: [],
    ...overrides,
  };
}

const dependency = {
  name: "supertest",
  declaredVersion: "^6.3.4",
  latestVersion: "7.1.4",
  dependencyType: "devDependency" as const,
};

const packageChange = {
  required: true,
  dependency: "supertest",
  from: "^6.3.4",
  to: "7.1.4",
};

test("Draft PR creation is disabled unless the flag is exactly true", () => {
  assert.equal(isDraftPullRequestCreationEnabled(undefined), false);
  assert.equal(isDraftPullRequestCreationEnabled("false"), false);
  assert.equal(isDraftPullRequestCreationEnabled("TRUE"), false);
  assert.equal(isDraftPullRequestCreationEnabled("true"), true);
});

test("validation eligibility fails closed for failed, unable, timeout, and cleanup-uncertain results", () => {
  assert.equal(isDraftPrValidationEligible(null), false);
  assert.equal(isDraftPrValidationEligible(validation()), true);
  assert.equal(isDraftPrValidationEligible(validation({ overallStatus: "failed" })), false);
  assert.equal(isDraftPrValidationEligible(validation({ overallStatus: "unable_to_validate" })), false);
  assert.equal(isDraftPrValidationEligible(validation({
    overallStatus: "partial",
    checks: validation().checks.map((check) => check.name === "test" ? { ...check, status: "timed_out" } : check),
    partialReasons: ["validation_timeout"],
  })), false);
  assert.equal(isDraftPrValidationEligible(validation({
    overallStatus: "partial",
    checks: validation().checks.map((check) => check.name === "build" ? { ...check, status: "skipped" } : check),
    partialReasons: ["cleanup_unconfirmed"],
  })), false);
});

test("only explicitly safe partial validation outcomes are eligible", () => {
  const checks = validation().checks.map((check) => check.name === "build" ? { ...check, status: "skipped" as const } : check);
  assert.equal(isDraftPrValidationEligible(validation({ overallStatus: "partial", checks, partialReasons: ["skipped_checks"] })), true);
  assert.equal(isDraftPrValidationEligible(validation({ overallStatus: "partial", checks, partialReasons: ["no_lockfile_fallback"] })), true);
  assert.equal(isDraftPrValidationEligible(validation({ overallStatus: "partial", checks, partialReasons: [] })), false);
});

test("the authorized V1 change surface is package.json only and rejects stale lockfiles", () => {
  const proposal = { files: [], packageJsonChange: packageChange };
  assert.equal(getAuthorizedDraftPrChangeFailure(proposal, ["package.json", "src/app.ts"]), null);
  assert.equal(getAuthorizedDraftPrChangeFailure({ ...proposal, files: [{ path: "src/app.ts" }] }, ["package.json"]), "source_changes_not_allowed");
  assert.equal(getAuthorizedDraftPrChangeFailure({ files: [], packageJsonChange: { ...packageChange, required: false } }, ["package.json"]), "package_json_change_required");
  for (const lockfile of ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
    assert.equal(getAuthorizedDraftPrChangeFailure(proposal, ["package.json", lockfile]), "lockfile_artifact_required", lockfile);
  }
  assert.equal(getAuthorizedDraftPrChangeFailure(proposal, ["packages/example/package-lock.json"]), null);
});

test("package.json update requires an exact server-revalidated dependency value and section", () => {
  const manifest = `{
  "name": "example",
  "scripts": { "test": "node --test" },
  "devDependencies": { "supertest": "^6.3.4", "typescript": "^5.0.0" }
}\n`;
  const updated = updateAuthorizedPackageJson(manifest, dependency, packageChange);
  assert.ok(updated);
  assert.equal(updated.replace('"supertest": "7.1.4"', '"supertest": "^6.3.4"'), manifest);
  assert.equal(JSON.parse(updated).devDependencies.supertest, "7.1.4");
  assert.equal(updateAuthorizedPackageJson(manifest.replace("^6.3.4", "^6.3.5"), dependency, packageChange), null);
  assert.equal(updateAuthorizedPackageJson(manifest, { ...dependency, dependencyType: "dependency" }, packageChange), null);
  assert.equal(updateAuthorizedPackageJson(manifest, dependency, { ...packageChange, to: "8.0.0" }), null);
  assert.equal(updateAuthorizedPackageJson("not json", dependency, packageChange), null);
});

test("repository HEAD verification binds owner, repository, branch, SHA, and write access", () => {
  const expected = { owner: "DEADPOO10", repository: "express", defaultBranch: "master", baseCommitSha };
  const actual = { owner: "deadpoo10", repository: "EXPRESS", defaultBranch: "master", baseCommitSha: baseCommitSha.toUpperCase(), writeAccess: true };
  assert.equal(isValidatedRepositoryHeadCurrent({ expected, actual }), true);
  assert.equal(isValidatedRepositoryHeadCurrent({ expected, actual: { ...actual, baseCommitSha: "b".repeat(40) } }), false);
  assert.equal(isValidatedRepositoryHeadCurrent({ expected, actual: { ...actual, defaultBranch: "main" } }), false);
  assert.equal(isValidatedRepositoryHeadCurrent({ expected, actual: { ...actual, writeAccess: false } }), false);
});

test("branch names are deterministic, bounded, and isolated under sentinel/deps", () => {
  const first = createSentinelBranchName("@scope/package name", "ABC_def-1234567890_more");
  assert.equal(first, "sentinel/deps/scope-package-name/abcdef123456");
  assert.equal(createSentinelBranchName("@scope/package name", "ABC_def-1234567890_more"), first);
  assert.ok(first.length <= 96);
  assert.match(first, /^sentinel\/deps\/[a-z0-9-]+\/[a-z0-9]+$/);
});

test("the GitHub payload is always a draft and never requests merge or ready-for-review", () => {
  const input = {
    defaultBranch: "master",
    dependency,
    validation: validation(),
    impactAnalysis: { summary: "Review request/response assertions after the upgrade." },
    proposedChangeIdentifier: "change-id",
  };
  const payload = createDraftPullRequestPayload(input, "sentinel/deps/supertest/changeid");
  assert.equal(payload.draft, true);
  assert.equal(payload.maintainer_can_modify, false);
  assert.equal("merge" in payload, false);
  assert.equal("ready_for_review" in payload, false);
});

test("branch creation is bound to the exact validated commit SHA", () => {
  assert.deepEqual(
    createDraftPrBranchPayload("sentinel/deps/supertest/changeid", baseCommitSha),
    { ref: "refs/heads/sentinel/deps/supertest/changeid", sha: baseCommitSha },
  );
});

test("PR body is bounded, review-oriented, status-only, and redacts common credentials", () => {
  const result = validation({
    install: { status: "passed", summary: "SECRET INSTALL OUTPUT" },
    checks: validation().checks.map((check) => ({ ...check, summary: "SECRET CHECK OUTPUT" })),
  });
  const body = createDraftPullRequestBody({
    defaultBranch: "master",
    dependency,
    validation: result,
    impactAnalysis: { summary: `Bearer example-secret-token OPENAI_API_KEY=sk-${"a".repeat(32)} ${"x".repeat(20_000)}` },
    proposedChangeIdentifier: "change-id",
  });
  assert.ok(body.length <= DRAFT_PR_MAX_BODY_CHARACTERS);
  assert.match(body, /Created as Draft/);
  assert.match(body, /Human review required/);
  assert.match(body, /does not auto-merge/);
  assert.doesNotMatch(body, /SECRET INSTALL OUTPUT|SECRET CHECK OUTPUT|example-secret-token|sk-aaaaaaaa/);
});

test("existing PR matching is scoped to the exact proposal marker, branch namespace, and repository", () => {
  const candidate = {
    body: "Review required.\n<!-- sentinel-change-id:change-id -->",
    branchName: "sentinel/deps/supertest/changeid",
    repositoryFullName: "DEADPOO10/express",
    owner: "deadpoo10",
    repository: "EXPRESS",
    proposedChangeIdentifier: "change-id",
  };
  assert.equal(isMatchingSentinelPullRequest(candidate), true);
  assert.equal(isMatchingSentinelPullRequest({ ...candidate, branchName: "feature/changeid" }), false);
  assert.equal(isMatchingSentinelPullRequest({ ...candidate, repositoryFullName: "other/express" }), false);
  assert.equal(isMatchingSentinelPullRequest({ ...candidate, proposedChangeIdentifier: "another-id" }), false);
});

test("concurrent duplicate clicks share one in-flight creation and later attempts may retry", async () => {
  const coordinator = createDraftPrRequestCoordinator<number>();
  let creations = 0;
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const create = async () => {
    creations += 1;
    await blocked;
    return creations;
  };
  const first = coordinator.run("signed-ticket", create);
  const second = coordinator.run("signed-ticket", create);
  assert.strictEqual(first, second);
  assert.equal(creations, 1);
  release?.();
  assert.equal(await first, 1);
  assert.equal(await coordinator.run("signed-ticket", async () => ++creations), 2);
});
