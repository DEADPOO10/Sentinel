import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight, FileCode2, GitBranch } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getGitHubPackageJson, isValidGitHubRepository, type GitHubPackageJsonResult, type PackageManifest } from "@/lib/github/package-json";
import { SiteNavigation } from "@/components/site-navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type PageProps = { params: Promise<{ owner: string; repository: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { owner, repository } = await params;
  return { title: isValidGitHubRepository(owner, repository) ? `${owner}/${repository} – Sentinel` : "Repository not found – Sentinel" };
}

export default async function RepositoryPackagePage({ params }: PageProps) {
  await requireUser();
  const { owner, repository } = await params;
  const result = await getGitHubPackageJson(owner, repository);

  if (result.kind === "not-found") notFound();

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto max-w-7xl px-6 py-10 lg:px-8 lg:py-14"><Breadcrumb owner={owner} repository={repository} />{"error" in result ? <RepositoryError message={result.error} /> : <RepositoryPackageContent result={result} />}</section></main>;
}

function Breadcrumb({ owner, repository }: { owner: string; repository: string }) {
  return <nav aria-label="Breadcrumb" className="mb-7 flex items-center gap-1.5 text-sm text-[#6b7280]"><Link href="/dashboard" className="transition-colors hover:text-[#92400e]">Dashboard</Link><ChevronRight className="h-3.5 w-3.5" /><Link href="/repositories" className="transition-colors hover:text-[#92400e]">Repositories</Link><ChevronRight className="h-3.5 w-3.5" /><span className="truncate text-[#4b5563]">{owner}/{repository}</span></nav>;
}

function RepositoryPackageContent({ result }: { result: Exclude<GitHubPackageJsonResult, { kind: "not-found" } | { kind: "error" }> }) {
  const { repository } = result;

  return <><div className="flex flex-col justify-between gap-6 border-b border-[#f3e8d5] pb-8 sm:flex-row sm:items-end"><div className="flex min-w-0 items-center gap-3"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg border border-[#f3e8d5] bg-[#fef3c7] text-[#b45309]"><GitBranch className="h-5 w-5" /></span><div className="min-w-0"><p className="truncate font-mono text-sm text-[#6b7280]">{repository.owner}/{repository.name}</p><h1 className="truncate text-3xl font-medium tracking-[-.04em] sm:text-4xl">{repository.name}</h1></div></div><span className="inline-flex items-center gap-1.5 text-sm text-[#6b7280]"><GitBranch className="h-4 w-4" />{repository.defaultBranch}</span></div>{result.kind === "ready" ? <PackageManifestContent manifest={result.manifest} /> : <NoPackageJsonState invalid={result.kind === "invalid-package-json"} />}</>;
}

function PackageManifestContent({ manifest }: { manifest: PackageManifest }) {
  return <><div className="mt-8 grid gap-5 sm:grid-cols-3"><MetadataCard label="Package name" value={manifest.name ?? "Not specified"} /><MetadataCard label="Package version" value={manifest.version ?? "Not specified"} /><MetadataCard label="Total dependencies" value={String(manifest.dependencies.length)} /></div><Card className="mt-8"><CardHeader><div className="flex items-center gap-2"><FileCode2 className="h-4 w-4 text-[#b45309]" /><CardTitle>Declared dependencies</CardTitle></div><CardDescription>Dependencies read directly from package.json on the default branch.</CardDescription></CardHeader><CardContent className="overflow-x-auto">{manifest.dependencies.length === 0 ? <p className="text-sm text-[#6b7280]">This package.json does not declare any dependencies.</p> : <table className="w-full min-w-[520px] text-left text-sm"><thead className="border-b border-[#f3e8d5] text-xs font-medium uppercase tracking-[.12em] text-[#9ca3af]"><tr><th className="pb-3">Package</th><th className="pb-3">Declared version</th><th className="pb-3 text-right">Type</th></tr></thead><tbody>{manifest.dependencies.map((dependency) => <tr key={`${dependency.type}-${dependency.name}`} className="border-b border-[#f3e8d5]/70 last:border-0"><td className="py-4 font-medium text-[#111827]">{dependency.name}</td><td className="py-4 font-mono text-xs text-[#6b7280]">{dependency.version}</td><td className="py-4 text-right"><Badge variant="info">{dependency.type}</Badge></td></tr>)}</tbody></table>}</CardContent></Card></>;
}

function MetadataCard({ label, value }: { label: string; value: string }) {
  return <Card><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="mt-2 text-xl">{value}</CardTitle></CardHeader></Card>;
}

function NoPackageJsonState({ invalid }: { invalid: boolean }) {
  return <Card className="mt-8"><CardHeader><div className="grid h-10 w-10 place-items-center rounded-lg bg-[#fef3c7] text-[#b45309]"><FileCode2 className="h-5 w-5" /></div><CardTitle className="mt-4">{invalid ? "package.json could not be read" : "No package.json found"}</CardTitle><CardDescription>{invalid ? "This repository’s package.json contains invalid JSON, so Sentinel cannot list its dependencies." : "Sentinel checked the default branch but did not find a package.json file."}</CardDescription></CardHeader></Card>;
}

function RepositoryError({ message }: { message: string }) {
  return <Card><CardHeader><CardTitle>We couldn’t load this repository</CardTitle><CardDescription>{message}</CardDescription></CardHeader></Card>;
}
