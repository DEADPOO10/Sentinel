import type { RepositoryDetail } from "@/types/repository-details";

const repositoryDetails: RepositoryDetail[] = [
  {
    id: "acme-payments-api",
    name: "payments-api",
    fullName: "acme/payments-api",
    defaultBranch: "main",
    healthScore: 92,
    riskLevel: "medium",
    latestScan: "Today, 10:42 AM",
    aiSummary: "Your repository is in good health. Two dependency updates need review; one includes a payment flow API change that is already covered by a prepared pull request.",
    dependencies: [
      { name: "stripe", currentVersion: "18.3.0", latestVersion: "19.1.0", status: "breaking-change" },
      { name: "zod", currentVersion: "3.24.1", latestVersion: "3.24.4", status: "update-available" },
      { name: "next", currentVersion: "15.5.2", latestVersion: "15.5.22", status: "update-available" },
    ],
    breakingChanges: [
      { title: "PaymentIntent confirmation shape changed", packageName: "stripe@19.1.0", summary: "Confirmation parameters now require an explicit payment method configuration in one of your checkout paths.", status: "review" },
      { title: "Legacy webhook helper deprecated", packageName: "stripe@19.1.0", summary: "The deprecated signature helper is still supported, but should be replaced before the next major release.", status: "monitoring" },
    ],
    recommendedFixes: [
      "Upgrade Stripe with the prepared compatibility changes.",
      "Replace the legacy webhook signature helper in api/webhooks/stripe.ts.",
      "Schedule the Next.js patch update in the next maintenance window.",
    ],
    pullRequests: [
      { number: 184, title: "chore: upgrade Stripe SDK to v19", branch: "sentinel/upgrade-stripe-v19", status: "ready" },
      { number: 185, title: "fix: migrate webhook signature helper", branch: "sentinel/migrate-webhook-helper", status: "reviewing" },
    ],
    timeline: [
      { title: "Pull request prepared", detail: "Compatibility changes for Stripe v19 are ready for review.", timestamp: "12 min ago", kind: "pull-request" },
      { title: "Breaking change identified", detail: "PaymentIntent confirmation requires an update.", timestamp: "18 min ago", kind: "alert" },
      { title: "Stripe v19.1.0 released", detail: "Release notes were added to the dependency graph.", timestamp: "27 min ago", kind: "release" },
      { title: "Repository scan completed", detail: "42 dependencies analyzed across the main branch.", timestamp: "31 min ago", kind: "scan" },
    ],
    releases: [
      { packageName: "stripe", version: "v19.1.0", publishedAt: "Today", impact: "high" },
      { packageName: "next", version: "v15.5.22", publishedAt: "Yesterday", impact: "medium" },
      { packageName: "zod", version: "v3.24.4", publishedAt: "2 days ago", impact: "low" },
    ],
  },
];

export function getMockRepositoryDetails(id: string) {
  return repositoryDetails.find((repository) => repository.id === id) ?? null;
}
