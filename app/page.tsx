import {
  ArrowRight,
  BadgeCheck,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  FileCode2,
  GitBranch,
  Github,
  HeartPulse,
  Network,
  Radar,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SiteNavigation } from "@/components/site-navigation";

const features = [
  ["AI Release Note Analysis", "Sentinel reads release notes and identifies breaking changes before they impact your team.", Sparkles],
  ["Repository Health Score", "Understand the health of every repository at a glance, with clear signals for what needs attention.", HeartPulse],
  ["Automated Pull Requests", "Receive production-ready pull requests with clear explanations your team can review with confidence.", GitBranch],
  ["Dependency Intelligence", "Track dependency changes across your entire software stack without chasing disparate changelogs.", Network],
  ["Safe AI Recommendations", "Every suggestion includes reasoning and confidence, so your team stays in control of every change.", ShieldCheck],
  ["Developer-first Workflow", "Designed to work with GitHub instead of replacing it, fitting naturally into the way you already ship.", Code2],
] as const;

const faqs = [
  ["Does Sentinel change my code automatically?", "No. Sentinel prepares pull requests for your review."],
  ["Does Sentinel support private repositories?", "Yes. Sentinel is designed to work with private repositories."],
  ["Which languages are supported?", "JavaScript and TypeScript first. More languages are coming soon."],
  ["Can I use Sentinel with GitHub?", "Yes. GitHub is our first integration."],
] as const;

export default function Home() {
  return (
    <main className="overflow-hidden bg-[#fffdf8] text-[#111827]">
      <section id="product" className="relative isolate border-b border-[#f3e8d5]">
        <div className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_72%_62%_at_50%_-8%,#fef3c7,transparent_72%)]" />
        <div className="absolute -right-40 top-48 -z-10 h-80 w-80 rounded-full bg-[#fbbf24]/10 blur-[110px]" />
        <SiteNavigation />
        <div className="mx-auto grid max-w-7xl gap-14 px-6 pb-24 pt-20 sm:pt-24 lg:grid-cols-[1.04fr_.96fr] lg:items-center lg:px-8 lg:pb-32 lg:pt-28">
          <div className="max-w-3xl">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#f3e8d5] bg-white/75 px-3 py-1.5 text-xs font-medium text-[#92400e] shadow-sm shadow-amber-900/5">
              <span className="h-1.5 w-1.5 rounded-full bg-[#f59e0b]" />
              Maintenance, without the maintenance work.
            </div>
            <h1 className="max-w-3xl text-balance text-5xl font-medium tracking-[-0.058em] text-[#111827] sm:text-6xl lg:text-[4.6rem] lg:leading-[1.02]">
              Stop wasting engineering time on software maintenance.
            </h1>
            <p className="mt-7 text-lg font-medium text-[#92400e] sm:text-xl">The AI Maintenance Engineer.</p>
            <p className="mt-4 max-w-xl text-pretty text-base leading-8 text-[#4b5563] sm:text-lg">
              Meet Sentinel — the AI Maintenance Engineer that continuously monitors your repositories, detects breaking changes, understands release notes, and prepares pull requests before technical debt slows your team down.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <Button asChild size="lg"><a href="mailto:hello@sentinel.dev?subject=Sentinel%20Early%20Access">Request Early Access <ArrowRight className="h-4 w-4" /></a></Button>
              <Button asChild variant="outline" size="lg"><a href="https://github.com" target="_blank" rel="noreferrer"><Github className="h-4 w-4" />View on GitHub</a></Button>
            </div>
            <p className="mt-5 text-xs text-[#6b7280]">Spend less time maintaining software. Spend more time building it.</p>
          </div>
          <WorkflowPreview />
        </div>
      </section>

      <section id="how-it-works" className="mx-auto max-w-7xl px-6 py-28 lg:px-8 lg:py-32">
        <SectionIntro eyebrow="HOW IT WORKS" title="A focused workflow for a healthier codebase." description="Sentinel turns upstream changes into a calm, reviewable workflow — without adding another dashboard your team has to babysit." />
        <div className="mt-14 grid gap-5 md:grid-cols-3">
          {[
            ["01", "Connect your code", "Install the GitHub app and choose the repositories you want Sentinel to watch."],
            ["02", "See changes early", "Sentinel monitors releases and maps potential risk before it reaches your backlog."],
            ["03", "Review with context", "Receive focused recommendations and ready-to-review pull requests in your existing workflow."],
          ].map(([number, title, copy]) => <StepCard key={number} number={number} title={title} copy={copy} />)}
        </div>
      </section>

      <section className="border-y border-[#f3e8d5] bg-[#fffbf3]">
        <div className="mx-auto max-w-7xl px-6 py-28 lg:px-8 lg:py-32">
          <div className="grid gap-12 lg:grid-cols-[.85fr_1.15fr] lg:items-end">
            <SectionIntro eyebrow="WHY SENTINEL" title="Software maintenance shouldn’t steal engineering time." description="Sentinel automates repetitive maintenance so developers can focus on building products." />
            <div className="grid gap-3 sm:grid-cols-2">
              {[
                ["Reading release notes", BookOpen],
                ["Updating dependencies", GitBranch],
                ["Fixing deprecated APIs", FileCode2],
                ["Resolving version conflicts", CircleAlert],
              ].map(([label, Icon]) => { const ItemIcon = Icon as typeof BookOpen; return <div key={label as string} className="group flex items-center gap-3 rounded-lg border border-[#f3e8d5] bg-white p-4 shadow-sm shadow-amber-900/[.035] transition-all hover:-translate-y-0.5 hover:border-[#fbbf24]/70 hover:shadow-md hover:shadow-amber-900/[.06]"><span className="grid h-9 w-9 place-items-center rounded-md bg-[#fef3c7] text-[#b45309] group-hover:text-[#92400e]"><ItemIcon className="h-4 w-4" /></span><span className="text-sm text-[#4b5563]">{label as string}</span></div>; })}
            </div>
          </div>
          <p className="mt-10 max-w-2xl border-l border-[#f59e0b]/60 pl-5 text-sm leading-7 text-[#6b7280]">Engineering teams spend hours every week keeping their stack current. Those small maintenance tasks add up — and pull attention away from the work that creates real leverage.</p>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28 lg:px-8 lg:py-32">
        <SectionIntro eyebrow="THE DIFFERENCE" title="Move from reactive maintenance to steady momentum." description="A simpler way to keep dependencies, APIs, and repository health from becoming a drag on product delivery." />
        <div className="mt-14 grid overflow-hidden rounded-xl border border-[#f3e8d5] bg-white shadow-sm shadow-amber-900/[.04] md:grid-cols-2">
          <ComparisonColumn title="Before Sentinel" tone="muted" items={["Reading release notes", "Dependency upgrades", "Broken APIs", "Manual pull requests", "Technical debt"]} />
          <ComparisonColumn title="After Sentinel" tone="active" items={["Continuous monitoring", "AI understands breaking changes", "Ready-to-review pull requests", "Repository health score", "Less maintenance work"]} />
        </div>
      </section>

      <section id="pricing" className="border-y border-[#f3e8d5] bg-[#fffbf3]">
        <div className="mx-auto max-w-7xl px-6 py-28 lg:px-8 lg:py-32">
          <SectionIntro eyebrow="FEATURES" title="Maintenance that moves at the speed of your stack." description="Clear signals, useful context, and a workflow built around the tools developers already trust." />
          <div className="mt-14 grid gap-px overflow-hidden rounded-xl border border-[#f3e8d5] bg-[#f3e8d5] shadow-sm shadow-amber-900/[.04] md:grid-cols-2 lg:grid-cols-3">
            {features.map(([title, copy, Icon]) => {
              const FeatureIcon = Icon as typeof Sparkles;
              return <article key={title} className="group bg-white p-7 transition-colors hover:bg-[#fffaf0]"><span className="grid h-10 w-10 place-items-center rounded-lg bg-[#fef3c7] text-[#b45309] transition-transform duration-300 group-hover:scale-105"><FeatureIcon className="h-5 w-5" /></span><h3 className="mt-7 text-lg font-medium text-[#111827]">{title}</h3><p className="mt-3 leading-7 text-sm text-[#6b7280]">{copy}</p></article>;
            })}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-24 lg:px-8 lg:py-28">
        <p className="text-center text-sm font-medium text-[#4b5563]">Built for modern engineering teams.</p>
        <div className="mx-auto mt-7 flex max-w-3xl flex-wrap justify-center gap-2.5">
          {["GitHub", "TypeScript", "Next.js", "Node.js", "OpenAI"].map((name) => <span key={name} className="rounded-full border border-[#f3e8d5] bg-white px-4 py-2 font-mono text-xs text-[#6b7280] shadow-sm shadow-amber-900/[.025]">{name}</span>)}
        </div>
      </section>

      <section id="docs" className="border-y border-[#f3e8d5] bg-[#fffbf3]">
        <div className="mx-auto max-w-3xl px-6 py-28 lg:px-8 lg:py-32">
          <SectionIntro eyebrow="FAQ" title="A few useful answers." description="The important details, before you get started." />
          <div className="mt-12 divide-y divide-[#f3e8d5] border-y border-[#f3e8d5]">
            {faqs.map(([question, answer]) => <details key={question} className="group py-5"><summary className="flex cursor-pointer list-none items-center justify-between gap-6 text-sm font-medium text-[#111827] marker:content-none">{question}<ChevronRight className="h-4 w-4 shrink-0 text-[#6b7280] transition-transform duration-200 group-open:rotate-90 group-open:text-[#d97706]" /></summary><p className="max-w-2xl pt-3 text-sm leading-7 text-[#6b7280]">{answer}</p></details>)}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-28 lg:px-8 lg:py-32">
        <div className="relative overflow-hidden rounded-2xl border border-[#f3e8d5] bg-white px-7 py-14 text-center shadow-sm shadow-amber-900/[.05] sm:px-14 sm:py-20">
          <div className="absolute inset-0 -z-0 bg-[radial-gradient(circle_at_50%_0%,#fef3c7,transparent_58%)]" />
          <div className="relative z-10 mx-auto max-w-2xl"><p className="font-mono text-xs tracking-[.16em] text-[#b45309]">EARLY ACCESS</p><h2 className="mt-4 text-balance text-3xl font-medium tracking-[-.04em] text-[#111827] sm:text-4xl">Ready to eliminate repetitive software maintenance?</h2><p className="mx-auto mt-4 max-w-lg text-sm leading-7 text-[#4b5563]">Join early adopters helping shape the future of AI-powered software maintenance.</p><Button asChild size="lg" className="mt-8"><a href="mailto:hello@sentinel.dev?subject=Sentinel%20Early%20Access">Request Early Access <ArrowRight className="h-4 w-4" /></a></Button></div>
        </div>
      </section>

      <Footer />
    </main>
  );
}

function WorkflowPreview() {
  const steps = [
    ["Repository connected", "acme/payments-api", Github, "complete"],
    ["Stripe SDK v19 released", "New release detected", Zap, "complete"],
    ["Breaking change detected", "PaymentIntent API update", CircleAlert, "attention"],
    ["AI analysis complete", "98% confidence", Bot, "complete"],
    ["Pull request ready", "sentinel/update-stripe-sdk", GitBranch, "ready"],
  ] as const;
  return <div className="relative mx-auto w-full max-w-lg rounded-2xl border border-[#f3e8d5] bg-white p-2 shadow-xl shadow-amber-900/[.08]"><div className="rounded-xl border border-[#f3e8d5] bg-white p-5"><div className="flex items-center justify-between border-b border-[#f3e8d5] pb-4"><div className="flex items-center gap-2 text-sm font-medium text-[#111827]"><Radar className="h-4 w-4 text-[#d97706]" />Sentinel workflow</div><span className="rounded-full bg-[#fef3c7] px-2 py-1 font-mono text-[10px] text-[#92400e]">LIVE</span></div><div className="mt-5 space-y-1.5">{steps.map(([title, detail, Icon, state], index) => { const iconStyle = state === "attention" ? "bg-[#fef3c7] text-[#b45309]" : state === "ready" ? "bg-emerald-50 text-emerald-600" : "bg-orange-50 text-[#d97706]"; return <div key={title} className="relative flex items-center gap-3 rounded-lg border border-[#f3e8d5] bg-[#fffdfa] px-3 py-2.5"><span className={`grid h-7 w-7 shrink-0 place-items-center rounded-md ${iconStyle}`}><Icon className="h-3.5 w-3.5" /></span><div className="min-w-0"><p className="truncate text-xs font-medium text-[#111827]">{title}</p><p className="mt-0.5 truncate text-[11px] text-[#6b7280]">{detail}</p></div>{index === 4 ? <BadgeCheck className="ml-auto h-4 w-4 shrink-0 text-emerald-600" /> : <span className={`ml-auto h-1.5 w-1.5 shrink-0 rounded-full ${state === "attention" ? "bg-[#f59e0b]" : "bg-[#fbbf24]"}`} />}</div>; })}</div><div className="mt-4 flex items-center justify-between border-t border-[#f3e8d5] pt-4 text-[11px] text-[#6b7280]"><span>Last checked just now</span><span className="flex items-center gap-1 text-[#b45309]">View activity <ArrowRight className="h-3 w-3" /></span></div></div></div>;
}

function SectionIntro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) { return <div className="max-w-2xl"><p className="font-mono text-xs tracking-[0.16em] text-[#b45309]">{eyebrow}</p><h2 className="mt-4 text-balance text-3xl font-medium tracking-[-0.04em] text-[#111827] sm:text-4xl">{title}</h2><p className="mt-4 max-w-xl leading-7 text-[#4b5563]">{description}</p></div>; }

function StepCard({ number, title, copy }: { number: string; title: string; copy: string }) { return <article className="group relative rounded-xl border border-[#f3e8d5] bg-white p-7 shadow-sm shadow-amber-900/[.035] transition-all hover:-translate-y-0.5 hover:border-[#fbbf24]/70 hover:shadow-md hover:shadow-amber-900/[.06]"><p className="font-mono text-xs text-[#b45309]">{number}</p><h3 className="mt-9 text-xl font-medium text-[#111827]">{title}</h3><p className="mt-3 leading-7 text-[#6b7280]">{copy}</p><ChevronRight className="absolute bottom-7 right-7 h-5 w-5 text-[#9ca3af] transition-transform group-hover:translate-x-0.5 group-hover:text-[#d97706]" /></article>; }

function ComparisonColumn({ title, tone, items }: { title: string; tone: "muted" | "active"; items: string[] }) { const positive = tone === "active"; return <article className={`p-7 sm:p-9 ${positive ? "bg-emerald-50/80" : "bg-stone-50"}`}><p className={`text-lg font-medium ${positive ? "text-emerald-800" : "text-[#374151]"}`}>{title}</p><ul className="mt-7 space-y-4">{items.map((item) => <li key={item} className="flex items-center gap-3 text-sm text-[#4b5563]"><span className={`grid h-5 w-5 place-items-center rounded-full ${positive ? "bg-emerald-100 text-emerald-700" : "bg-stone-200 text-stone-500"}`}>{positive ? <Check className="h-3.5 w-3.5" /> : <span className="text-xs leading-none">×</span>}</span>{item}</li>)}</ul></article>; }

function BrandMark() { return <span className="grid h-8 w-8 place-items-center rounded-lg border border-[#f3e8d5] bg-[#fef3c7] text-[#b45309]"><ShieldCheck className="h-[18px] w-[18px]" /></span>; }

function Footer() { return <footer className="border-t border-[#f3e8d5] bg-white"><div className="mx-auto max-w-7xl px-6 py-12 lg:px-8"><div className="flex flex-col justify-between gap-8 border-b border-[#f3e8d5] pb-10 md:flex-row md:items-start"><div><div className="flex items-center gap-2.5 font-semibold text-[#111827]"><BrandMark />sentinel</div><p className="mt-3 text-sm text-[#6b7280]">The AI Maintenance Engineer.</p></div><div className="grid grid-cols-2 gap-x-12 gap-y-3 text-sm text-[#6b7280] sm:grid-cols-4">{[["Product", "#product"], ["Pricing", "#pricing"], ["Docs", "#docs"], ["GitHub", "https://github.com"], ["Privacy", "#privacy"], ["Terms", "#terms"], ["Contact", "mailto:hello@sentinel.dev"]].map(([label, href]) => <a key={label} href={href} className="transition-colors hover:text-[#92400e]" {...(href.startsWith("http") ? { target: "_blank", rel: "noreferrer" } : {})}>{label}</a>)}</div></div><div className="flex flex-col gap-3 pt-6 text-xs text-[#9ca3af] sm:flex-row sm:justify-between"><span>© 2026 Sentinel, Inc.</span><span>Built for durable software.</span></div></div></footer>; }
