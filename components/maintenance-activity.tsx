import { Activity, ArrowUpRight, FileCheck2, FileSearch, GitPullRequestDraft, ScanSearch, Sparkles } from "lucide-react";
import type { MaintenanceActivity } from "@/lib/db/maintenance-activity";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type MaintenanceActivitySectionProps = {
  title: string;
  description: string;
  activities: MaintenanceActivity[];
  emptyMessage?: string;
};

export function MaintenanceActivitySection({ title, description, activities, emptyMessage = "No maintenance activity yet. Run a repository scan to get started." }: MaintenanceActivitySectionProps) {
  return <Card><CardHeader><div className="flex items-center gap-2"><Activity className="h-4 w-4 text-[#b45309]" /><CardTitle>{title}</CardTitle></div><CardDescription>{description}</CardDescription></CardHeader><CardContent>{activities.length === 0 ? <p className="text-sm text-[#6b7280]">{emptyMessage}</p> : <ol className="divide-y divide-[#f3e8d5] border-t border-[#f3e8d5]">{activities.map((activity) => <ActivityRow key={activity.key} activity={activity} />)}</ol>}</CardContent></Card>;
}

function ActivityRow({ activity }: { activity: MaintenanceActivity }) {
  const Icon = getActivityIcon(activity.kind);
  return <li className="flex gap-3 py-4 first:pt-4 last:pb-0"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-[#f3e8d5] bg-[#fffaf0] text-[#b45309]"><Icon className="h-4 w-4" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><p className="truncate font-mono text-xs text-[#6b7280]">{activity.repository}</p>{activity.dependencyName ? <span className="font-mono text-xs text-[#92400e]">{activity.dependencyName}</span> : null}</div><div className="mt-1 flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-[#111827]">{activity.action}</p><Badge variant={activity.tone}>{activity.status}</Badge></div>{activity.details && activity.details.length > 0 ? <p className="mt-1.5 text-xs text-[#6b7280]">{activity.details.join(" · ")}</p> : null}<time dateTime={activity.occurredAt.toISOString()} className="mt-1.5 block text-xs text-[#9ca3af]">{formatRelativeTime(activity.occurredAt)}</time></div>{activity.pullRequest ? <a href={activity.pullRequest.url} target="_blank" rel="noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1 self-center rounded-md border border-[#f3e8d5] px-2.5 text-xs font-medium text-[#92400e] transition-colors hover:bg-[#fffaf0]" aria-label={`Open pull request #${activity.pullRequest.number} on GitHub`}>Open PR <ArrowUpRight className="h-3.5 w-3.5" /></a> : null}</li>;
}

function getActivityIcon(kind: MaintenanceActivity["kind"]) {
  if (kind === "scan") return ScanSearch;
  if (kind === "analysis") return Sparkles;
  if (kind === "proposed_fix") return FileSearch;
  if (kind === "validation") return FileCheck2;
  return GitPullRequestDraft;
}

function formatRelativeTime(value: Date) {
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - value.getTime()) / 1_000));
  if (elapsedSeconds < 60) return "Just now";
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"} ago`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours} hour${elapsedHours === 1 ? "" : "s"} ago`;
  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) return `${elapsedDays} day${elapsedDays === 1 ? "" : "s"} ago`;
  return new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value);
}
