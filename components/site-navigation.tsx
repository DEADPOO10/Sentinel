import Link from "next/link";
import { SignOutButton } from "@/components/auth-buttons";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { ShieldCheck } from "lucide-react";

export async function SiteNavigation() {
  const user = await getCurrentUser();
  const isAuthenticated = Boolean(user);

  return <nav className="sticky top-0 z-30 mx-auto flex h-20 max-w-7xl items-center justify-between border-b border-[#f3e8d5]/70 bg-white/80 px-6 backdrop-blur-md lg:px-8"><Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight text-[#111827]"><span className="grid h-8 w-8 place-items-center rounded-lg border border-[#f3e8d5] bg-[#fef3c7] text-[#b45309]"><ShieldCheck className="h-[18px] w-[18px]" /></span>sentinel</Link>{isAuthenticated ? <div className="flex items-center gap-1 sm:gap-4"><Link href="/dashboard" className="hidden text-sm text-[#4b5563] transition-colors hover:text-[#92400e] sm:inline">Dashboard</Link><Link href="/repositories" className="hidden text-sm text-[#4b5563] transition-colors hover:text-[#92400e] sm:inline">Repositories</Link><Link href="/settings" className="text-sm text-[#4b5563] transition-colors hover:text-[#92400e]">Settings</Link><SignOutButton /></div> : <div className="flex items-center gap-4"><Link href="/" className="hidden text-sm text-[#4b5563] transition-colors hover:text-[#92400e] sm:inline">Home</Link><Link href="/login" className="hidden text-sm text-[#4b5563] transition-colors hover:text-[#92400e] sm:inline">Login</Link><Button asChild size="sm"><Link href="/login">Get Started</Link></Button></div>}</nav>;
}
