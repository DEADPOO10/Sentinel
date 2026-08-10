import { GitBranch } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { listRepositoriesConnectedByCurrentSentinelUser } from "@/lib/db/repositories";
import { SiteNavigation } from "@/components/site-navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const user = await requireUser();
  const username = user.username ?? user.name ?? "GitHub user";
  const connectedRepositories = await getConnectedRepositoryCount();

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20"><p className="font-mono text-xs tracking-[.16em] text-[#b45309]">DASHBOARD</p><h1 className="mt-3 text-3xl font-medium tracking-[-.04em] sm:text-4xl">Welcome, {username}</h1><p className="mt-3 max-w-xl text-[#4b5563]">Your Sentinel workspace is ready.</p><Card className="mt-12 max-w-sm"><CardHeader><GitBranch className="h-5 w-5 text-[#b45309]" /><CardTitle className="mt-5 text-3xl">Repositories</CardTitle><CardDescription className="text-base">{connectedRepositories === null ? "Unavailable" : `${connectedRepositories} connected`}</CardDescription></CardHeader><CardContent><p className="text-sm text-[#6b7280]">{connectedRepositories === null ? "Sentinel could not load your saved repository connections right now." : "Repositories you select from GitHub are saved here."}</p></CardContent></Card></section></main>;
}

async function getConnectedRepositoryCount() {
  try {
    return (await listRepositoriesConnectedByCurrentSentinelUser()).length;
  } catch {
    return null;
  }
}
