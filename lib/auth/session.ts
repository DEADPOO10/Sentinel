import { redirect } from "next/navigation";
import { cache } from "react";
import { auth } from "@/auth";

export const getCurrentUser = cache(async () => {
  const session = await auth();
  return session?.user ?? null;
});

export async function requireUser() {
  const user = await getCurrentUser();

  if (!user?.id) redirect("/login");

  return user;
}
