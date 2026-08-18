import Link from "next/link";
import { ArrowUpRight, GitBranch, ShieldAlert, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { listRecentMaintenanceActivityForCurrentUser } from "@/lib/db/maintenance-activity";
import {
  getDashboardMaintenanceMetricsForCurrentUser,
  type DashboardMaintenanceMetrics,
} from "@/lib/db/scans";
import { MaintenanceActivitySection } from "@/components/maintenance-activity";
import { SiteNavigation } from "@/components/site-navigation";
import { Badge } from "@/components/ui/badge";

export default async function DashboardPage() {
  const user = await requireUser();
  const username = user.username ?? user.name ?? "GitHub user";
  const [metrics, activity] = await Promise.all([
    getDashboardMetrics(),
    getDashboardActivity(),
  ]);

  return (
    <main className="sentinel-page">
      <SiteNavigation />

      <section className="mx-auto max-w-7xl px-6 py-10 lg:px-8 lg:py-14">
        <header className="relative overflow-hidden border border-[#d5d6ce] bg-[#f9f9f5]">
          <div className="h-1 w-full bg-[#d8ff42]" />
          <div className="grid gap-8 px-6 py-8 sm:px-8 lg:grid-cols-[1fr_18rem] lg:items-end lg:px-10 lg:py-10">
            <div>
              <div className="mb-5 flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817]">
                  <Sparkles className="h-4 w-4" />
                </span>
                <p className="eyebrow">SENTINEL / MAINTENANCE COMMAND CENTER</p>
              </div>
              <h1 className="editorial-title text-4xl text-[#171817] sm:text-5xl lg:text-6xl">
                Good to see you,
                <br />
                {username}.
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-6 text-[#696b66] sm:text-base">
                Track connected repositories, prioritize dependency risk, and
                review Sentinel’s latest maintenance work from one focused
                workspace.
              </p>
            </div>

            <div className="border-t border-[#d5d6ce] pt-6 lg:border-l lg:border-t-0 lg:pl-7 lg:pt-0">
              <Badge variant="brand" className="px-3 py-1.5">
                Human-controlled workflow
              </Badge>
              <p className="mt-4 font-mono text-[10px] uppercase leading-5 tracking-[.1em] text-[#696b66]">
                Every proposed change requires developer review. Sentinel does
                not auto-merge.
              </p>
              <Link
                href="/repositories"
                className="mt-5 inline-flex items-center gap-2 border border-[#171817] bg-[#171817] px-4 py-2.5 text-sm font-medium text-[#f5f5ef] transition-colors hover:bg-[#d8ff42] hover:text-[#171817] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171817] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f5f5ef]"
              >
                Review repositories
                <ArrowUpRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </header>

        <section className="mt-10" aria-labelledby="dashboard-overview-title">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
            <div>
              <p className="eyebrow">CURRENT WORKSPACE</p>
              <h2
                id="dashboard-overview-title"
                className="mt-2 text-2xl font-medium tracking-[-.04em] text-[#171817]"
              >
                Maintenance overview
              </h2>
              <p className="mt-2 text-sm text-[#696b66]">
                The latest persisted state across your connected repositories.
              </p>
            </div>
            <Badge variant="info" className="self-start px-3 py-1.5 sm:self-auto">
              Latest scan data
            </Badge>
          </div>

          <div className="mt-5 grid gap-4 md:grid-cols-3">
            <Metric
              icon={<GitBranch />}
              title="Connected repositories"
              value={metrics === null ? "—" : String(metrics.connectedRepositories)}
              detail={
                metrics === null
                  ? "Metric temporarily unavailable"
                  : "Saved GitHub connections"
              }
              tone="neutral"
            />
            <Metric
              icon={<ArrowUpRight />}
              title="Updates available"
              value={metrics === null ? "—" : String(metrics.updatesAvailable)}
              detail={
                metrics === null
                  ? "Metric temporarily unavailable"
                  : "From the latest scans"
              }
              tone="accent"
            />
            <Metric
              icon={<ShieldAlert />}
              title="High-risk updates"
              value={metrics === null ? "—" : String(metrics.highRiskUpdates)}
              detail={
                metrics === null
                  ? "Metric temporarily unavailable"
                  : "Major version changes"
              }
              tone="danger"
            />
          </div>

          {metrics === null ? (
            <p
              className="mt-4 border border-[#e4c99f] bg-[#f8efdf] px-4 py-3 text-sm text-[#8b4d10]"
              role="status"
            >
              Dashboard metrics are temporarily unavailable. Your repository
              workspaces remain accessible.
            </p>
          ) : null}
        </section>

        <div className="mt-12 border border-[#d5d6ce] bg-[#f9f9f5] px-6 sm:px-8">
          <MaintenanceActivitySection
            title="Maintenance activity"
            description="Your newest persisted Sentinel work across connected repositories."
            activities={activity}
            emptyMessage="No persisted maintenance activity yet. Open a repository and run a scan to begin building your Sentinel history."
          />
        </div>
      </section>
    </main>
  );
}

function Metric({
  icon,
  title,
  value,
  detail,
  tone,
}: {
  icon: ReactNode;
  title: string;
  value: string;
  detail: string;
  tone: "neutral" | "accent" | "danger";
}) {
  const toneStyles = {
    neutral: "border-t-[#171817]",
    accent: "border-t-[#d8ff42]",
    danger: "border-t-[#93342a]",
  } as const;

  return (
    <article
      className={`group border border-[#d5d6ce] border-t-4 bg-[#f9f9f5] p-6 transition-colors hover:bg-white ${toneStyles[tone]}`}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="font-mono text-[10px] font-medium uppercase tracking-[.1em] text-[#696b66]">
          {title}
        </p>
        <span className="grid h-9 w-9 shrink-0 place-items-center border border-[#d5d6ce] bg-[#f5f5ef] text-[#171817] [&_svg]:h-4 [&_svg]:w-4">
          {icon}
        </span>
      </div>
      <p className="mt-8 text-5xl font-medium tracking-[-.07em] text-[#171817]">
        {value}
      </p>
      <p className="mt-2 text-sm text-[#696b66]">{detail}</p>
    </article>
  );
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
