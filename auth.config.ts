import type { NextAuthConfig } from "next-auth";
import GitHub from "next-auth/providers/github";
import { isProtectedRoute } from "@/lib/auth/routes";

export const authConfig = {
  pages: {
    signIn: "/login",
  },
  providers: [
    GitHub({
      authorization: {
        params: {
          scope: "read:user user:email",
        },
      },
    }),
  ],
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isSignedIn = Boolean(auth?.user);

      if (isProtectedRoute(nextUrl.pathname)) return isSignedIn;

      if (isSignedIn && (nextUrl.pathname === "/" || nextUrl.pathname === "/login")) {
        return Response.redirect(new URL("/dashboard", nextUrl));
      }

      return true;
    },
  },
} satisfies NextAuthConfig;
