import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SignInWithGitHubButton } from "@/components/auth-buttons";
import { SiteNavigation } from "@/components/site-navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default async function LoginPage() {
  const session = await auth();
  if (session?.user) redirect("/dashboard");

  return <main className="min-h-screen bg-[#fffdf8] text-[#111827]"><SiteNavigation /><section className="mx-auto flex min-h-[calc(100vh-5rem)] max-w-7xl items-center justify-center px-6 py-16"><Card className="w-full max-w-md"><CardHeader><p className="font-mono text-xs tracking-[.16em] text-[#b45309]">SENTINEL</p><CardTitle className="mt-2 text-2xl">Welcome back</CardTitle><CardDescription>Connect your GitHub account to start monitoring your repositories.</CardDescription></CardHeader><CardContent><SignInWithGitHubButton /></CardContent></Card></section></main>;
}
