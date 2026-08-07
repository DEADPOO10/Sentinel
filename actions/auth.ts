"use server";

import { signIn, signOut } from "@/auth";

function safeCallbackUrl(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//") ? value : "/dashboard";
}

export async function signInWithGitHub(formData: FormData) {
  await signIn("github", { redirectTo: safeCallbackUrl(formData.get("callbackUrl")) });
}

export async function signOutUser() {
  await signOut({ redirectTo: "/" });
}
