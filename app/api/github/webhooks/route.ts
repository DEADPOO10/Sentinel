import { processPullRequestLifecycleWebhook } from "@/lib/db/pull-request-lifecycle";
import { createGitHubWebhookPostHandler } from "@/lib/github/github-webhook-route";

export const runtime = "nodejs";

const handlePost = createGitHubWebhookPostHandler({
  getSecret: () => process.env.SENTINEL_GITHUB_WEBHOOK_SECRET,
  processPullRequest: processPullRequestLifecycleWebhook,
});

export async function POST(request: Request) {
  return handlePost(request);
}
