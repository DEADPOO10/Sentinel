import { Github } from "lucide-react";
import { SelectRepositoryButton } from "@/components/repository/select-repository-button";
import { requireUser } from "@/lib/auth/session";
import { getGitHubRepositoriesForCurrentUser } from "@/lib/github/repositories";
import { SiteNavigation } from "@/components/site-navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function RepositoriesPage() {
  const user = await requireUser();
  const result = await getGitHubRepositoriesForCurrentUser();

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20"><p className="font-mono text-xs tracking-[.16em] text-[#b45309]">REPOSITORIES</p><h1 className="mt-3 text-3xl font-medium tracking-[-.04em] sm:text-4xl">Your GitHub repositories</h1><p className="mt-3 max-w-2xl text-[#4b5563]">Repositories available to the GitHub account connected to Sentinel.</p>{"error" in result ? <RepositoryError message={result.error} /> : result.repositories.length === 0 ? <EmptyRepositories userName={user.username ?? user.email ?? "your GitHub account"} /> : <div className="mt-10 grid gap-4">{result.repositories.map((repository) => <Card key={repository.id}><CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><CardTitle className="truncate">{repository.name}</CardTitle><Badge variant={repository.private ? "warning" : "success"}>{repository.private ? "Private" : "Public"}</Badge></div><CardDescription className="mt-2">Owner: {repository.owner.login}</CardDescription></div><SelectRepositoryButton owner={repository.owner.login} repositoryName={repository.name} /></CardHeader><CardContent><dl className="grid gap-3 border-t border-[#f3e8d5] pt-4 text-sm sm:grid-cols-3"><RepositoryMeta label="Language" value={repository.language ?? "Not specified"} /><RepositoryMeta label="Default branch" value={repository.default_branch} /><RepositoryMeta label="Last updated" value={<time dateTime={repository.updated_at}>{formatUpdatedAt(repository.updated_at)}</time>} /></dl></CardContent></Card>)}</div>}</section></main>;
}

function RepositoryError({ message }: { message: string }) {
  return <Card className="mt-10"><CardHeader><div className="grid h-10 w-10 place-items-center rounded-lg bg-[#fef3c7] text-[#b45309]"><Github className="h-5 w-5" /></div><CardTitle className="mt-4">We couldn’t load your repositories</CardTitle><CardDescription>{message}</CardDescription></CardHeader></Card>;
}

function EmptyRepositories({ userName }: { userName: string }) {
  return <Card className="mt-10"><CardHeader><div className="grid h-10 w-10 place-items-center rounded-lg bg-[#fef3c7] text-[#b45309]"><Github className="h-5 w-5" /></div><CardTitle className="mt-4">No repositories found</CardTitle><CardDescription>GitHub did not return any repositories for {userName}.</CardDescription></CardHeader></Card>;
}

function RepositoryMeta({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt className="text-xs font-medium uppercase tracking-[.12em] text-[#9ca3af]">{label}</dt><dd className="mt-1 text-[#4b5563]">{value}</dd></div>;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
