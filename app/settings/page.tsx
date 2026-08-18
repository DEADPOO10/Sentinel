import {
  AtSign,
  Github,
  Mail,
  ShieldCheck,
} from "lucide-react";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { SiteNavigation } from "@/components/site-navigation";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default async function SettingsPage() {
  const user = await requireUser();
  const displayName = user.name ?? user.username ?? "GitHub user";
  const userInitial = displayName.trim().charAt(0).toUpperCase() || "S";

  return (
    <main className="sentinel-page">
      <SiteNavigation />

      <section className="mx-auto max-w-6xl px-6 py-10 lg:px-8 lg:py-14">
        <header className="relative overflow-hidden border border-[#d5d6ce] bg-[#f9f9f5]">
          <div className="h-1 w-full bg-[#d8ff42]" />
          <div className="flex flex-col justify-between gap-7 px-6 py-8 sm:px-8 lg:flex-row lg:items-end lg:px-10 lg:py-10">
            <div className="max-w-3xl">
              <div className="mb-5 flex items-center gap-2">
                <span className="grid h-8 w-8 place-items-center border border-[#171817] bg-[#d8ff42] text-[#171817] dark:!border-[#252a30] dark:!bg-[#111417] dark:!text-[#d8ff42]">
                  <ShieldCheck className="h-4 w-4" />
                </span>
                <p className="eyebrow">SENTINEL / WORKSPACE SETTINGS</p>
              </div>
              <h1 className="editorial-title text-4xl text-[#171817] sm:text-5xl lg:text-6xl">
                Account and access.
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-6 text-[#696b66] sm:text-base">
                Review the identity and GitHub connection associated with your
                Sentinel maintenance workspace.
              </p>
            </div>
            <Badge variant="info" className="self-start px-3 py-1.5 lg:self-auto">
              Authenticated workspace
            </Badge>
          </div>
        </header>

        <section className="mt-10" aria-labelledby="account-profile-title">
          <div className="mb-4">
            <p className="eyebrow">PROFILE</p>
            <h2
              id="account-profile-title"
              className="mt-2 text-2xl font-medium tracking-[-.04em] text-[#171817]"
            >
              Account identity
            </h2>
            <p className="mt-2 text-sm text-[#696b66]">
              Identity details supplied by your authenticated GitHub session.
            </p>
          </div>

          <Card className="overflow-hidden">
            <div className="grid lg:grid-cols-[1fr_22rem]">
              <CardHeader className="flex-row items-center gap-5 p-6 sm:p-8">
                <span className="grid h-16 w-16 shrink-0 place-items-center border border-[#171817] bg-[#d8ff42] text-2xl font-medium tracking-[-.04em] text-[#171817] dark:!border-[#d8ff42] dark:!bg-[#111417] dark:!text-[#d8ff42]">
                  {userInitial}
                </span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="truncate text-2xl">
                      {displayName}
                    </CardTitle>
                    <Badge variant="brand">Active</Badge>
                  </div>
                  <CardDescription className="mt-2">
                    {user.username
                      ? `@${user.username}`
                      : "GitHub workspace member"}
                  </CardDescription>
                </div>
              </CardHeader>

              <div className="border-t border-[#d5d6ce] bg-[#f5f5ef] lg:border-l lg:border-t-0">
                <AccountDetail
                  icon={<AtSign />}
                  label="GitHub handle"
                  value={user.username ? `@${user.username}` : "Not provided"}
                />
                <AccountDetail
                  icon={<Mail />}
                  label="Account email"
                  value={user.email ?? "Not provided by GitHub"}
                />
              </div>
            </div>
          </Card>
        </section>

        <section className="mt-10" aria-labelledby="connections-title">
          <div className="mb-4">
            <p className="eyebrow">CONNECTIONS & CONTROL</p>
            <h2
              id="connections-title"
              className="mt-2 text-2xl font-medium tracking-[-.04em] text-[#171817]"
            >
              Workspace configuration
            </h2>
            <p className="mt-2 text-sm text-[#696b66]">
              Current access and review boundaries for this workspace.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="border-t-4 border-t-[#d8ff42]">
              <CardHeader className="p-6 sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <span className="grid h-10 w-10 place-items-center border border-[#171817] bg-[#171817] text-[#f5f5ef]">
                    <Github className="h-5 w-5" />
                  </span>
                  <Badge variant="brand">
                    <span
                      className="h-1.5 w-1.5 bg-[#237a53] dark:bg-[#d8ff42]"
                      aria-hidden="true"
                    />
                    Connected
                  </Badge>
                </div>
                <CardTitle className="mt-6">GitHub connection</CardTitle>
                <CardDescription className="mt-2">
                  {user.username
                    ? `Connected as @${user.username}`
                    : user.email ?? "Your GitHub account is connected."}
                </CardDescription>
              </CardHeader>
              <CardContent className="px-6 pb-6 sm:px-7 sm:pb-7">
                <p className="border-t border-[#d5d6ce] pt-5 text-sm leading-6 text-[#696b66]">
                  GitHub provides authentication and the repository access
                  Sentinel uses for your selected maintenance workspaces.
                </p>
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-[#171817]">
              <CardHeader className="p-6 sm:p-7">
                <div className="flex items-start justify-between gap-4">
                  <span className="grid h-10 w-10 place-items-center border border-[#d5d6ce] bg-[#f5f5ef] text-[#171817]">
                    <ShieldCheck className="h-5 w-5" />
                  </span>
                  <Badge variant="info">Review required</Badge>
                </div>
                <CardTitle className="mt-6">Security and control</CardTitle>
                <CardDescription className="mt-2">
                  Your session is authenticated through Auth.js.
                </CardDescription>
              </CardHeader>
              <CardContent className="px-6 pb-6 sm:px-7 sm:pb-7">
                <p className="border-t border-[#d5d6ce] pt-5 text-sm leading-6 text-[#696b66]">
                  Sentinel maintains the existing human review and approval
                  boundaries for repository maintenance changes.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>
      </section>
    </main>
  );
}

function AccountDetail({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b border-[#d5d6ce] px-5 py-4 last:border-b-0">
      <span className="mt-0.5 text-[#696b66] [&_svg]:h-4 [&_svg]:w-4">
        {icon}
      </span>
      <div className="min-w-0">
        <p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#8a8d86]">
          {label}
        </p>
        <p className="mt-1 truncate text-sm font-medium text-[#343633]" title={value}>
          {value}
        </p>
      </div>
    </div>
  );
}
