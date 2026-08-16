import type { NormalizedPullRequestWebhook } from "../github/pull-request-webhook.ts";
import { evaluatePullRequestLifecycleTransition } from "../github/pull-request-webhook.ts";

const LIFECYCLE_TRANSACTION_OPTIONS = {
  isolationLevel: "Serializable" as const,
  maxWait: 10_000,
  timeout: 15_000,
};

type StoredPullRequest = {
  id: string;
  githubPrNodeId: string | null;
  githubPrUrl: string;
  branchName: string;
  baseBranch: string;
  status: "DRAFT" | "OPEN" | "READY_FOR_REVIEW" | "CLOSED" | "MERGED";
  githubUpdatedAt: Date | null;
  repositoryFullName: string;
};

type PullRequestUpdate = {
  status?: "DRAFT" | "READY_FOR_REVIEW" | "CLOSED" | "MERGED";
  draft?: boolean;
  githubPrNodeId?: string;
  githubUpdatedAt?: Date;
};

export type PullRequestLifecycleTransaction = {
  findDelivery(deliveryId: string): Promise<{ deliveryId: string } | null>;
  findPullRequest(repositoryId: string, pullRequestNumber: number): Promise<StoredPullRequest | null>;
  insertDelivery(input: {
    deliveryId: string;
    event: "pull_request";
    action: NormalizedPullRequestWebhook["action"];
    pullRequestId: string;
    githubUpdatedAt: Date;
  }): Promise<boolean>;
  updatePullRequest(id: string, data: PullRequestUpdate): Promise<void>;
};

export type PullRequestLifecycleStore = {
  transaction<T>(callback: (transaction: PullRequestLifecycleTransaction) => Promise<T>): Promise<T>;
};

export type PullRequestLifecycleProcessingResult =
  | { kind: "processed" }
  | { kind: "duplicate" }
  | { kind: "ignored_stale" }
  | { kind: "ignored_same_state" }
  | { kind: "unknown_pull_request" }
  | { kind: "rejected_identity" }
  | { kind: "rejected_transition" };

export type PullRequestLifecycleProcessingInput = {
  deliveryId: string;
  payload: NormalizedPullRequestWebhook;
};

/** Processes an authenticated, normalized delivery without ever creating a PR. */
export async function processPullRequestLifecycleWebhook(
  input: PullRequestLifecycleProcessingInput,
): Promise<PullRequestLifecycleProcessingResult> {
  const { getPrismaClient } = await import("./prisma");
  const client = getPrismaClient();

  return processPullRequestLifecycleWebhookWithStore(input, {
    transaction: (callback) => client.$transaction(
      (transaction) => callback({
        findDelivery: (deliveryId) => transaction.gitHubWebhookDelivery.findUnique({
          where: { deliveryId },
          select: { deliveryId: true },
        }),
        findPullRequest: async (repositoryId, pullRequestNumber) => {
          const pullRequests = await transaction.pullRequest.findMany({
            where: {
              githubPrNumber: pullRequestNumber,
              proposedFix: {
                finding: {
                  scan: {
                    repository: { githubRepositoryId: repositoryId },
                  },
                },
              },
            },
            select: {
              id: true,
              githubPrNodeId: true,
              githubPrUrl: true,
              branchName: true,
              baseBranch: true,
              status: true,
              githubUpdatedAt: true,
              proposedFix: {
                select: {
                  finding: {
                    select: {
                      scan: {
                        select: {
                          repository: { select: { fullName: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
            take: 2,
          });
          if (pullRequests.length !== 1) return null;
          const [pullRequest] = pullRequests;
          return {
            id: pullRequest.id,
            githubPrNodeId: pullRequest.githubPrNodeId,
            githubPrUrl: pullRequest.githubPrUrl,
            branchName: pullRequest.branchName,
            baseBranch: pullRequest.baseBranch,
            status: pullRequest.status,
            githubUpdatedAt: pullRequest.githubUpdatedAt,
            repositoryFullName: pullRequest.proposedFix.finding.scan.repository.fullName,
          };
        },
        insertDelivery: async (delivery) => {
          const result = await transaction.gitHubWebhookDelivery.createMany({
            data: delivery,
            skipDuplicates: true,
          });
          return result.count === 1;
        },
        updatePullRequest: async (id, data) => {
          await transaction.pullRequest.update({ where: { id }, data });
        },
      }),
      LIFECYCLE_TRANSACTION_OPTIONS,
    ),
  });
}

/** Injectable transaction core used by focused tests and the production adapter. */
export async function processPullRequestLifecycleWebhookWithStore(
  input: PullRequestLifecycleProcessingInput,
  store: PullRequestLifecycleStore,
): Promise<PullRequestLifecycleProcessingResult> {
  return store.transaction(async (transaction) => {
    const existingDelivery = await transaction.findDelivery(input.deliveryId);
    if (existingDelivery) return { kind: "duplicate" };

    const incoming = input.payload.pullRequest;
    const pullRequest = await transaction.findPullRequest(
      input.payload.repository.githubRepositoryId,
      incoming.number,
    );
    if (!pullRequest) return { kind: "unknown_pull_request" };

    if (!hasMatchingIdentity(pullRequest, input.payload)) return { kind: "rejected_identity" };

    const inserted = await transaction.insertDelivery({
      deliveryId: input.deliveryId,
      event: "pull_request",
      action: input.payload.action,
      pullRequestId: pullRequest.id,
      githubUpdatedAt: incoming.githubUpdatedAt,
    });
    if (!inserted) return { kind: "duplicate" };

    const transition = evaluatePullRequestLifecycleTransition(
      { status: pullRequest.status, githubUpdatedAt: pullRequest.githubUpdatedAt },
      {
        action: input.payload.action,
        status: incoming.status,
        githubUpdatedAt: incoming.githubUpdatedAt,
      },
    );
    const nodeBackfill = pullRequest.githubPrNodeId === null
      ? { githubPrNodeId: incoming.nodeId }
      : {};

    if (transition.kind === "apply") {
      await transaction.updatePullRequest(pullRequest.id, {
        ...nodeBackfill,
        status: transition.status,
        draft: transition.draft,
        githubUpdatedAt: transition.githubUpdatedAt,
      });
      return { kind: "processed" };
    }

    if (transition.reason === "stale_event") {
      if (pullRequest.githubPrNodeId === null) {
        await transaction.updatePullRequest(pullRequest.id, nodeBackfill);
      }
      return { kind: "ignored_stale" };
    }

    if (transition.reason === "no_change") {
      const shouldAdvanceTimestamp = pullRequest.githubUpdatedAt === null
        || incoming.githubUpdatedAt.getTime() > pullRequest.githubUpdatedAt.getTime();
      if (pullRequest.githubPrNodeId === null || shouldAdvanceTimestamp) {
        await transaction.updatePullRequest(pullRequest.id, {
          ...nodeBackfill,
          ...(shouldAdvanceTimestamp ? { githubUpdatedAt: incoming.githubUpdatedAt } : {}),
        });
      }
      return { kind: "ignored_same_state" };
    }

    if (pullRequest.githubPrNodeId === null) {
      await transaction.updatePullRequest(pullRequest.id, nodeBackfill);
    }
    return { kind: "rejected_transition" };
  });
}

function hasMatchingIdentity(
  stored: StoredPullRequest,
  payload: NormalizedPullRequestWebhook,
) {
  const incoming = payload.pullRequest;
  return sameIdentifier(stored.repositoryFullName, payload.repository.fullName)
    && samePullRequestUrl(stored.githubPrUrl, incoming.url)
    && stored.branchName === incoming.headBranch
    && stored.baseBranch === incoming.baseBranch
    && (stored.githubPrNodeId === null || stored.githubPrNodeId === incoming.nodeId);
}

function sameIdentifier(left: string, right: string) {
  return left.toLowerCase() === right.toLowerCase();
}

function samePullRequestUrl(left: string, right: string) {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    return leftUrl.protocol === "https:"
      && rightUrl.protocol === "https:"
      && leftUrl.hostname === "github.com"
      && rightUrl.hostname === "github.com"
      && !leftUrl.username
      && !rightUrl.username
      && !leftUrl.password
      && !rightUrl.password
      && !leftUrl.port
      && !rightUrl.port
      && !leftUrl.search
      && !rightUrl.search
      && !leftUrl.hash
      && !rightUrl.hash
      && leftUrl.pathname.toLowerCase() === rightUrl.pathname.toLowerCase();
  } catch {
    return false;
  }
}
