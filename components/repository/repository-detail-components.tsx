import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  CircleDot,
  Clock3,
  FileCode2,
  GitPullRequest,
  GitBranch,
  ScanLine,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RepositoryDetail, RiskLevel } from "@/types/repository-details";

const riskStyles: Record<RiskLevel, { label: string; variant: "success" | "warning" | "danger" }> = {
  low: { label: "Low risk", variant: "success" },
  medium: { label: "Medium risk", variant: "warning" },
  high: { label: "High risk", variant: "danger" },
};

export function StatusBadge({ risk }: { risk: RiskLevel }) {
  const style = riskStyles[risk];
  return <Badge variant={style.variant}><span className="h-1.5 w-1.5 rounded-full bg-current" />{style.label}</Badge>;
}

export function RepositoryOverview({ repository }: { repository: RepositoryDetail }) {
  return <div className="grid gap-5 lg:grid-cols-[1.1fr_.9fr]">
    <Card><CardHeader className="flex-row items-center justify-between gap-6"><div><CardDescription>Repository health</CardDescription><CardTitle className="mt-2 text-3xl">{repository.healthScore}<span className="text-base font-normal text-[#6b7280]"> / 100</span></CardTitle><p className="mt-3 text-sm text-[#4b5563]">Healthy overall, with focused maintenance work ready to review.</p></div><HealthRing score={repository.healthScore} /></CardHeader></Card>
    <Card><CardHeader><CardDescription>Latest scan</CardDescription><CardTitle className="mt-2 text-xl">{repository.latestScan}</CardTitle><div className="mt-3 flex items-center gap-2 text-sm text-[#4b5563]"><ScanLine className="h-4 w-4 text-[#b45309]" />42 dependencies analyzed</div></CardHeader></Card>
  </div>;
}

function HealthRing({ score }: { score: number }) {
  return <div aria-label={`Repository health score: ${score} out of 100`} className="grid h-24 w-24 shrink-0 place-items-center rounded-full" style={{ background: `conic-gradient(#10b981 ${score * 3.6}deg, #ecfdf5 0deg)` }}><div className="grid h-[78px] w-[78px] place-items-center rounded-full bg-white text-xl font-medium text-[#111827]">{score}</div></div>;
}

export function DependencyList({ repository }: { repository: RepositoryDetail }) {
  const status = { current: <Badge variant="success">Current</Badge>, "update-available": <Badge variant="info">Update available</Badge>, "breaking-change": <Badge variant="danger">Breaking change</Badge> } as const;
  return <Card><CardHeader><CardTitle>Dependencies</CardTitle><CardDescription>Tracked packages on the {repository.defaultBranch} branch.</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full min-w-[570px] text-left text-sm"><thead className="border-b border-[#f3e8d5] text-xs font-medium uppercase tracking-[.12em] text-[#9ca3af]"><tr><th className="pb-3">Package</th><th className="pb-3">Current</th><th className="pb-3">Latest</th><th className="pb-3 text-right">Status</th></tr></thead><tbody>{repository.dependencies.map((dependency) => <tr key={dependency.name} className="border-b border-[#f3e8d5]/70 last:border-0"><td className="py-4 font-medium text-[#111827]">{dependency.name}</td><td className="py-4 font-mono text-xs text-[#6b7280]">{dependency.currentVersion}</td><td className="py-4 font-mono text-xs text-[#6b7280]">{dependency.latestVersion}</td><td className="py-4 text-right">{status[dependency.status]}</td></tr>)}</tbody></table></CardContent></Card>;
}

export function BreakingChanges({ repository }: { repository: RepositoryDetail }) {
  return <Card><CardHeader><div className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-amber-600" /><CardTitle>Breaking changes</CardTitle></div><CardDescription>Changes that need your team’s review.</CardDescription></CardHeader><CardContent className="space-y-3">{repository.breakingChanges.map((change) => <article key={change.title} className="rounded-lg border border-[#f3e8d5] bg-[#fffbf3] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm font-medium text-[#111827]">{change.title}</p><Badge variant={change.status === "review" ? "warning" : "default"}>{change.status === "review" ? "Needs review" : "Monitoring"}</Badge></div><p className="mt-2 font-mono text-xs text-[#b45309]">{change.packageName}</p><p className="mt-2 text-sm leading-6 text-[#6b7280]">{change.summary}</p></article>)}</CardContent></Card>;
}

export function AiSummary({ repository }: { repository: RepositoryDetail }) {
  return <Card className="border-amber-200 bg-[#fffaf0]"><CardHeader><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-[#b45309]" /><CardTitle>AI summary</CardTitle></div><CardDescription>Generated from the latest repository scan.</CardDescription></CardHeader><CardContent><p className="text-sm leading-7 text-[#4b5563]">{repository.aiSummary}</p></CardContent></Card>;
}

export function RecommendedFixes({ repository }: { repository: RepositoryDetail }) {
  return <Card><CardHeader><CardTitle>Recommended fixes</CardTitle><CardDescription>Ordered by impact and confidence.</CardDescription></CardHeader><CardContent><ol className="space-y-3">{repository.recommendedFixes.map((fix, index) => <li key={fix} className="flex gap-3 text-sm leading-6 text-[#4b5563]"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#fef3c7] font-mono text-xs text-[#92400e]">{index + 1}</span>{fix}</li>)}</ol></CardContent></Card>;
}

export function PullRequests({ repository }: { repository: RepositoryDetail }) {
  return <Card><CardHeader><div className="flex items-center gap-2"><GitPullRequest className="h-4 w-4 text-[#b45309]" /><CardTitle>Pull requests ready</CardTitle></div><CardDescription>Maintenance changes prepared for your team.</CardDescription></CardHeader><CardContent className="space-y-3">{repository.pullRequests.map((pullRequest) => <Link href="#" key={pullRequest.number} className="group flex items-start justify-between gap-4 rounded-lg border border-[#f3e8d5] bg-white p-4 transition-colors hover:bg-[#fffaf0]"><div><p className="text-sm font-medium text-[#111827]">#{pullRequest.number} {pullRequest.title}</p><p className="mt-1 font-mono text-xs text-[#6b7280]">{pullRequest.branch}</p></div><div className="flex items-center gap-2"><Badge variant={pullRequest.status === "ready" ? "success" : "warning"}>{pullRequest.status === "ready" ? "Ready" : "Reviewing"}</Badge><ArrowUpRight className="h-4 w-4 text-[#9ca3af] transition-colors group-hover:text-[#b45309]" /></div></Link>)}</CardContent></Card>;
}

export function EventTimeline({ repository }: { repository: RepositoryDetail }) {
  const icons = { scan: ScanLine, release: CircleDot, alert: AlertTriangle, "pull-request": GitPullRequest } as const;
  return <Card><CardHeader><CardTitle>Timeline of events</CardTitle><CardDescription>Recent repository activity and detected changes.</CardDescription></CardHeader><CardContent><ol className="space-y-5">{repository.timeline.map((event, index) => { const Icon = icons[event.kind]; return <li key={`${event.title}-${event.timestamp}`} className="relative flex gap-4"><span className="relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#fef3c7] text-[#b45309]"><Icon className="h-4 w-4" /></span>{index < repository.timeline.length - 1 && <span aria-hidden className="absolute left-4 top-8 h-[calc(100%+4px)] border-l border-[#f3e8d5]" />}<div className="min-w-0 pt-0.5"><div className="flex flex-wrap items-center gap-x-2 gap-y-1"><p className="text-sm font-medium text-[#111827]">{event.title}</p><span className="text-xs text-[#9ca3af]">{event.timestamp}</span></div><p className="mt-1 text-sm leading-6 text-[#6b7280]">{event.detail}</p></div></li>; })}</ol></CardContent></Card>;
}

export function RecentReleases({ repository }: { repository: RepositoryDetail }) {
  return <Card><CardHeader><CardTitle>Recent releases</CardTitle><CardDescription>Upstream releases relevant to this repository.</CardDescription></CardHeader><CardContent className="space-y-3">{repository.releases.map((release) => <div key={`${release.packageName}-${release.version}`} className="flex items-center justify-between gap-3 rounded-lg border border-[#f3e8d5] p-3"><div className="flex items-center gap-3"><span className="grid h-8 w-8 place-items-center rounded-md bg-stone-100 text-stone-600"><FileCode2 className="h-4 w-4" /></span><div><p className="text-sm font-medium text-[#111827]">{release.packageName} <span className="font-mono text-xs font-normal text-[#6b7280]">{release.version}</span></p><p className="mt-0.5 text-xs text-[#9ca3af]">{release.publishedAt}</p></div></div><StatusBadge risk={release.impact} /></div>)}</CardContent></Card>;
}

export function RepositoryIdentity({ repository }: { repository: RepositoryDetail }) {
  return <div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[#f3e8d5] bg-[#fef3c7] text-[#b45309]"><GitBranch className="h-5 w-5" /></span><div className="min-w-0"><p className="truncate font-mono text-sm text-[#6b7280]">{repository.fullName}</p><h1 className="truncate text-3xl font-medium tracking-[-.04em] text-[#111827] sm:text-4xl">{repository.name}</h1></div></div>;
}

export function ScanMetadata({ repository }: { repository: RepositoryDetail }) {
  return <div className="flex flex-wrap items-center gap-3"><StatusBadge risk={repository.riskLevel} /><span className="inline-flex items-center gap-1.5 text-sm text-[#6b7280]"><Clock3 className="h-4 w-4" />Scanned {repository.latestScan}</span></div>;
}
