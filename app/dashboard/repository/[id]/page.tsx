import type { Metadata } from "next";
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/session";
import { getMockRepositoryDetails } from "@/services/mock-repository-details";
import { SiteNavigation } from "@/components/site-navigation";
import {
  AiSummary,
  BreakingChanges,
  DependencyList,
  EventTimeline,
  PullRequests,
  RecentReleases,
  RecommendedFixes,
  RepositoryIdentity,
  RepositoryOverview,
  ScanMetadata,
} from "@/components/repository/repository-detail-components";

type PageProps = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const repository = getMockRepositoryDetails(id);
  return { title: repository ? `${repository.fullName} – Sentinel` : "Repository not found – Sentinel" };
}

export default async function RepositoryDetailsPage({ params }: PageProps) {
  await requireUser();
  const { id } = await params;
  const repository = getMockRepositoryDetails(id);
  if (!repository) notFound();

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto max-w-7xl px-6 py-10 lg:px-8 lg:py-14"><nav aria-label="Breadcrumb" className="mb-7 flex items-center gap-1.5 text-sm text-[#6b7280]"><Link href="/dashboard" className="transition-colors hover:text-[#92400e]">Dashboard</Link><ChevronRight className="h-3.5 w-3.5" /><Link href="/repositories" className="transition-colors hover:text-[#92400e]">Repositories</Link><ChevronRight className="h-3.5 w-3.5" /><span className="truncate text-[#4b5563]">{repository.name}</span></nav><div className="flex flex-col justify-between gap-6 border-b border-[#f3e8d5] pb-8 sm:flex-row sm:items-end"><RepositoryIdentity repository={repository} /><ScanMetadata repository={repository} /></div><div className="mt-8"><RepositoryOverview repository={repository} /></div><div className="mt-8 grid gap-8 xl:grid-cols-[minmax(0,1.55fr)_minmax(340px,.85fr)]"><div className="space-y-8"><DependencyList repository={repository} /><BreakingChanges repository={repository} /><PullRequests repository={repository} /></div><aside className="space-y-8"><AiSummary repository={repository} /><RecommendedFixes repository={repository} /><RecentReleases repository={repository} /><EventTimeline repository={repository} /></aside></div></section></main>;
}
