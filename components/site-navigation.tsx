import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import {
  SignOutButton,
  SiteNavigationLinks,
} from "@/components/auth-buttons";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";

export async function SiteNavigation() {
  const user = await getCurrentUser();
  const isAuthenticated = Boolean(user);
  const userLabel =
    user?.username ?? user?.name ?? user?.email ?? "GitHub user";
  const userInitial = userLabel.trim().charAt(0).toUpperCase() || "S";

  return (
    <nav
      aria-label="Global navigation"
      className="sticky top-0 z-30 border-b border-[#d5d6ce] bg-[#f5f5ef]/95 backdrop-blur"
    >
      <div className="mx-auto flex h-[4.5rem] max-w-7xl items-center justify-between gap-4 px-6 lg:px-8">
        <Link
          href="/"
          aria-label="Sentinel home"
          className="group flex shrink-0 items-center gap-3 text-[#171817] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171817] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f5f5ef]"
        >
          <span className="relative grid h-9 w-9 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817] transition-transform group-hover:-translate-y-0.5 dark:!border-[#252a30] dark:!bg-[#111417] dark:!text-[#d8ff42]">
            <ShieldCheck className="h-5 w-5" />
            <span className="absolute -right-1 -top-1 h-2 w-2 border border-[#171817] bg-[#f5f5ef] dark:!border-[#252a30] dark:!bg-[#080a0c]" />
          </span>
          <span>
            <span className="block text-base font-medium tracking-[-.045em]">
              sentinel
            </span>
            <span className="hidden font-mono text-[8px] uppercase tracking-[.14em] text-[#8a8d86] xl:block">
              Maintenance intelligence
            </span>
          </span>
        </Link>

        {isAuthenticated ? (
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            <SiteNavigationLinks authenticated />
            <ThemeToggle />

            <div className="hidden items-center gap-2.5 border-l border-[#d5d6ce] pl-3 xl:flex">
              <span className="grid h-8 w-8 shrink-0 place-items-center border border-[#171817] bg-[#ecece5] font-mono text-xs font-medium text-[#171817] dark:!border-[#252a30] dark:!bg-[#161a1e] dark:!text-[#f5f7fa]">
                {userInitial}
              </span>
              <span className="max-w-36 min-w-0">
                <span className="block truncate text-xs font-medium text-[#171817]">
                  {userLabel}
                </span>
                <span className="block font-mono text-[8px] uppercase tracking-[.1em] text-[#8a8d86]">
                  GitHub workspace
                </span>
              </span>
            </div>

            <SignOutButton />
          </div>
        ) : (
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:block">
              <SiteNavigationLinks authenticated={false} />
            </div>
            <Button asChild size="sm">
              <Link href="/login">Get Started</Link>
            </Button>
          </div>
        )}
      </div>
    </nav>
  );
}
