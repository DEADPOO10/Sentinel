import NextAuth from "next-auth";
import { authConfig } from "@/auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  session: {
    strategy: "jwt",
  },
  callbacks: {
    ...authConfig.callbacks,
    jwt({ token, profile, account }) {
      if (account?.provider === "github") {
        if (isGitHubProfile(profile)) {
          token.username = profile.login;
        }

        if (typeof account.access_token === "string") {
          token.githubAccessToken = account.access_token;
        }
      }

      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = token.sub ?? "";
        session.user.username = typeof token.username === "string" ? token.username : undefined;
      }

      return session;
    },
  },
});

function isGitHubProfile(profile: unknown): profile is { login: string } {
  return Boolean(
    profile &&
      typeof profile === "object" &&
      "login" in profile &&
      typeof profile.login === "string",
  );
}
