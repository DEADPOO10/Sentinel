# Sentinel deployment readiness

This checklist prepares the current private-beta application for deployment. It does not deploy Sentinel, create external accounts, or apply database migrations.

## Production environment contract

Set these names in the production deployment environment. Keep every value server-only; Sentinel does not use `NEXT_PUBLIC_*` variables for secrets.

| Category | Variable | Purpose |
| --- | --- | --- |
| Required secret | `AUTH_SECRET` | Signs Auth.js JWTs and Sentinel's signed workflow tickets. |
| Required secret | `AUTH_GITHUB_ID` | GitHub OAuth client ID. |
| Required secret | `AUTH_GITHUB_SECRET` | GitHub OAuth client secret. |
| Required secret | `OPENAI_API_KEY` | User-triggered Impact Analysis and Proposed Fix requests. |
| Required configuration | `AUTH_URL` | Sentinel's single canonical HTTPS production origin. |
| Required configuration | `DATABASE_URL` | Neon **pooled** PostgreSQL connection string. |
| Optional flag | `SENTINEL_PR_CREATION_ENABLED` | Enables the explicit draft-PR action only when exactly `true`. |
| Local-only flag | `SENTINEL_VALIDATION_ENABLED` | Enables repository command validation in local development only. |

`NODE_ENV` is platform-managed. Do not set `SENTINEL_VALIDATION_ENABLED` to enable validation on production: the application deliberately blocks host-level repository command execution whenever `NODE_ENV` is `production`.

## Auth.js and GitHub OAuth

Before production login can work, choose the canonical HTTPS domain and configure it as `AUTH_URL`. Then update the GitHub OAuth App's Authorization callback URL to:

```
https://<your-production-domain>/api/auth/callback/github
```

Do not use a preview URL as the canonical callback URL. The existing OAuth scope remains `read:user user:email repo`; the `repo` scope is required for the private repositories and explicit draft-PR workflow Sentinel already supports. GitHub tokens are retained in the encrypted Auth.js JWT and read only in server-side code.

## Neon and Prisma

Use a Neon pooled endpoint for `DATABASE_URL` (the pooler hostname). Sentinel creates one reused Prisma client per runtime instance with a bounded `pg` pool of five connections, a 5-second connection timeout, and strict TLS normalization equivalent to `sslmode=verify-full`.

Do not run migrations during application startup. After setting the production environment and before taking beta traffic, run this from an authorized deployment or CI environment:

```
npx prisma migrate deploy
```

Then confirm schema state with:

```
npx prisma migrate status
```

No public database-health endpoint is exposed. Database health is used only by server-side helpers.

## Runtime and duration choices

The repository-detail route explicitly uses the Node.js runtime and has a 90-second maximum duration. This covers the bounded live repository scan and the user-triggered Server Actions used on that page:

- npm dependency intelligence and release evidence,
- AI Impact Analysis and Proposed Fix generation,
- explicit GitHub draft-PR preparation.

Each outbound OpenAI/GitHub/npm request also has its own bounded timeout. The 90-second route setting is intentionally not applied globally.

The temporary validation implementation uses Node filesystem and child-process APIs. It uses an ephemeral system temporary directory and cleans it after each request, but a temporary directory is not a security sandbox.

## Validation safety decision

Sentinel must not execute untrusted repository scripts inside a production Vercel function. Therefore production validation is disabled in this release, even when a feature flag is mistakenly set. Local development can still opt in with `SENTINEL_VALIDATION_ENABLED=true` while using `next dev`.

Before enabling validation in production, replace host execution with a dedicated isolated worker/container service that has no application secrets, restricted network access, per-job resource limits, and a narrowly scoped handoff protocol. That work is intentionally out of scope for this milestone.

## Draft PR guard

Draft PR creation remains off unless `SENTINEL_PR_CREATION_ENABLED=true` is deliberately configured. It requires the signed analysis/proposal/completed-validation workflow and accepts only PASSED validation or an explicitly safe PARTIAL result caused by missing optional checks. FAILED, UNABLE_TO_VALIDATE, timed-out, and cleanup-uncertain results are ineligible. Sentinel revalidates repository write access and the exact default-branch commit immediately before creating a branch and again before creating the PR.

V1 constructs one exact `package.json` dependency-range edit from server-revalidated fields. AI-proposed source-file edits are never committed. For a root `package-lock.json`, the same isolated validation may return one HMAC-authenticated artifact capped at 2 MiB. Sentinel verifies its base64, byte length, SHA-256, UTF-8 JSON, lockfile version, root metadata, and target dependency range, then stores the exact bytes on the corresponding `ValidationRun`. The browser and signed PR ticket never contain the lockfile; the ticket carries only the validation-run ID.

The only authorized PR file sets are `package.json`, or `package.json` plus that exact persisted `package-lock.json`. Missing, oversized, mismatched, differently bound, or unverifiable artifacts fail closed. `npm-shrinkwrap.json`, pnpm, Yarn, and Bun remain unsupported. Eligible no-lockfile repositories use `sentinel/deps/<sanitized-dependency>/<proposal-id>` and always create a GitHub Draft. Sentinel never writes the default branch, marks a PR ready for review, auto-merges, or runs PR creation in the background.

PR request deduplication in memory is only an optimization. Cross-instance duplicate prevention uses a deterministic branch name derived from the signed proposal identity, GitHub's unique branch reference constraint, and the PR change marker lookup. If another instance already reserved the proposal's branch, Sentinel safely asks the user to refresh rather than creating a second PR.

## Vercel preparation and smoke test

When deployment is approved:

1. Create/link the Vercel project and choose the canonical HTTPS domain.
2. Add the required production environment-variable names above, using the Neon pooled connection string.
3. Configure the GitHub OAuth callback URL for that domain.
4. Run `npx prisma migrate deploy` once in an authorized environment.
5. Keep `SENTINEL_VALIDATION_ENABLED` unset and keep `SENTINEL_PR_CREATION_ENABLED` unset for the initial beta rollout.
6. Deploy, then verify sign-in, repository listing, one dependency scan, dashboard history, and one user-triggered AI analysis.
7. For the npm artifact rollout, apply the backward-compatible Prisma migration first, deploy Vercel's optional-artifact consumer second, and deploy the Modal artifact producer third. Cloudflare requires no code change.
8. Keep `SENTINEL_PR_CREATION_ENABLED` disabled while confirming one production validation persists a verified npm lockfile artifact.
9. Only after the write workflow and persisted artifact are reviewed, deliberately enable `SENTINEL_PR_CREATION_ENABLED=true` for one controlled draft PR in a non-critical repository, then disable it again.
10. Rotate OAuth, OpenAI, database, and Auth.js secrets on the established incident/rotation schedule; revoke and replace immediately if any secret is suspected to be exposed.

Remaining deployment blockers: a canonical production domain, corresponding GitHub OAuth callback configuration, production environment values, an authorized migration run, and a production-safe isolated validation worker if repository command validation is required in the beta.
