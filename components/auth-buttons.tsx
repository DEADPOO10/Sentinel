import { Github, LogOut } from "lucide-react";
import { signInWithGitHub, signOutUser } from "@/actions/auth";
import { Button } from "@/components/ui/button";

export function SignInWithGitHubButton({ callbackUrl = "/dashboard" }: { callbackUrl?: string }) {
  return <form action={signInWithGitHub}><input type="hidden" name="callbackUrl" value={callbackUrl} /><Button type="submit" className="w-full"><Github className="h-4 w-4" />Continue with GitHub</Button></form>;
}

export function SignOutButton() {
  return <form action={signOutUser}><Button type="submit" variant="ghost" size="sm"><LogOut className="h-4 w-4" />Logout</Button></form>;
}
