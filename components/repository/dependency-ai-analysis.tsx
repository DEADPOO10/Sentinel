"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { requestDependencyImpactAnalysis, type DependencyImpactAnalysisActionResult } from "@/actions/ai-analysis";
import { Button } from "@/components/ui/button";

type DependencyAiAnalysisProps = {
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
};

export function DependencyAiAnalysis({ owner, repository, dependencyName, dependencyType }: DependencyAiAnalysisProps) {
  const [result, setResult] = useState<DependencyImpactAnalysisActionResult | null>(null);
  const [isPending, startTransition] = useTransition();

  function requestAnalysis() {
    startTransition(async () => {
      setResult(await requestDependencyImpactAnalysis({ owner, repository, dependencyName, dependencyType }));
    });
  }

  return <div className="min-w-56"><Button type="button" size="sm" variant="outline" disabled={isPending} onClick={requestAnalysis}><Sparkles className="h-3.5 w-3.5" />{isPending ? "Analyzing…" : "Analyze with AI"}</Button>{result && ("error" in result ? <p role="alert" className="mt-2 text-xs leading-5 text-rose-700">{result.error}</p> : <AnalysisCard analysis={result.analysis} />)}</div>;
}

function AnalysisCard({ analysis }: { analysis: Exclude<DependencyImpactAnalysisActionResult, { error: string }>["analysis"] }) {
  return <article className="mt-3 rounded-lg border border-amber-200 bg-[#fffaf0] p-4 text-left"><div className="flex items-center gap-2 text-sm font-medium text-[#92400e]"><Sparkles className="h-4 w-4" />AI Impact Analysis</div><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-amber-100 px-2 py-1 font-medium uppercase text-amber-800">Risk: {analysis.risk}</span><span className="rounded-full bg-emerald-50 px-2 py-1 font-medium text-emerald-800">Confidence: {analysis.confidence}%</span></div><RepositoryUsage analysis={analysis} /><AnalysisSection label="Summary" value={analysis.summary} /><AnalysisSection label="Potential impact" value={analysis.potentialImpact} /><AnalysisSection label="Risk explanation" value={analysis.riskExplanation} /><AnalysisSection label="Recommendation" value={analysis.recommendedNextStep} /></article>;
}

function RepositoryUsage({ analysis }: { analysis: Exclude<DependencyImpactAnalysisActionResult, { error: string }>["analysis"] }) {
  const { repositoryUsage, relevantFiles } = analysis;

  if (repositoryUsage.inspectionStatus === "unavailable") return <p className="mt-3 text-xs leading-5 text-[#6b7280]">Repository usage could not be inspected for this analysis.</p>;

  return <div className="mt-3 text-xs leading-5 text-[#6b7280]"><p>Repository usage found: {repositoryUsage.matchingFiles} {repositoryUsage.matchingFiles === 1 ? "file" : "files"}</p>{repositoryUsage.matchingFiles === 0 ? <p className="mt-1">No direct repository usage was found in the {repositoryUsage.filesInspected} inspected files. This does not prove the dependency is unused.</p> : relevantFiles.length > 0 ? <div className="mt-1"><p className="font-medium text-[#4b5563]">Relevant files</p><ul className="mt-1 space-y-0.5 font-mono text-[11px]">{relevantFiles.map((filePath) => <li key={filePath}>{filePath}</li>)}</ul></div> : null}</div>;
}

function AnalysisSection({ label, value }: { label: string; value: string }) {
  return <div className="mt-3"><p className="text-xs font-medium uppercase tracking-[.1em] text-[#9ca3af]">{label}</p><p className="mt-1 text-xs leading-5 text-[#4b5563]">{value}</p></div>;
}
