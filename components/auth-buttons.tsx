"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  FolderGit2,
  Github,
  Home,
  LayoutDashboard,
  LogIn,
  LogOut,
  Settings,
} from "lucide-react";
import { signInWithGitHub, signOutUser } from "@/actions/auth";
import { Button } from "@/components/ui/button";

export function SignInWithGitHubButton({
  callbackUrl = "/dashboard",
}: {
  callbackUrl?: string;
}) {
  return (
    <form action={signInWithGitHub}>
      <input type="hidden" name="callbackUrl" value={callbackUrl} />
      <Button type="submit" className="w-full">
        <Github className="h-4 w-4" />
        Continue with GitHub
      </Button>
    </form>
  );
}

export function SignOutButton() {
  return (
    <form action={signOutUser}>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        aria-label="Sign out of Sentinel"
      >
        <LogOut className="h-4 w-4" />
        <span className="hidden sm:inline">Logout</span>
      </Button>
    </form>
  );
}

export function SiteNavigationLinks({
  authenticated,
}: {
  authenticated: boolean;
}) {
  const pathname = usePathname();
  const links = authenticated
    ? [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/repositories", label: "Repositories", icon: FolderGit2 },
        { href: "/settings", label: "Settings", icon: Settings },
      ]
    : [
        { href: "/", label: "Home", icon: Home },
        { href: "/login", label: "Login", icon: LogIn },
      ];

  return (
    <div className="flex items-center gap-1" aria-label="Primary navigation">
      {links.map((link) => {
        const isActive =
          pathname === link.href ||
          (link.href !== "/" && pathname.startsWith(`${link.href}/`));
        const Icon = link.icon;

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            aria-label={link.label}
            className={`relative inline-flex h-10 items-center gap-2 border px-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171817] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f5f5ef] sm:px-3 ${
              isActive
                ? "border-[#171817] bg-[#ecece5] text-[#171817] after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:bg-[#d8ff42]"
                : "border-transparent text-[#696b66] hover:border-[#d5d6ce] hover:bg-[#ecece5] hover:text-[#171817]"
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="hidden lg:inline">{link.label}</span>
          </Link>
        );
      })}
    </div>
  );
}
