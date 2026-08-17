import {
  ArrowRight,
  Check,
  FileCheck2,
  FileSearch,
  Github,
  GitPullRequestDraft,
  Radar,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { SiteNavigation } from "@/components/site-navigation";
import { Button } from "@/components/ui/button";

const capabilities = [
  {
    icon: ScanSearch,
    label: "01",
    title: "Dependency intelligence",
    description:
      "Scan npm dependencies, compare declared ranges with stable releases, and surface the updates that deserve attention.",
  },
  {
    icon: FileSearch,
    label: "02",
    title: "Release risk analysis",
    description:
      "Combine release evidence, version-change risk, and real repository usage to understand potential upgrade impact.",
  },
  {
    icon: Radar,
    label: "03",
    title: "Repository health monitoring",
    description:
      "Keep connected repositories visible through persisted scan summaries, update counts, and maintenance activity.",
  },
  {
    icon: ShieldCheck,
    label: "04",
    title: "Human-controlled maintenance",
    description:
      "Review proposed fixes, inspect isolated validation results, and decide when a verified Draft PR should be created.",
  },
] as const;

const workflow = [
  [
    "01",
    "Scan",
    "Sentinel reads the selected repository manifest and checks npm dependencies against stable releases.",
  ],
  [
    "02",
    "Understand",
    "Repository usage, release evidence, and AI analysis put each available update in context.",
  ],
  [
    "03",
    "Propose",
    "A bounded proposed fix is prepared for developer review without changing the connected repository.",
  ],
  [
    "04",
    "Validate",
    "The proposal runs through isolated checks before Sentinel can prepare a Draft PR for human approval.",
  ],
] as const;

const productSignals = [
  ["Package manifest", "Dependency versions mapped"],
  ["Release evidence", "Change type and risk classified"],
  ["Repository usage", "Relevant references inspected"],
  ["Validation", "Executed and skipped checks reported"],
] as const;

export default function Home() {
  return (
    <div className="min-h-screen bg-[#f5f5ef] text-[#171817]">
      <SiteNavigation />

      <main>
        <section
          id="product"
          className="mx-auto w-full max-w-[1440px] px-5 pb-20 pt-12 sm:px-8 sm:pb-24 sm:pt-16 lg:px-12 lg:pb-32 lg:pt-20"
        >
          <div className="grid overflow-hidden rounded-[2rem] border border-[#d5d6ce] bg-[#eeefe7] shadow-[0_24px_80px_rgba(23,24,23,0.08)] lg:grid-cols-[1.12fr_0.88fr]">
            <div className="flex flex-col justify-between px-6 py-10 sm:px-10 sm:py-14 lg:min-h-[680px] lg:px-14 lg:py-16">
              <div>
                <div className="mb-12 flex flex-wrap items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#55584f] sm:mb-16">
                  <span className="inline-flex items-center gap-2 rounded-full border border-[#c7c9bf] bg-[#f5f5ef] px-3 py-2">
                    <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    AI software maintenance
                  </span>
                  <span>Built for npm repositories</span>
                </div>

                <p className="mb-5 text-sm font-semibold uppercase tracking-[0.16em] text-[#55584f]">
                  Dependency intelligence for GitHub
                </p>
                <h1 className="max-w-4xl text-[clamp(3rem,7vw,6.8rem)] font-semibold leading-[0.91] tracking-[-0.065em]">
                  Understand every upgrade before it reaches your code.
                </h1>
                <p className="mt-8 max-w-2xl text-lg leading-8 text-[#55584f] sm:text-xl sm:leading-9">
                  Sentinel connects to GitHub, analyzes npm dependency updates with
                  repository and release context, validates proposed maintenance in
                  isolation, and prepares Draft PRs for human review.
                </p>

                <div className="mt-10 flex flex-col gap-3 sm:flex-row">
                  <Button
                    asChild
                    className="h-12 rounded-full bg-[#171817] px-6 text-sm font-semibold text-white hover:bg-[#2d2f2b]"
                  >
                    <a href="/login">
                      <Github className="mr-2 h-4 w-4" aria-hidden="true" />
                      Connect GitHub
                    </a>
                  </Button>
                  <Button
                    asChild
                    variant="outline"
                    className="h-12 rounded-full border-[#bfc1b7] bg-transparent px-6 text-sm font-semibold hover:bg-[#e5e6dd]"
                  >
                    <a href="#workflow">
                      See how it works
                      <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
                    </a>
                  </Button>
                </div>
              </div>

              <ul className="mt-14 grid gap-3 border-t border-[#d5d6ce] pt-6 text-sm font-medium text-[#454740] sm:grid-cols-3 lg:mt-20">
                {[
                  "Analysis first",
                  "Isolated validation",
                  "Human approval required",
                ].map((item) => (
                  <li key={item} className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#d8ff42]">
                      <Check className="h-3 w-3" aria-hidden="true" />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <ProductPanel />
          </div>
        </section>

        <section
          id="capabilities"
          aria-labelledby="capabilities-heading"
          className="border-y border-[#d5d6ce]"
        >
          <div className="mx-auto w-full max-w-[1440px] px-5 py-20 sm:px-8 sm:py-24 lg:px-12 lg:py-32">
            <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:gap-20">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#62645c]">
                  Product capabilities
                </p>
                <h2
                  id="capabilities-heading"
                  className="mt-4 max-w-lg text-4xl font-semibold leading-tight tracking-[-0.045em] sm:text-5xl"
                >
                  A clearer maintenance decision, from signal to review.
                </h2>
                <p className="mt-6 max-w-md text-base leading-7 text-[#62645c]">
                  Sentinel brings dependency status, release context, repository usage,
                  and validation evidence into one focused workflow.
                </p>
              </div>

              <div className="grid gap-px overflow-hidden rounded-3xl border border-[#d5d6ce] bg-[#d5d6ce] sm:grid-cols-2">
                {capabilities.map(({ icon: Icon, label, title, description }) => (
                  <article
                    key={title}
                    className="group min-h-72 bg-[#f5f5ef] p-7 transition-colors duration-200 hover:bg-[#eeefe7] sm:p-8"
                  >
                    <div className="flex items-center justify-between">
                      <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-[#c8cac0] bg-white/70">
                        <Icon className="h-5 w-5" aria-hidden="true" />
                      </span>
                      <span className="font-mono text-xs text-[#797b72]">{label}</span>
                    </div>
                    <h3 className="mt-12 text-2xl font-semibold tracking-[-0.035em]">
                      {title}
                    </h3>
                    <p className="mt-3 max-w-sm text-sm leading-6 text-[#62645c]">
                      {description}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section
          id="workflow"
          aria-labelledby="workflow-heading"
          className="bg-[#171817] text-white"
        >
          <div className="mx-auto w-full max-w-[1440px] px-5 py-20 sm:px-8 sm:py-24 lg:px-12 lg:py-32">
            <div className="flex flex-col justify-between gap-8 border-b border-white/15 pb-12 lg:flex-row lg:items-end">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d8ff42]">
                  The Sentinel workflow
                </p>
                <h2
                  id="workflow-heading"
                  className="mt-4 max-w-3xl text-4xl font-semibold leading-tight tracking-[-0.05em] sm:text-6xl"
                >
                  Evidence before edits. Validation before review.
                </h2>
              </div>
              <p className="max-w-md text-base leading-7 text-white/60">
                Each step adds context while keeping the developer in control of what
                advances toward a GitHub Draft PR.
              </p>
            </div>

            <div className="divide-y divide-white/15">
              {workflow.map(([number, title, description]) => (
                <article
                  key={number}
                  className="grid gap-4 py-8 sm:grid-cols-[72px_0.7fr_1.3fr] sm:items-start sm:gap-8 lg:py-10"
                >
                  <span className="font-mono text-sm text-[#d8ff42]">{number}</span>
                  <h3 className="text-2xl font-semibold tracking-[-0.035em]">
                    {title}
                  </h3>
                  <p className="max-w-xl text-sm leading-7 text-white/60">
                    {description}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section aria-labelledby="control-heading" className="bg-[#d8ff42]">
          <div className="mx-auto grid w-full max-w-[1440px] gap-10 px-5 py-20 sm:px-8 sm:py-24 lg:grid-cols-[1.1fr_0.9fr] lg:items-end lg:px-12 lg:py-28">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em]">
                Human-controlled by design
              </p>
              <h2
                id="control-heading"
                className="mt-4 max-w-4xl text-4xl font-semibold leading-[1.02] tracking-[-0.055em] sm:text-6xl"
              >
                Sentinel prepares the decision. Your team owns it.
              </h2>
            </div>
            <div className="space-y-4 border-l border-[#171817]/30 pl-6 text-sm leading-6 sm:pl-8">
              <p className="flex items-start gap-3">
                <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
                Proposed changes require review and validation evidence.
              </p>
              <p className="flex items-start gap-3">
                <GitPullRequestDraft
                  className="mt-0.5 h-5 w-5 shrink-0"
                  aria-hidden="true"
                />
                GitHub pull requests are created as Drafts and are never auto-merged.
              </p>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-[1440px] px-5 py-20 sm:px-8 sm:py-24 lg:px-12 lg:py-32">
          <div className="flex flex-col items-start justify-between gap-10 rounded-[2rem] border border-[#d5d6ce] bg-[#eeefe7] px-7 py-10 sm:px-10 sm:py-12 lg:flex-row lg:items-center lg:px-14">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#62645c]">
                Start with one repository
              </p>
              <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-[-0.045em] sm:text-5xl">
                Turn dependency updates into informed maintenance work.
              </h2>
            </div>
            <Button
              asChild
              className="h-12 shrink-0 rounded-full bg-[#171817] px-6 text-sm font-semibold text-white hover:bg-[#2d2f2b]"
            >
              <a href="/login">
                Connect GitHub
                <ArrowRight className="ml-2 h-4 w-4" aria-hidden="true" />
              </a>
            </Button>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  );
}

function ProductPanel() {
  return (
    <aside className="relative overflow-hidden bg-[#171817] p-6 text-white sm:p-9 lg:p-12">
      <div
        className="absolute inset-0 opacity-[0.08]"
        aria-hidden="true"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,.35) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.35) 1px, transparent 1px)",
          backgroundSize: "40px 40px",
        }}
      />
      <div className="relative flex h-full min-h-[560px] flex-col">
        <div className="flex items-center justify-between border-b border-white/15 pb-5">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#d8ff42] text-[#171817]">
              <Radar className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <p className="text-sm font-semibold">Maintenance intelligence</p>
              <p className="text-xs text-white/50">Repository-level evidence</p>
            </div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/70">
            <span className="h-1.5 w-1.5 rounded-full bg-[#d8ff42]" />
            Analysis ready
          </span>
        </div>

        <div className="my-auto py-10">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#d8ff42]">
            One connected workflow
          </p>
          <h2 className="mt-4 max-w-xl text-3xl font-semibold leading-tight tracking-[-0.045em] sm:text-4xl">
            From package signal to reviewable maintenance.
          </h2>

          <div className="mt-9 overflow-hidden rounded-2xl border border-white/15 bg-white/[0.04]">
            {productSignals.map(([label, detail], index) => (
              <div
                key={label}
                className={`flex items-start justify-between gap-5 px-5 py-4 ${
                  index < productSignals.length - 1 ? "border-b border-white/10" : ""
                }`}
              >
                <span className="text-xs font-semibold uppercase tracking-[0.14em] text-white/45">
                  {label}
                </span>
                <span className="max-w-[15rem] text-right text-sm text-white/85">
                  {detail}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-[#d8ff42]/35 bg-[#d8ff42]/10 p-5">
          <div className="flex items-start gap-3">
            <ShieldCheck
              className="mt-0.5 h-5 w-5 shrink-0 text-[#d8ff42]"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold">Human approval remains required</p>
              <p className="mt-1 text-xs leading-5 text-white/55">
                Sentinel can prepare a Draft PR after policy checks. It does not merge
                changes automatically.
              </p>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[#d5d6ce]">
      <div className="mx-auto flex w-full max-w-[1440px] flex-col gap-6 px-5 py-8 text-xs text-[#62645c] sm:px-8 md:flex-row md:items-center md:justify-between lg:px-12">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#171817] text-[#d8ff42]">
            <Radar className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="font-semibold uppercase tracking-[0.16em] text-[#171817]">
            Sentinel
          </span>
          <span aria-hidden="true">/</span>
          <span>AI software maintenance engineer</span>
        </div>
        <p>Analysis first · Human controlled · No auto-merge</p>
      </div>
    </footer>
  );
}
