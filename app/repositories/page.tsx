import { Github } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { SiteNavigation } from "@/components/site-navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function RepositoriesPage() {
  const user = await requireUser();

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20"><p className="font-mono text-xs tracking-[.16em] text-[#b45309]">REPOSITORIES</p><h1 className="mt-3 text-3xl font-medium tracking-[-.04em] sm:text-4xl">Your connected repositories</h1><p className="mt-3 max-w-2xl text-[#4b5563]">Repository connections will be available in a future update.</p><Card className="mt-10"><CardHeader><div className="grid h-10 w-10 place-items-center rounded-lg bg-[#fef3c7] text-[#b45309]"><Github className="h-5 w-5" /></div><CardTitle className="mt-4">No repositories connected</CardTitle><CardDescription>Your GitHub account is connected, but Sentinel does not yet request repository access.</CardDescription></CardHeader><CardContent><p className="text-sm text-[#6b7280]">Signed in as {user.username ?? user.email ?? "a GitHub user"}.</p></CardContent></Card></section></main>;
}
