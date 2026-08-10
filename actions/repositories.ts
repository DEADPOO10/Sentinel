"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/session";
import { connectRepositoryToCurrentSentinelUser } from "@/lib/db/repositories";
import { DatabaseNotConfiguredError } from "@/lib/db/prisma";
import { getVerifiedGitHubRepositoryForCurrentUser } from "@/lib/github/repositories";

const GITHUB_OWNER_PATTERN = /^[A-Za-z\d](?:[A-Za-z\d]|-(?=[A-Za-z\d])){0,38}$/;
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z\d][A-Za-z\d._-]{0,99}$/;

export type SelectRepositoryActionResult =
  | { kind: "success"; owner: string; repository: string }
  | { kind: "error"; error: string };

export async function selectRepositoryForCurrentUser(input: unknown): Promise<SelectRepositoryActionResult> {
  await requireUser();

  if (!isRepositorySelection(input)) {
    return { kind: "error", error: "This repository selection is invalid." };
  }

  const githubRepository = await getVerifiedGitHubRepositoryForCurrentUser(input.owner, input.repository);
  if (githubRepository.kind === "error") return githubRepository;

  try {
    await connectRepositoryToCurrentSentinelUser(githubRepository.repository);
    revalidatePath("/dashboard");
    return {
      kind: "success",
      owner: githubRepository.repository.owner,
      repository: githubRepository.repository.name,
    };
  } catch (error) {
    if (error instanceof DatabaseNotConfiguredError) {
      return { kind: "error", error: "Sentinel repository storage is not configured for this environment." };
    }

    return { kind: "error", error: "Sentinel could not save this repository selection. Please try again." };
  }
}

function isRepositorySelection(input: unknown): input is { owner: string; repository: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;

  const { owner, repository } = input as Record<string, unknown>;
  if (typeof owner !== "string" || typeof repository !== "string") return false;

  return GITHUB_OWNER_PATTERN.test(owner) && GITHUB_REPOSITORY_PATTERN.test(repository);
}
