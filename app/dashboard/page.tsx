import { ArrowUpRight, GitBranch, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { listRecentMaintenanceActivityForCurrentUser } from "@/lib/db/maintenance-activity";
import { getDashboardMaintenanceMetricsForCurrentUser, type DashboardMaintenanceMetrics } from "@/lib/db/scans";
import { MaintenanceActivitySection } from "@/components/maintenance-activity";
import { SiteNavigation } from "@/components/site-navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const user = await requireUser();
  const username = user.username ?? user.name ?? "GitHub user";
  const [metrics, activity] = await Promise.all([getDashboardMetrics(), getDashboardActivity()]);

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto max-w-7xl px-6 py-14 lg:px-8 lg:py-20"><p className="font-mono text-xs tracking-[.16em] text-[#b45309]">DASHBOARD</p><h1 className="mt-3 text-3xl font-medium tracking-[-.04em] sm:text-4xl">Welcome, {username}</h1><p className="mt-3 max-w-xl text-[#4b5563]">Your Sentinel workspace is ready.</p><div className="mt-12 grid gap-5 sm:grid-cols-3"><DashboardMetricCard icon={<GitBranch className="h-5 w-5 text-[#b45309]" />} title="Repositories" value={metrics === null ? "Unavailable" : `${metrics.connectedRepositories} connected`} description={metrics === null ? "Sentinel could not load your saved repository connections right now." : "Repositories you select from GitHub are saved here."} /><DashboardMetricCard icon={<ArrowUpRight className="h-5 w-5 text-[#b45309]" />} title="Updates available" value={metrics === null ? "Unavailable" : String(metrics.updatesAvailable)} description="From the latest completed scan for each connected repository." /><DashboardMetricCard icon={<ShieldAlert className="h-5 w-5 text-[#b45309]" />} title="High-risk updates" value={metrics === null ? "Unavailable" : String(metrics.highRiskUpdates)} description="Major dependency updates from those latest scans." /></div><div className="mt-8"><MaintenanceActivitySection title="Recent maintenance activity" description="Your newest persisted Sentinel work across connected repositories." activities={activity} /></div></section></main>;
}

function DashboardMetricCard({ icon, title, value, description }: { icon: ReactNode; title: string; value: string; description: string }) {
  return <Card><CardHeader>{icon}<CardTitle className="mt-5 text-3xl">{title}</CardTitle><CardDescription className="text-base">{value}</CardDescription></CardHeader><CardContent><p className="text-sm text-[#6b7280]">{description}</p></CardContent></Card>;
}

async function getDashboardMetrics(): Promise<DashboardMaintenanceMetrics | null> {
  try {
    return await getDashboardMaintenanceMetricsForCurrentUser();
  } catch {
    return null;
  }
}

async function getDashboardActivity() {
  try {
    return await listRecentMaintenanceActivityForCurrentUser();
  } catch {
    return [];
  }
}
