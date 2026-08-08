"use server";

import { requireUser } from "@/lib/auth/session";
import { getRepositoryDependencyUsage, type RepositoryUsageContext } from "@/lib/github/dependency-usage";
import { getGitHubPackageJson, isValidGitHubRepository } from "@/lib/github/package-json";
import { analyzeDependencyImpact, type DependencyImpactAnalysis } from "@/lib/openai/impact-analysis";

const dependencyTypes = new Set(["dependency", "devDependency", "peerDependency", "optionalDependency"]);

export type DependencyImpactAnalysisActionResult = { analysis: DependencyImpactAnalysis & { risk: "low" | "medium" | "high"; repositoryUsage: RepositoryUsageContext } } | { error: string };

export async function requestDependencyImpactAnalysis(input: { owner: string; repository: string; dependencyName: string; dependencyType: string }): Promise<DependencyImpactAnalysisActionResult> {
  await requireUser();

  if (!isValidGitHubRepository(input.owner, input.repository) || !isSafeDependencyName(input.dependencyName) || !dependencyTypes.has(input.dependencyType)) {
    return { error: "This dependency cannot be analyzed." };
  }

  const result = await getGitHubPackageJson(input.owner, input.repository);
  if (result.kind !== "ready") return { error: "Repository dependency data is unavailable. Please reload and try again." };

  const dependency = result.manifest.dependencies.find((item) => item.name === input.dependencyName && item.type === input.dependencyType);
  if (!dependency || dependency.status !== "update-available" || !dependency.latestVersion || !dependency.changeType || !dependency.risk) {
    return { error: "AI analysis is available only for dependencies with an update available." };
  }

  const repositoryUsage = await getRepositoryDependencyUsage(result.repository.owner, result.repository.name, dependency.name);
  const analysisResult = await analyzeDependencyImpact({
    repository: {
      owner: result.repository.owner,
      name: result.repository.name,
      defaultBranch: result.repository.defaultBranch,
      packageName: result.manifest.name,
      packageVersion: result.manifest.version,
    },
    dependency: {
      name: dependency.name,
      currentVersion: dependency.version,
      latestVersion: dependency.latestVersion,
      changeType: dependency.changeType,
      risk: dependency.risk,
      dependencyType: dependency.type,
    },
    repositoryUsage,
  });

  if ("error" in analysisResult) return analysisResult;
  return { analysis: { ...analysisResult.analysis, risk: dependency.risk, repositoryUsage } };
}

function isSafeDependencyName(value: string) {
  return value.length > 0 && value.length <= 214 && /^[a-zA-Z0-9@._/-]+$/.test(value);
}
