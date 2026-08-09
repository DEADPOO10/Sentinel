"use client";

import { useState, useTransition } from "react";
import { ClipboardCheck, Sparkles } from "lucide-react";
import {
  requestDependencyImpactAnalysis,
  requestProposedFix,
  requestProposedFixValidation,
  type DependencyImpactAnalysisActionResult,
} from "@/actions/ai-analysis";
import type { ProposedFixResult } from "@/lib/openai/proposed-fix";
import type { ProposedFixValidationResult } from "@/lib/validation/proposed-fix-validation";
import { Button } from "@/components/ui/button";

type DependencyAiAnalysisProps = {
  owner: string;
  repository: string;
  dependencyName: string;
  dependencyType: string;
};

type SuccessfulAnalysis = Exclude<DependencyImpactAnalysisActionResult, { error: string }>;
type SuccessfulProposedFix = Extract<ProposedFixResult, { kind: "proposal" }>;

export function DependencyAiAnalysis({ owner, repository, dependencyName, dependencyType }: DependencyAiAnalysisProps) {
  const [result, setResult] = useState<DependencyImpactAnalysisActionResult | null>(null);
  const [fixResult, setFixResult] = useState<ProposedFixResult | null>(null);
  const [validationResult, setValidationResult] = useState<ProposedFixValidationResult | null>(null);
  const [isPending, startTransition] = useTransition();
  const [isFixPending, startFixTransition] = useTransition();
  const [isValidationPending, startValidationTransition] = useTransition();

  function requestAnalysis() {
    startTransition(async () => {
      setFixResult(null);
      setValidationResult(null);
      setResult(await requestDependencyImpactAnalysis({ owner, repository, dependencyName, dependencyType }));
    });
  }

  function requestFix(analysisResult: SuccessfulAnalysis) {
    startFixTransition(async () => {
      setValidationResult(null);
      setFixResult(await requestProposedFix({
        owner,
        repository,
        dependencyName,
        dependencyType,
        analysis: analysisResult.analysis,
        analysisTicket: analysisResult.analysisTicket,
      }));
    });
  }

  function requestValidation(analysisResult: SuccessfulAnalysis, proposedFixResult: SuccessfulProposedFix) {
    if (!proposedFixResult.validationTicket) return;

    startValidationTransition(async () => {
      setValidationResult(await requestProposedFixValidation({
        owner,
        repository,
        dependencyName,
        dependencyType,
        analysis: analysisResult.analysis,
        analysisTicket: analysisResult.analysisTicket,
        proposal: proposedFixResult.proposal,
        proposedFixTicket: proposedFixResult.validationTicket,
      }));
    });
  }

  return <div className="min-w-56"><Button type="button" size="sm" variant="outline" disabled={isPending} onClick={requestAnalysis}><Sparkles className="h-3.5 w-3.5" />{isPending ? "Analyzing…" : "Analyze with AI"}</Button>{result && ("error" in result ? <p role="alert" className="mt-2 text-xs leading-5 text-rose-700">{result.error}</p> : <AnalysisCard analysisResult={result} fixResult={fixResult} validationResult={validationResult} isFixPending={isFixPending} isValidationPending={isValidationPending} onGenerateFix={requestFix} onValidate={requestValidation} />)}</div>;
}

function AnalysisCard({ analysisResult, fixResult, validationResult, isFixPending, isValidationPending, onGenerateFix, onValidate }: { analysisResult: SuccessfulAnalysis; fixResult: ProposedFixResult | null; validationResult: ProposedFixValidationResult | null; isFixPending: boolean; isValidationPending: boolean; onGenerateFix: (analysisResult: SuccessfulAnalysis) => void; onValidate: (analysisResult: SuccessfulAnalysis, proposedFixResult: SuccessfulProposedFix) => void }) {
  const { analysis } = analysisResult;

  return <article className="mt-3 rounded-lg border border-amber-200 bg-[#fffaf0] p-4 text-left"><div className="flex items-center gap-2 text-sm font-medium text-[#92400e]"><Sparkles className="h-4 w-4" />AI Impact Analysis</div><div className="mt-3 flex flex-wrap gap-2 text-xs"><span className="rounded-full bg-amber-100 px-2 py-1 font-medium uppercase text-amber-800">Risk: {analysis.risk}</span><span className="rounded-full bg-emerald-50 px-2 py-1 font-medium text-emerald-800">Confidence: {analysis.confidence}%</span></div><RepositoryUsage analysis={analysis} /><ReleaseEvidence analysis={analysis} /><AnalysisSection label="Summary" value={analysis.summary} /><AnalysisSection label="Potential impact" value={analysis.potentialImpact} /><AnalysisSection label="Risk explanation" value={analysis.riskExplanation} /><AnalysisSection label="Recommendation" value={analysis.recommendedNextStep} /><div className="mt-4 border-t border-amber-200 pt-4"><Button type="button" size="sm" variant="outline" disabled={isFixPending} onClick={() => onGenerateFix(analysisResult)}><Sparkles className="h-3.5 w-3.5" />{isFixPending ? "Generating proposal…" : "Generate proposed fix"}</Button><p className="mt-2 text-xs leading-5 text-[#6b7280]">Proposal only — no repository files have been changed.</p>{fixResult && <ProposedFixPanel result={fixResult} validationResult={validationResult} isValidationPending={isValidationPending} onValidate={(proposal) => onValidate(analysisResult, proposal)} />}</div></article>;
}

function RepositoryUsage({ analysis }: { analysis: SuccessfulAnalysis["analysis"] }) {
  const { repositoryUsage, relevantFiles } = analysis;

  if (repositoryUsage.inspectionStatus === "unavailable") return <p className="mt-3 text-xs leading-5 text-[#6b7280]">Repository usage could not be inspected for this analysis.</p>;

  return <div className="mt-3 text-xs leading-5 text-[#6b7280]"><p>Repository usage found: {repositoryUsage.matchingFiles} {repositoryUsage.matchingFiles === 1 ? "file" : "files"}</p>{repositoryUsage.matchingFiles === 0 ? <p className="mt-1">No direct repository usage was found in the {repositoryUsage.filesInspected} inspected files. This does not prove the dependency is unused.</p> : relevantFiles.length > 0 ? <div className="mt-1"><p className="font-medium text-[#4b5563]">Relevant files</p><ul className="mt-1 space-y-0.5 font-mono text-[11px]">{relevantFiles.map((filePath) => <li key={filePath}>{filePath}</li>)}</ul></div> : null}</div>;
}

function ReleaseEvidence({ analysis }: { analysis: SuccessfulAnalysis["analysis"] }) {
  const { releaseInformation } = analysis;

  if (releaseInformation.availability === "unavailable") return <div className="mt-3 text-xs leading-5 text-[#6b7280]"><p className="font-medium text-[#4b5563]">Release evidence</p><p className="mt-1">Release evidence was unavailable for this analysis.</p></div>;

  const source = releaseInformation.source === "github-releases" ? "GitHub Releases" : releaseInformation.source === "npm-metadata" ? "npm metadata" : "changelog";
  const indicators = `${releaseInformation.breakingChangeIndicators} breaking indicator${releaseInformation.breakingChangeIndicators === 1 ? "" : "s"} · ${releaseInformation.migrationIndicators} migration indicator${releaseInformation.migrationIndicators === 1 ? "" : "s"}`;
  const hasReleaseNotes = releaseInformation.evidence.some((release) => release.excerpt);

  return <div className="mt-3 text-xs leading-5 text-[#6b7280]"><p className="font-medium text-[#4b5563]">Release evidence</p><p className="mt-1">{releaseInformation.releasesExamined} release{releaseInformation.releasesExamined === 1 ? "" : "s"} examined · {source}</p><p>{indicators}</p>{!hasReleaseNotes && <p className="mt-1">Release notes were unavailable; only version metadata was found.</p>}</div>;
}

function ProposedFixPanel({ result, validationResult, isValidationPending, onValidate }: { result: ProposedFixResult; validationResult: ProposedFixValidationResult | null; isValidationPending: boolean; onValidate: (proposal: SuccessfulProposedFix) => void }) {
  if (result.kind === "error") return <p role="alert" className="mt-3 text-xs leading-5 text-rose-700">{result.error}</p>;
  if (result.kind === "insufficient-context") return <section className="mt-3 rounded-md border border-amber-200 bg-white/70 p-3 text-xs leading-5 text-[#6b7280]"><p className="font-medium text-[#4b5563]">More context needed</p><p className="mt-1">Sentinel could not verify enough repository usage to safely propose source-code changes.</p><p className="mt-2">{result.reason}</p><p className="mt-3 font-medium text-[#4b5563]">What Sentinel verified</p><ul className="mt-1 list-disc space-y-1 pl-4">{result.verifiedContext.map((item, index) => <li key={`verified-${index}`}>{item}</li>)}</ul><p className="mt-3 font-medium text-[#4b5563]">Additional context needed</p><p className="mt-1">{result.additionalContextNeeded}</p><p className="mt-3 font-medium text-[#4b5563]">Suggested next step</p><p className="mt-1">{result.suggestedNextStep}</p><p className="mt-3 rounded-md bg-[#fffaf0] px-3 py-2 text-[#92400e]">No repository files were changed.</p></section>;

  const { proposal } = result;
  return <section className="mt-4 rounded-lg border border-[#f3e8d5] bg-white p-4 text-xs leading-5 text-[#4b5563]"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-[#111827]">Proposed Fix</p><span className="rounded-full bg-emerald-50 px-2 py-1 font-medium text-emerald-800">Confidence: {proposal.confidence}%</span></div><p className="mt-2 font-medium text-[#111827]">{proposal.title}</p><p className="mt-1">{proposal.summary}</p><p className="mt-3 rounded-md bg-[#fffaf0] px-3 py-2 text-[#92400e]">Proposal only — no repository files have been changed.</p><p className="mt-3 font-medium text-[#111827]">Files affected: {proposal.files.length}</p>{proposal.files.map((file) => <article key={file.path} className="mt-3 border-t border-[#f3e8d5] pt-3"><p className="font-mono text-[11px] font-medium text-[#92400e]">{file.path}</p><p className="mt-1">{file.reason}</p><div className="mt-2 grid gap-2 lg:grid-cols-2"><CodeBlock label="Before" value={file.originalSnippet} /><CodeBlock label="Proposed" value={file.proposedSnippet} /></div></article>)}<PackageJsonChange proposal={proposal} /><TextList label="Validation steps" values={proposal.validationSteps} /><TextList label="Warnings" values={proposal.warnings} />{result.validationTicket && <div className="mt-4 border-t border-[#f3e8d5] pt-4"><Button type="button" size="sm" variant="outline" disabled={isValidationPending} onClick={() => onValidate(result)}><ClipboardCheck className="h-3.5 w-3.5" />{isValidationPending ? "Validating proposal…" : "Validate proposed fix"}</Button><p className="mt-2 text-xs leading-5 text-[#6b7280]">Validation uses an isolated temporary workspace. No repository changes will be pushed.</p></div>}{validationResult && <ValidationResults result={validationResult} />}</section>;
}

function ValidationResults({ result }: { result: ProposedFixValidationResult }) {
  return <section className="mt-4 rounded-md border border-amber-200 bg-[#fffaf0] p-3 text-xs leading-5 text-[#4b5563]"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-semibold text-[#111827]">Validation Results</p><StatusPill value={result.overallStatus} /></div><p className="mt-2 rounded-md bg-white/70 px-3 py-2 text-[#92400e]">Validation ran in an isolated temporary workspace. No repository changes were pushed.</p><ValidationStage name="Install" status={result.install.status} durationMs={null} summary={result.install.summary} />{result.checks.map((check) => <ValidationStage key={check.name} name={check.name === "typecheck" ? "Typecheck" : check.name === "lint" ? "Lint" : check.name === "test" ? "Tests" : "Build"} status={check.status} durationMs={check.durationMs} summary={check.summary} />)}{result.warnings.length > 0 && <div className="mt-3 border-t border-amber-200 pt-3"><p className="font-medium text-[#111827]">Warnings</p><ul className="mt-1 list-disc space-y-1 pl-4">{result.warnings.map((warning, index) => <li key={`validation-warning-${index}`}>{warning}</li>)}</ul></div>}</section>;
}

function ValidationStage({ name, status, durationMs, summary }: { name: string; status: string; durationMs: number | null; summary: string }) {
  return <div className="mt-3 border-t border-amber-200 pt-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-[#111827]">{name}</p><div className="flex items-center gap-2"><StatusPill value={status} />{durationMs !== null && <span className="text-[11px] text-[#6b7280]">{formatDuration(durationMs)}</span>}</div></div><p className="mt-1">{summary}</p></div>;
}

function StatusPill({ value }: { value: string }) {
  const normalized = value.replaceAll("_", " ");
  const classes = value === "passed" ? "bg-emerald-50 text-emerald-800" : value === "failed" || value === "timed_out" ? "bg-rose-50 text-rose-800" : "bg-amber-100 text-amber-800";
  return <span className={`rounded-full px-2 py-1 text-[11px] font-medium uppercase ${classes}`}>{normalized}</span>;
}

function formatDuration(durationMs: number) {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs >= 10_000 ? 0 : 1)}s`;
}

function CodeBlock({ label, value }: { label: string; value: string }) {
  return <div><p className="mb-1 font-medium text-[#4b5563]">{label}</p><pre className="overflow-x-auto rounded-md border border-[#f3e8d5] bg-[#fffaf0] p-3 font-mono text-[11px] leading-5 text-[#374151]"><code>{value}</code></pre></div>;
}

function PackageJsonChange({ proposal }: { proposal: Extract<ProposedFixResult, { kind: "proposal" }>["proposal"] }) {
  if (!proposal.packageJsonChange.required) return <p className="mt-3">No package.json change is proposed.</p>;

  return <div className="mt-3"><p className="font-medium text-[#111827]">Proposed package.json change</p><p className="mt-1 font-mono text-[11px]"><span className="text-rose-700">{proposal.packageJsonChange.dependency}: {proposal.packageJsonChange.from}</span><br /><span className="text-emerald-700">{proposal.packageJsonChange.dependency}: {proposal.packageJsonChange.to}</span></p></div>;
}

function TextList({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null;
  return <div className="mt-3"><p className="font-medium text-[#111827]">{label}</p><ul className="mt-1 list-disc space-y-1 pl-4">{values.map((value, index) => <li key={`${label}-${index}`}>{value}</li>)}</ul></div>;
}

function AnalysisSection({ label, value }: { label: string; value: string }) {
  return <div className="mt-3"><p className="text-xs font-medium uppercase tracking-[.1em] text-[#9ca3af]">{label}</p><p className="mt-1 text-xs leading-5 text-[#4b5563]">{value}</p></div>;
}
