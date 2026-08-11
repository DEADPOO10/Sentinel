import Link from "next/link";
import { SignOutButton } from "@/components/auth-buttons";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/session";
import { ShieldCheck } from "lucide-react";

export async function SiteNavigation() {
  const user = await getCurrentUser();
  const isAuthenticated = Boolean(user);
  return <nav className="sticky top-0 z-30 border-b border-[#d5d6ce] bg-[#f5f5ef]/95 backdrop-blur"><div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6 lg:px-8"><Link href="/" className="flex items-center gap-2.5 font-medium tracking-[-.04em] text-[#171817]"><span className="grid h-7 w-7 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817]"><ShieldCheck className="h-4 w-4" /></span><span>sentinel</span></Link>{isAuthenticated ? <div className="flex items-center gap-1 sm:gap-5"><Link href="/dashboard" className="hidden text-sm text-[#696b66] transition-colors hover:text-[#171817] sm:inline">Dashboard</Link><Link href="/repositories" className="hidden text-sm text-[#696b66] transition-colors hover:text-[#171817] sm:inline">Repositories</Link><Link href="/settings" className="text-sm text-[#696b66] transition-colors hover:text-[#171817]">Settings</Link><SignOutButton /></div> : <div className="flex items-center gap-4"><Link href="/" className="hidden text-sm text-[#696b66] transition-colors hover:text-[#171817] sm:inline">Home</Link><Link href="/login" className="hidden text-sm text-[#696b66] transition-colors hover:text-[#171817] sm:inline">Login</Link><Button asChild size="sm"><Link href="/login">Get Started</Link></Button></div>}</div></nav>;
}
