import { Github, GitBranch, Globe2, Lock } from "lucide-react";
import { SelectRepositoryButton } from "@/components/repository/select-repository-button";
import { requireUser } from "@/lib/auth/session";
import { getGitHubRepositoriesForCurrentUser } from "@/lib/github/repositories";
import { SiteNavigation } from "@/components/site-navigation";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function RepositoriesPage() {
  const user = await requireUser();
  const result = await getGitHubRepositoriesForCurrentUser();

  return (
    <main className="sentinel-page">
      <SiteNavigation />

      <section className="mx-auto max-w-7xl px-6 py-10 lg:px-8 lg:py-14">
        <header className="relative overflow-hidden border border-[#d5d6ce] bg-[#f9f9f5]">
          <div className="h-1 w-full bg-[#d8ff42]" />
          <div className="flex flex-col justify-between gap-8 px-6 py-8 sm:px-8 lg:flex-row lg:items-end lg:px-10 lg:py-10">
            <div className="max-w-3xl">
              <div className="mb-5 flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817]">
                  <Github className="h-4 w-4" />
                </span>
                <p className="eyebrow">GITHUB / REPOSITORY INDEX</p>
              </div>
              <h1 className="editorial-title text-4xl text-[#171817] sm:text-5xl lg:text-6xl">
                Repositories under watch.
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-6 text-[#696b66] sm:text-base">
                Choose a GitHub repository to open its Sentinel workspace,
                inspect dependency risk, and begin a human-reviewed maintenance
                workflow.
              </p>
            </div>

            {"repositories" in result ? (
              <div className="flex items-center gap-3 lg:flex-col lg:items-end">
                <Badge variant="info" className="px-3 py-1.5">
                  {result.repositories.length} available
                </Badge>
                <p className="font-mono text-[10px] uppercase tracking-[.12em] text-[#8a8d86]">
                  Live from GitHub
                </p>
              </div>
            ) : null}
          </div>
        </header>

        {"error" in result ? (
          <RepositoryError message={result.error} />
        ) : result.repositories.length === 0 ? (
          <EmptyRepositories
            userName={user.username ?? user.email ?? "your GitHub account"}
          />
        ) : (
          <div className="mt-10">
            <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-end">
              <div>
                <h2 className="text-xl font-medium tracking-[-.035em] text-[#171817]">
                  Repository inventory
                </h2>
                <p className="mt-1 text-sm text-[#696b66]">
                  GitHub repositories available to your authenticated account.
                </p>
              </div>
              <p className="font-mono text-[10px] uppercase tracking-[.12em] text-[#8a8d86]">
                Select an asset to continue
              </p>
            </div>

            <div className="space-y-4">
              {result.repositories.map((repository, index) => (
                <article
                  key={repository.id}
                  className="group relative grid gap-6 overflow-hidden border border-[#d5d6ce] bg-[#f9f9f5] px-5 py-6 transition-[border-color,background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-[#171817] hover:bg-white hover:shadow-[0_14px_34px_rgba(23,24,23,0.07)] sm:px-6 lg:grid-cols-[3.5rem_1fr_auto] lg:items-center lg:px-7"
                >
                  <div className="absolute inset-y-0 left-0 w-1 bg-transparent transition-colors group-hover:bg-[#d8ff42]" />

                  <div className="flex items-center gap-3 lg:block">
                    <span className="grid h-11 w-11 place-items-center border border-[#d5d6ce] bg-[#f5f5ef] text-[#343633] transition-colors group-hover:border-[#171817] group-hover:bg-[#d8ff42]">
                      <Github className="h-5 w-5" />
                    </span>
                    <span className="font-mono text-[10px] text-[#8a8d86] lg:mt-2 lg:block lg:text-center">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </div>

                  <div className="min-w-0">
                    <p className="truncate font-mono text-[10px] uppercase tracking-[.12em] text-[#8a8d86]">
                      {repository.owner.login} / GitHub repository
                    </p>

                    <div className="mt-2 flex flex-wrap items-center gap-2.5">
                      <h3 className="truncate text-2xl font-medium tracking-[-.04em] text-[#171817]">
                        {repository.name}
                      </h3>
                      <Badge
                        variant={repository.private ? "warning" : "success"}
                      >
                        {repository.private ? (
                          <>
                            <Lock className="h-3 w-3" />
                            Private
                          </>
                        ) : (
                          <>
                            <Globe2 className="h-3 w-3" />
                            Public
                          </>
                        )}
                      </Badge>
                      <Badge variant="default">
                        <span
                          className="h-1.5 w-1.5 bg-[#696b66]"
                          aria-hidden="true"
                        />
                        Ready to monitor
                      </Badge>
                    </div>

                    <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#696b66] sm:text-sm">
                      <span className="inline-flex items-center gap-1.5">
                        <GitBranch className="h-3.5 w-3.5" />
                        Default branch: {repository.default_branch}
                      </span>
                      <span>
                        {repository.language ?? "Language not specified"}
                      </span>
                      <span className="font-mono text-[10px] uppercase tracking-[.08em] text-[#8a8d86]">
                        Updated {formatUpdatedAt(repository.updated_at)}
                      </span>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2 border-t border-[#d5d6ce] pt-5 lg:min-w-40 lg:items-end lg:border-l lg:border-t-0 lg:py-1 lg:pl-7">
                    <span className="font-mono text-[9px] uppercase tracking-[.12em] text-[#8a8d86]">
                      Open workspace
                    </span>
                    <SelectRepositoryButton
                      owner={repository.owner.login}
                      repositoryName={repository.name}
                    />
                  </div>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function RepositoryError({ message }: { message: string }) {
  return (
    <Card className="mt-10 border-[#d5d6ce]">
      <CardHeader className="p-7">
        <div className="grid h-10 w-10 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817]">
          <Github className="h-5 w-5" />
        </div>
        <CardTitle className="mt-4">
          We couldn’t load your repositories
        </CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function EmptyRepositories({ userName }: { userName: string }) {
  return (
    <Card className="mt-10 border-[#d5d6ce]">
      <CardHeader className="p-7">
        <div className="grid h-10 w-10 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817]">
          <Github className="h-5 w-5" />
        </div>
        <CardTitle className="mt-4">No repositories found</CardTitle>
        <CardDescription>
          GitHub did not return any repositories for {userName}.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
