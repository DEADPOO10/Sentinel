import { Suspense } from "react";
import { SiteNavigation } from "@/components/site-navigation";

export default function RepositoryLoading() {
  return <main className="min-h-screen bg-[#f5f5ef] text-[#171817]"><Suspense fallback={<NavigationSkeleton />}><SiteNavigation /></Suspense><section className="mx-auto max-w-7xl px-6 py-10 lg:px-8 lg:py-14" aria-busy="true" aria-label="Loading repository"><div className="h-4 w-64 animate-pulse bg-[#d5d6ce]" /><div className="mt-7 flex flex-col justify-between gap-6 border-b border-[#d5d6ce] pb-8 sm:flex-row sm:items-end"><div className="flex items-center gap-3"><div className="h-10 w-10 animate-pulse bg-[#d5d6ce]" /><div className="space-y-2"><div className="h-3 w-36 animate-pulse bg-[#d5d6ce]" /><div className="h-9 w-52 animate-pulse bg-[#d5d6ce]" /></div></div><div className="h-4 w-20 animate-pulse bg-[#d5d6ce]" /></div><div className="mt-8 grid gap-5 sm:grid-cols-2 xl:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <div key={index} className="h-28 animate-pulse border border-[#d5d6ce] bg-[#f1f1ec]" />)}</div><div className="mt-8 h-72 animate-pulse border border-[#d5d6ce] bg-[#f1f1ec]" /></section></main>;
}

function NavigationSkeleton() {
  return <nav aria-label="Loading navigation" className="sticky top-0 z-30 h-16 border-b border-[#d5d6ce] bg-[#f5f5ef]" />;
}
