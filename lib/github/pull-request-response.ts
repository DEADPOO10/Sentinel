const GITHUB_NODE_ID_PATTERN = /^[A-Za-z0-9_=-]{1,255}$/;
const GITHUB_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const GITHUB_PULL_REQUEST_NUMBER_MAX = 2_147_483_647;

export type GitHubPullRequestResponseIdentity = {
  prNumber: number;
  prUrl: string;
  nodeId: string;
  githubUpdatedAt: string;
};

export type GitHubPullRequestPersistenceFields = {
  githubPrNodeId: string;
  githubUpdatedAt: Date;
  status: "DRAFT" | "READY_FOR_REVIEW";
};

/** Extracts only stable identity fields from a GitHub pull-request response. */
export function parseGitHubPullRequestResponseIdentity(
  value: unknown,
): GitHubPullRequestResponseIdentity | null {
  if (!isRecord(value)) return null;
  if (!isPullRequestNumber(value.number)
    || !isGitHubPullRequestUrl(value.html_url, value.number)
    || !isNodeId(value.node_id)
    || !isTimestamp(value.updated_at)) return null;

  return {
    prNumber: value.number,
    prUrl: value.html_url,
    nodeId: value.node_id,
    githubUpdatedAt: value.updated_at,
  };
}

/** Converts confirmed GitHub identity into the fields persisted for newly seen PRs. */
export function getGitHubPullRequestPersistenceFields(value: {
  nodeId: unknown;
  githubUpdatedAt: unknown;
  draft: unknown;
}): GitHubPullRequestPersistenceFields | null {
  if (!isNodeId(value.nodeId) || !isTimestamp(value.githubUpdatedAt) || typeof value.draft !== "boolean") {
    return null;
  }
  return {
    githubPrNodeId: value.nodeId,
    githubUpdatedAt: new Date(value.githubUpdatedAt),
    status: value.draft ? "DRAFT" : "READY_FOR_REVIEW",
  };
}

function isPullRequestNumber(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= GITHUB_PULL_REQUEST_NUMBER_MAX;
}

function isGitHubPullRequestUrl(value: unknown, number: number): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && url.pathname.toLowerCase().endsWith(`/pull/${number}`);
  } catch {
    return false;
  }
}

function isNodeId(value: unknown): value is string {
  return typeof value === "string" && GITHUB_NODE_ID_PATTERN.test(value);
}

function isTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !GITHUB_TIMESTAMP_PATTERN.test(value)) return false;
  return Number.isFinite(new Date(value).getTime());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
