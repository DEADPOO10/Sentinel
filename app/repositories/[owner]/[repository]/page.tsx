import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { ChevronRight, FileCode2, GitBranch } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { listRecentMaintenanceActivityForRepository, type MaintenanceActivity } from "@/lib/db/maintenance-activity";
import { getLatestRepositoryScanWithFindings } from "@/lib/db/scans";
import { getGitHubRepositoryDetails, isValidGitHubRepository } from "@/lib/github/package-json";
import type { CheckedPackageManifest, DependencyStatus, ReleaseChangeType, ReleaseRisk } from "@/lib/npm/dependency-versions";
import { DependencyAiAnalysis } from "@/components/repository/dependency-ai-analysis";
import { ScanRefreshControl } from "@/components/repository/scan-refresh-control";
import { MaintenanceActivitySection } from "@/components/maintenance-activity";
import { SiteNavigation } from "@/components/site-navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type PageProps = { params: Promise<{ owner: string; repository: string }> };
type PersistedScan = Omit<NonNullable<Awaited<ReturnType<typeof getLatestRepositoryScanWithFindings>>>, "completedAt"> & { completedAt: Date };

const SCAN_FRESHNESS_MS = 15 * 60 * 1000;

export const runtime = "nodejs";
export const maxDuration = 90;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { owner, repository } = await params;
  return { title: isValidGitHubRepository(owner, repository) ? `${owner}/${repository} – Sentinel` : "Repository not found – Sentinel" };
}

export default async function RepositoryPackagePage({ params }: PageProps) {
  const { owner, repository } = await params;
  return <main className="min-h-screen bg-[#f5f5ef] text-[#171817]"><Suspense fallback={<NavigationSkeleton />}><SiteNavigation /></Suspense><section className="mx-auto max-w-7xl px-6 py-10 lg:px-8 lg:py-14"><Breadcrumb owner={owner} repository={repository} /><Suspense fallback={<RepositoryShellSkeleton />}><RepositoryData owner={owner} repository={repository} /></Suspense></section></main>;
}

function Breadcrumb({ owner, repository }: { owner: string; repository: string }) {
  return <nav aria-label="Breadcrumb" className="mb-7 flex items-center gap-1.5 text-sm text-[#696b66]"><Link href="/dashboard" className="transition-colors hover:text-[#343633]">Dashboard</Link><ChevronRight className="h-3.5 w-3.5" /><Link href="/repositories" className="transition-colors hover:text-[#343633]">Repositories</Link><ChevronRight className="h-3.5 w-3.5" /><span className="truncate text-[#5f625d]">{owner}/{repository}</span></nav>;
}

async function RepositoryData({ owner, repository }: { owner: string; repository: string }) {
  await requireUser();
  // Verify current GitHub access before reading any persisted workspace data.
  const result = await getGitHubRepositoryDetails(owner, repository);
  if (result.kind === "not-found") notFound();
  if (result.kind === "error") return <RepositoryError message={result.error} />;

  const scanCandidate = await getLatestRepositoryScanWithFindings(result.repository.githubRepositoryId);
  const persistedScan: PersistedScan | null = scanCandidate?.completedAt ? { ...scanCandidate, completedAt: scanCandidate.completedAt } : null;
  const isFresh = persistedScan ? Date.now() - persistedScan.completedAt.getTime() < SCAN_FRESHNESS_MS : false;

  return <><RepositoryOverview repository={result.repository} />{persistedScan ? <PersistedDependencyIntelligence scan={persistedScan} owner={result.repository.owner} repository={result.repository.name} isFresh={isFresh} /> : <FirstScanState owner={result.repository.owner} repository={result.repository.name} />}<Suspense fallback={<ActivitySkeleton />}><RepositoryActivity githubRepositoryId={result.repository.githubRepositoryId} /></Suspense></>;
}

function FirstScanState({ owner, repository }: { owner: string; repository: string }) {
  return <><DependencyIntelligenceSkeleton /><ScanRefreshControl owner={owner} repository={repository} automaticallyRefresh hasCachedScan={false} /></>;
}

function PersistedDependencyIntelligence({ scan, owner, repository, isFresh }: { scan: PersistedScan; owner: string; repository: string; isFresh: boolean }) {
  const manifest = createCachedManifest(scan);
  return <><ScanSnapshotStatus completedAt={scan.completedAt} isFresh={isFresh} baseCommitSha={scan.baseCommitSha} /><PackageManifestContent manifest={manifest} owner={owner} repository={repository} canAnalyze={isFresh} /><ScanRefreshControl owner={owner} repository={repository} automaticallyRefresh={!isFresh} hasCachedScan /></>;
}

function createCachedManifest(scan: PersistedScan): CheckedPackageManifest {
  const dependencies: CheckedPackageManifest["dependencies"] = scan.findings.map((finding) => ({
    name: finding.packageName,
    version: finding.declaredVersion,
    type: finding.dependencyType === "DEPENDENCY" ? "dependency" : finding.dependencyType === "DEV_DEPENDENCY" ? "devDependency" : finding.dependencyType === "PEER_DEPENDENCY" ? "peerDependency" : "optionalDependency",
    latestVersion: finding.latestVersion,
    publishedAt: null,
    changeType: finding.changeType === null ? null : finding.changeType.toLowerCase() as ReleaseChangeType,
    risk: finding.risk === null ? null : finding.risk.toLowerCase() as ReleaseRisk,
    status: (finding.status === "UP_TO_DATE" ? "up-to-date" : finding.status === "UPDATE_AVAILABLE" ? "update-available" : finding.status === "AHEAD_OF_NPM_LATEST" ? "ahead-of-npm-latest" : "unknown") as DependencyStatus,
  }));
  return {
    name: null,
    version: null,
    dependencies,
    summary: {
      total: scan.dependencyCount,
      upToDate: dependencies.filter((item) => item.status === "up-to-date").length,
      updatesAvailable: scan.updatesAvailable,
      aheadOfNpmLatest: dependencies.filter((item) => item.status === "ahead-of-npm-latest").length,
      unknown: dependencies.filter((item) => item.status === "unknown").length,
      majorUpdates: dependencies.filter((item) => item.changeType === "major").length,
      minorUpdates: dependencies.filter((item) => item.changeType === "minor").length,
      patchUpdates: dependencies.filter((item) => item.changeType === "patch").length,
      highRiskUpdates: scan.highRiskCount,
    },
  };
}

function ScanSnapshotStatus({ completedAt, isFresh, baseCommitSha }: { completedAt: Date; isFresh: boolean; baseCommitSha: string | null }) {
  return <div className="mt-8 flex flex-wrap items-center gap-x-3 gap-y-1 border border-[#d5d6ce] bg-[#f1f1ec] px-4 py-3 text-xs text-[#5f625d]" role="status"><span className={`font-medium ${isFresh ? "text-emerald-800" : "text-amber-800"}`}>{isFresh ? "CACHED · FRESH" : "CACHED · STALE"}</span><time dateTime={completedAt.toISOString()}>Last scanned {formatScannedAt(completedAt)}</time>{baseCommitSha ? <span className="font-mono text-[11px]">commit {baseCommitSha.slice(0, 8)}</span> : null}</div>;
}

function RepositoryOverview({ repository }: { repository: { owner: string; name: string; defaultBranch: string } }) {
  return <div className="flex flex-col justify-between gap-6 border-b border-[#d5d6ce] pb-8 sm:flex-row sm:items-end"><div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-none border border-[#d5d6ce] bg-[#d8ff42] text-[#343633]"><GitBranch className="h-5 w-5" /></span><div className="min-w-0"><p className="truncate font-mono text-sm text-[#696b66]">{repository.owner}/{repository.name}</p><h1 className="truncate text-3xl font-medium tracking-[-.04em] sm:text-4xl">{repository.name}</h1></div></div><span className="inline-flex items-center gap-1.5 text-sm text-[#696b66]"><GitBranch className="h-4 w-4" />{repository.defaultBranch}</span></div>;
}

async function RepositoryActivity({ githubRepositoryId }: { githubRepositoryId: number }) {
  const activity = await getRepositoryActivity(githubRepositoryId);
  return <div className="mt-8"><MaintenanceActivitySection title="Recent Sentinel activity" description="Persisted scans, analysis, fixes, validation, and draft PRs for this repository." activities={activity} /></div>;
}

async function getRepositoryActivity(githubRepositoryId: number): Promise<MaintenanceActivity[]> {
  try { return await listRecentMaintenanceActivityForRepository(githubRepositoryId); } catch { return []; }
}

function PackageManifestContent({ manifest, owner, repository, canAnalyze }: { manifest: CheckedPackageManifest; owner: string; repository: string; canAnalyze: boolean }) {
  return <><div className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3"><MetadataCard label="Package name" value={manifest.name ?? "Not recorded in snapshot"} /><MetadataCard label="Package version" value={manifest.version ?? "Not recorded in snapshot"} /><MetadataCard label="Total dependencies" value={String(manifest.summary.total)} /><MetadataCard label="Up to date" value={String(manifest.summary.upToDate)} /><MetadataCard label="Updates available" value={String(manifest.summary.updatesAvailable)} /><MetadataCard label="Major updates" value={String(manifest.summary.majorUpdates)} /><MetadataCard label="Minor updates" value={String(manifest.summary.minorUpdates)} /><MetadataCard label="Patch updates" value={String(manifest.summary.patchUpdates)} /><MetadataCard label="High risk updates" value={String(manifest.summary.highRiskUpdates)} /><MetadataCard label="Ahead of npm latest" value={String(manifest.summary.aheadOfNpmLatest)} /><MetadataCard label="Unknown" value={String(manifest.summary.unknown)} /></div><Card className="mt-8"><CardHeader><div className="flex items-center gap-2"><FileCode2 className="h-4 w-4 text-[#343633]" /><CardTitle>Declared dependencies</CardTitle></div><CardDescription>This saved scan snapshot is shown immediately. Refresh to read the current commit and npm versions again.</CardDescription></CardHeader><CardContent className="overflow-x-auto">{manifest.dependencies.length === 0 ? <p className="text-sm text-[#696b66]">This package.json does not declare any dependencies.</p> : <table className="w-full min-w-[1,160px] text-left text-sm"><thead className="border-b border-[#d5d6ce] text-xs font-medium uppercase tracking-[.12em] text-[#8a8d86]"><tr><th className="pb-3">Package</th><th className="pb-3">Current version</th><th className="pb-3">Latest version</th><th className="pb-3">Type</th><th className="pb-3">Change type</th><th className="pb-3">Risk</th><th className="pb-3">Status</th><th className="pb-3 text-right">AI analysis</th></tr></thead><tbody>{manifest.dependencies.map((dependency) => <tr key={`${dependency.type}-${dependency.name}`} className="border-b border-[#d5d6ce]/70 last:border-0"><td className="py-4 font-medium text-[#171817]">{dependency.name}</td><td className="py-4 font-mono text-xs text-[#696b66]">{dependency.version}</td><td className="py-4"><p className="font-mono text-xs text-[#696b66]">{dependency.latestVersion ?? "Unavailable"}</p></td><td className="py-4"><Badge variant="info">{dependency.type}</Badge></td><td className="py-4"><ChangeTypeBadge changeType={dependency.changeType} /></td><td className="py-4"><RiskBadge risk={dependency.risk} /></td><td className="py-4"><DependencyStatusBadge status={dependency.status} /></td><td className="py-4 text-right">{dependency.status === "update-available" && canAnalyze ? <DependencyAiAnalysis owner={owner} repository={repository} dependencyName={dependency.name} dependencyType={dependency.type} /> : dependency.status === "update-available" ? <span className="text-xs text-[#8a8d86]">Refresh to analyze</span> : <span className="text-xs text-[#8a8d86]">—</span>}</td></tr>)}</tbody></table>}</CardContent></Card></>;
}

function MetadataCard({ label, value }: { label: string; value: string }) { return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="mt-2 text-xl">{value}</CardTitle></CardHeader></Card>; }
function DependencyStatusBadge({ status }: { status: DependencyStatus }) { const detail = { "up-to-date": { label: "Up to date", variant: "success" }, "update-available": { label: "Update available", variant: "warning" }, "ahead-of-npm-latest": { label: "Ahead of npm latest", variant: "info" }, unknown: { label: "Unknown", variant: "default" } } as const; return <Badge variant={detail[status].variant}>{detail[status].label}</Badge>; }
function ChangeTypeBadge({ changeType }: { changeType: ReleaseChangeType | null }) { return changeType ? <Badge variant={changeType === "major" ? "danger" : changeType === "minor" ? "warning" : "success"}>{changeType[0].toUpperCase()}{changeType.slice(1)}</Badge> : <span className="text-xs text-[#8a8d86]">—</span>; }
function RiskBadge({ risk }: { risk: ReleaseRisk | null }) { return risk ? <Badge variant={risk === "high" ? "danger" : risk === "medium" ? "warning" : "success"}>{risk[0].toUpperCase()}{risk.slice(1)} risk</Badge> : <span className="text-xs text-[#8a8d86]">—</span>; }
function formatScannedAt(value: Date) { return new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(value); }
function RepositoryError({ message }: { message: string }) { return <Card><CardHeader><CardTitle>We couldn’t load this repository</CardTitle><CardDescription>{message}</CardDescription></CardHeader></Card>; }
function RepositoryShellSkeleton() { return <div aria-busy="true" aria-label="Loading repository" className="animate-pulse"><div className="flex flex-col justify-between gap-6 border-b border-[#d5d6ce] pb-8 sm:flex-row sm:items-end"><div className="flex items-center gap-3"><div className="h-10 w-10 bg-[#d5d6ce]" /><div className="space-y-2"><div className="h-3 w-36 bg-[#d5d6ce]" /><div className="h-9 w-52 bg-[#d5d6ce]" /></div></div><div className="h-4 w-20 bg-[#d5d6ce]" /></div><DependencyIntelligenceSkeleton /></div>; }
function DependencyIntelligenceSkeleton() { return <div aria-busy="true" aria-label="Loading dependency intelligence" className="mt-8 animate-pulse"><div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-28 border border-[#d5d6ce] bg-[#f1f1ec]" />)}</div><div className="mt-8 h-72 border border-[#d5d6ce] bg-[#f1f1ec]" /></div>; }
function ActivitySkeleton() { return <div aria-busy="true" aria-label="Loading Sentinel activity" className="mt-8 h-32 animate-pulse border border-[#d5d6ce] bg-[#f1f1ec]" />; }
function NavigationSkeleton() { return <nav aria-label="Loading navigation" className="sticky top-0 z-30 h-16 border-b border-[#d5d6ce] bg-[#f5f5ef]" />; }
