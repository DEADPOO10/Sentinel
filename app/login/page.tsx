import {
  ArrowUpRight,
  GitBranch,
  ScanSearch,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { auth } from "@/auth";
import { SignInWithGitHubButton } from "@/components/auth-buttons";
import { SiteNavigation } from "@/components/site-navigation";
import { Badge } from "@/components/ui/badge";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return (
    <main className="sentinel-page">
      <SiteNavigation />

      <section className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl border-x border-[#d5d6ce] bg-[#f9f9f5] lg:grid-cols-[1.08fr_.92fr]">
        <div className="relative flex overflow-hidden px-6 py-14 sm:px-10 sm:py-16 lg:items-center lg:px-12 lg:py-20">
          <div className="absolute inset-x-0 top-0 h-1 bg-[#d8ff42]" />
          <div className="relative max-w-2xl">
            <div className="mb-7 flex items-center gap-3">
              <span className="grid h-10 w-10 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817]">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <div>
                <p className="text-lg font-medium tracking-[-.04em] text-[#171817]">
                  Sentinel
                </p>
                <p className="font-mono text-[9px] uppercase tracking-[.16em] text-[#8a8d86]">
                  AI software maintenance engineer
                </p>
              </div>
            </div>

            <p className="eyebrow">SECURE WORKSPACE ACCESS</p>
            <h1 className="editorial-title mt-5 text-5xl text-[#171817] sm:text-6xl lg:text-7xl">
              Keep dependencies moving without losing control.
            </h1>
            <p className="mt-7 max-w-xl text-base leading-7 text-[#696b66] sm:text-lg sm:leading-8">
              Connect your GitHub account to identify dependency risk, review
              maintenance insights, and validate proposed upgrades before they
              reach a Draft PR.
            </p>

            <div className="mt-10 grid gap-3 sm:grid-cols-3">
              <ProductSignal
                icon={<GitBranch />}
                title="Repository intelligence"
                detail="Real repository and package context"
              />
              <ProductSignal
                icon={<ScanSearch />}
                title="Dependency monitoring"
                detail="Version, release, and risk signals"
              />
              <ProductSignal
                icon={<Sparkles />}
                title="Maintenance insights"
                detail="Review-focused impact analysis"
              />
            </div>
          </div>
        </div>

        <aside className="tech-panel flex items-center border-0 border-t border-[#171817] px-6 py-14 sm:px-10 lg:border-l lg:border-t-0 lg:px-12 lg:py-20">
          <div className="w-full">
            <div className="mb-5 flex items-center justify-between gap-4">
              <p className="font-mono text-[10px] uppercase tracking-[.16em] text-[#d8ff42]">
                GITHUB / AUTHENTICATION
              </p>
              <span className="font-mono text-[9px] uppercase tracking-[.12em] text-[#8f938a]">
                01 / 01
              </span>
            </div>

            <div className="border border-[#4b4e48] bg-[#f9f9f5] p-6 text-[#171817] sm:p-8">
              <Badge variant="info" className="px-3 py-1.5">
                GitHub workspace
              </Badge>
              <h2 className="mt-6 text-3xl font-medium tracking-[-.045em]">
                Sign in to your maintenance workspace.
              </h2>
              <p className="mt-4 text-sm leading-6 text-[#696b66]">
                Use the GitHub account that can access the repositories you
                want Sentinel to analyze.
              </p>

              <div className="mt-8 border-t border-[#d5d6ce] pt-6">
                <SignInWithGitHubButton />
              </div>

              <div className="mt-6 flex gap-3 border border-[#d5d6ce] bg-[#f5f5ef] p-4">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[#343633]" />
                <p className="text-xs leading-5 text-[#696b66]">
                  Sentinel keeps maintenance human-controlled. Repository
                  changes are not merged automatically.
                </p>
              </div>
            </div>

            <div className="mt-6 flex items-center justify-between gap-4 text-[#b9bcb4]">
              <p className="max-w-xs text-xs leading-5">
                Continue to authenticate through the existing GitHub sign-in
                flow.
              </p>
              <ArrowUpRight className="h-4 w-4 shrink-0 text-[#d8ff42]" />
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}

function ProductSignal({
  icon,
  title,
  detail,
}: {
  icon: ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="border border-[#d5d6ce] bg-[#f5f5ef] p-4">
      <span className="grid h-8 w-8 place-items-center border border-[#d5d6ce] bg-[#f9f9f5] text-[#343633] [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <p className="mt-4 text-sm font-medium tracking-[-.02em] text-[#171817]">
        {title}
      </p>
      <p className="mt-1.5 text-xs leading-5 text-[#696b66]">{detail}</p>
    </div>
  );
}
