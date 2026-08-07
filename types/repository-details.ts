export type RiskLevel = "low" | "medium" | "high";
export type ChangeStatus = "review" | "resolved" | "monitoring";

export type RepositoryDependency = {
  name: string;
  currentVersion: string;
  latestVersion: string;
  status: "current" | "update-available" | "breaking-change";
};

export type RepositoryChange = {
  title: string;
  packageName: string;
  summary: string;
  status: ChangeStatus;
};

export type RepositoryDetail = {
  id: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  healthScore: number;
  riskLevel: RiskLevel;
  latestScan: string;
  aiSummary: string;
  dependencies: RepositoryDependency[];
  breakingChanges: RepositoryChange[];
  recommendedFixes: string[];
  pullRequests: Array<{ number: number; title: string; branch: string; status: "ready" | "reviewing" }>;
  timeline: Array<{ title: string; detail: string; timestamp: string; kind: "scan" | "release" | "alert" | "pull-request" }>;
  releases: Array<{ packageName: string; version: string; publishedAt: string; impact: RiskLevel }>;
};
