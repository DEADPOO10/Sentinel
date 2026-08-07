import { headers } from "next/headers";
import { getToken } from "next-auth/jwt";

export type GitHubRepository = {
  id: number;
  name: string;
  owner: { login: string };
  private: boolean;
  language: string | null;
  default_branch: string;
  updated_at: string;
};

type GitHubRepositoriesResult = { repositories: GitHubRepository[] } | { error: string };

class GitHubApiError extends Error {
  constructor(public readonly status: number) {
    super("GitHub repository request failed");
  }
}

export async function getGitHubRepositoriesForCurrentUser(): Promise<GitHubRepositoriesResult> {
  const accessToken = await getGitHubAccessTokenForCurrentUser();
  if (!accessToken) {
    return { error: "Your GitHub authorization needs to be refreshed. Sign out, then connect GitHub again." };
  }

  try {
    return { repositories: await fetchGitHubRepositories(accessToken) };
  } catch (error) {
    return { error: getUserFacingError(error) };
  }
}

export async function getGitHubAccessTokenForCurrentUser() {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!secret) return null;

  const authUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const token = await getToken({
    req: { headers: await headers() },
    secret,
    secureCookie: authUrl ? authUrl.startsWith("https://") : process.env.NODE_ENV === "production",
  });

  return typeof token?.githubAccessToken === "string" ? token.githubAccessToken : null;
}

async function fetchGitHubRepositories(accessToken: string) {
  const repositories: GitHubRepository[] = [];
  let nextPage: string | null = "https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&per_page=100&sort=updated&direction=desc";

  while (nextPage) {
    const response = await fetch(nextPage, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Sentinel",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      cache: "no-store",
    });

    if (!response.ok) throw new GitHubApiError(response.status);

    const page = await response.json() as GitHubRepository[];
    if (!Array.isArray(page)) throw new GitHubApiError(response.status);

    repositories.push(...page);
    nextPage = getNextPage(response.headers.get("link"));
  }

  return repositories;
}

function getNextPage(linkHeader: string | null) {
  const nextPage = linkHeader?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
  return nextPage?.startsWith("https://api.github.com/") ? nextPage : null;
}

function getUserFacingError(error: unknown) {
  if (error instanceof GitHubApiError) {
    if (error.status === 401) return "GitHub rejected this authorization. Sign out, then connect GitHub again.";
    if (error.status === 403 || error.status === 429) return "GitHub cannot serve repositories right now. Please try again shortly.";
  }

  return "GitHub is unavailable right now. Please try again shortly.";
}
