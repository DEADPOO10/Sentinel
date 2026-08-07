import { Github, ShieldCheck } from "lucide-react";
import { requireUser } from "@/lib/auth/session";
import { SiteNavigation } from "@/components/site-navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function SettingsPage() {
  const user = await requireUser();

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto max-w-4xl px-6 py-14 lg:px-8 lg:py-20"><p className="font-mono text-xs tracking-[.16em] text-[#b45309]">SETTINGS</p><h1 className="mt-3 text-3xl font-medium tracking-[-.04em] sm:text-4xl">Workspace settings</h1><p className="mt-3 max-w-xl text-[#4b5563]">Manage the account connected to your Sentinel workspace.</p><div className="mt-10 grid gap-5"><Card><CardHeader><div className="grid h-10 w-10 place-items-center rounded-lg bg-[#fef3c7] text-[#b45309]"><Github className="h-5 w-5" /></div><CardTitle className="mt-4">GitHub account</CardTitle><CardDescription>{user.email ?? "Your GitHub account is connected."}</CardDescription></CardHeader><CardContent><p className="text-sm text-[#6b7280]">GitHub is the source of authentication and future repository access.</p></CardContent></Card><Card><CardHeader><div className="grid h-10 w-10 place-items-center rounded-lg bg-emerald-50 text-emerald-700"><ShieldCheck className="h-5 w-5" /></div><CardTitle className="mt-4">Security</CardTitle><CardDescription>Your session is encrypted and authenticated through Auth.js.</CardDescription></CardHeader></Card></div></section></main>;
}
