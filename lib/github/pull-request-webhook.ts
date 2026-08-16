const SUPPORTED_PULL_REQUEST_ACTIONS = new Set([
  "ready_for_review",
  "converted_to_draft",
  "closed",
  "reopened",
] as const);

const GITHUB_PULL_REQUEST_NUMBER_MAX = 2_147_483_647;
const GITHUB_NODE_ID_PATTERN = /^[A-Za-z0-9_=-]{1,255}$/;
const GIT_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const GITHUB_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export type SupportedPullRequestWebhookAction =
  | "ready_for_review"
  | "converted_to_draft"
  | "closed"
  | "reopened";

export type PullRequestLifecycleStatus =
  | "DRAFT"
  | "READY_FOR_REVIEW"
  | "CLOSED"
  | "MERGED";

export type StoredPullRequestLifecycleStatus = PullRequestLifecycleStatus | "OPEN";

export type NormalizedPullRequestWebhook = {
  action: SupportedPullRequestWebhookAction;
  repository: {
    githubRepositoryId: string;
    fullName: string;
  };
  pullRequest: {
    number: number;
    nodeId: string;
    url: string;
    state: "open" | "closed";
    draft: boolean;
    merged: boolean;
    status: PullRequestLifecycleStatus;
    githubUpdatedAt: Date;
    baseBranch: string;
    headBranch: string;
  };
};

export type PullRequestLifecycleTransition =
  | {
    kind: "apply";
    status: PullRequestLifecycleStatus;
    draft: boolean;
    githubUpdatedAt: Date;
  }
  | {
    kind: "ignore";
    reason: "stale_event" | "merged_terminal" | "no_change" | "invalid_transition";
  };

/** Parses only the authenticated pull-request fields Sentinel will later persist. */
export function parsePullRequestWebhookPayload(value: unknown): NormalizedPullRequestWebhook | null {
  if (!isRecord(value) || !isSupportedPullRequestWebhookAction(value.action)) return null;
  if (!isRecord(value.repository) || !isRecord(value.pull_request)) return null;

  const repositoryId = getGitHubIdentifier(value.repository.id);
  const repositoryFullName = getRepositoryFullName(value.repository.full_name);
  if (!repositoryId || !repositoryFullName) return null;

  const pullRequest = value.pull_request;
  const number = getPullRequestNumber(pullRequest.number);
  const eventNumber = getPullRequestNumber(value.number);
  const nodeId = getGitHubNodeId(pullRequest.node_id);
  const state = pullRequest.state === "open" || pullRequest.state === "closed" ? pullRequest.state : null;
  const draft = typeof pullRequest.draft === "boolean" ? pullRequest.draft : null;
  const merged = typeof pullRequest.merged === "boolean" ? pullRequest.merged : null;
  const githubUpdatedAt = getGitHubTimestamp(pullRequest.updated_at);
  const baseBranch = getBranchFromReference(pullRequest.base);
  const headBranch = getBranchFromReference(pullRequest.head);

  if (!number || eventNumber !== number || !nodeId || !state || draft === null || merged === null
    || !githubUpdatedAt || !baseBranch || !headBranch) return null;

  const url = getPullRequestUrl(pullRequest.html_url, repositoryFullName, number);
  const status = getPullRequestLifecycleStatus({ state, draft, merged });
  if (!url || !status || !actionMatchesStatus(value.action, status)) return null;

  return {
    action: value.action,
    repository: {
      githubRepositoryId: repositoryId,
      fullName: repositoryFullName,
    },
    pullRequest: {
      number,
      nodeId,
      url,
      state,
      draft,
      merged,
      status,
      githubUpdatedAt,
      baseBranch,
      headBranch,
    },
  };
}

/** Derives lifecycle from GitHub state fields rather than trusting the event action. */
export function getPullRequestLifecycleStatus(input: {
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
}): PullRequestLifecycleStatus | null {
  if (input.state === "open") {
    if (input.merged) return null;
    return input.draft ? "DRAFT" : "READY_FOR_REVIEW";
  }

  return input.merged ? "MERGED" : "CLOSED";
}

/**
 * Applies only supported lifecycle transitions while guarding terminal and stale state.
 * OPEN is accepted only as the temporary legacy equivalent of READY_FOR_REVIEW.
 */
export function evaluatePullRequestLifecycleTransition(
  current: {
    status: StoredPullRequestLifecycleStatus;
    githubUpdatedAt: Date | null;
  },
  incoming: Pick<NormalizedPullRequestWebhook, "action"> & {
    status: PullRequestLifecycleStatus;
    githubUpdatedAt: Date;
  },
): PullRequestLifecycleTransition {
  const currentStatus = current.status === "OPEN" ? "READY_FOR_REVIEW" : current.status;
  const currentUpdatedAt = current.githubUpdatedAt?.getTime() ?? null;
  const incomingUpdatedAt = incoming.githubUpdatedAt.getTime();

  if (!Number.isFinite(incomingUpdatedAt)) return { kind: "ignore", reason: "invalid_transition" };
  if (currentUpdatedAt !== null && incomingUpdatedAt < currentUpdatedAt) {
    return { kind: "ignore", reason: "stale_event" };
  }

  if (currentStatus === "MERGED") {
    return incoming.status === "MERGED"
      ? { kind: "ignore", reason: "no_change" }
      : { kind: "ignore", reason: "merged_terminal" };
  }

  if (currentStatus === incoming.status) return { kind: "ignore", reason: "no_change" };
  if (!isAllowedTransition(currentStatus, incoming.action, incoming.status)) {
    return { kind: "ignore", reason: "invalid_transition" };
  }

  return {
    kind: "apply",
    status: incoming.status,
    draft: incoming.status === "DRAFT",
    githubUpdatedAt: incoming.githubUpdatedAt,
  };
}

function isAllowedTransition(
  current: PullRequestLifecycleStatus,
  action: SupportedPullRequestWebhookAction,
  target: PullRequestLifecycleStatus,
) {
  if (current === "DRAFT" && action === "ready_for_review" && target === "READY_FOR_REVIEW") return true;
  if (current === "READY_FOR_REVIEW" && action === "converted_to_draft" && target === "DRAFT") return true;
  if ((current === "DRAFT" || current === "READY_FOR_REVIEW")
    && action === "closed"
    && (target === "CLOSED" || target === "MERGED")) return true;
  if (current === "CLOSED" && action === "reopened" && (target === "DRAFT" || target === "READY_FOR_REVIEW")) return true;

  // A merge is authoritative even if Sentinel missed the intermediate reopened delivery.
  return current === "CLOSED" && action === "closed" && target === "MERGED";
}

function actionMatchesStatus(action: SupportedPullRequestWebhookAction, status: PullRequestLifecycleStatus) {
  if (action === "ready_for_review") return status === "READY_FOR_REVIEW";
  if (action === "converted_to_draft") return status === "DRAFT";
  if (action === "closed") return status === "CLOSED" || status === "MERGED";
  return status === "DRAFT" || status === "READY_FOR_REVIEW";
}

export function isSupportedPullRequestWebhookAction(value: unknown): value is SupportedPullRequestWebhookAction {
  return typeof value === "string" && SUPPORTED_PULL_REQUEST_ACTIONS.has(value as SupportedPullRequestWebhookAction);
}

function getGitHubIdentifier(value: unknown) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) ? value : null;
}

function getPullRequestNumber(value: unknown) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= GITHUB_PULL_REQUEST_NUMBER_MAX
    ? value
    : null;
}

function getGitHubNodeId(value: unknown) {
  return typeof value === "string" && GITHUB_NODE_ID_PATTERN.test(value) ? value : null;
}

function getRepositoryFullName(value: unknown) {
  if (typeof value !== "string" || value.length > 201 || /[\u0000-\u001F\u007F]/.test(value)) return null;
  const segments = value.split("/");
  if (segments.length !== 2) return null;
  const [owner, repository] = segments;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner)
    || !/^[A-Za-z0-9._-]{1,100}$/.test(repository)
    || repository === "."
    || repository === "..") return null;
  return `${owner}/${repository}`;
}

function getBranchFromReference(value: unknown) {
  if (!isRecord(value)) return null;
  const reference = value.ref;
  return typeof reference === "string"
    && GIT_REFERENCE_PATTERN.test(reference)
    && !reference.includes("..")
    && !reference.includes("//")
    && !reference.endsWith("/")
    ? reference
    : null;
}

function getGitHubTimestamp(value: unknown) {
  if (typeof value !== "string" || !GITHUB_TIMESTAMP_PATTERN.test(value)) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

function getPullRequestUrl(value: unknown, repositoryFullName: string, number: number) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const expectedPath = `/${repositoryFullName}/pull/${number}`.toLowerCase();
    return url.protocol === "https:"
      && url.hostname === "github.com"
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && url.pathname.toLowerCase() === expectedPath
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
