# Production Validation Worker

Sentinel's web application does not execute customer repository code. Production validation remains disabled until a separately deployed worker is configured.

## Required isolation boundary

Deploy the worker as a short-lived container job service (for example, a managed container-job platform) outside Vercel. Do not run Docker in Vercel and do not mount the web-app filesystem, environment, service account, or database into the worker.

For every job, the worker must enforce the policy sent in `lib/validation/worker-contract.ts`:

- an ephemeral workspace and non-root UID; no privileged container, host mounts, Docker socket, or writable root filesystem;
- 1 vCPU, 2 GiB memory, five-minute total deadline, 90-second command deadline, and 24 KiB output cap per command;
- bounded archive download/extraction; reject absolute paths, `..`, symlinks, and over-size archives before writing files;
- package-manager argv allowlists only: never use a shell or accept arbitrary repository commands;
- dependency-install scripts disabled; registry-only network during installation, then network disabled for typecheck, lint, test, and build;
- workspace and any package cache destroyed after the job, including failed or timed-out jobs.

Repositories requiring a package source outside the two allowlisted registries (for example a Git URL) must return `UNABLE_TO_VALIDATE` until that source has been explicitly reviewed and added to the worker policy.

The worker needs its **own** narrowly scoped GitHub App installation identity, restricted to the repositories it validates and read-only contents access. Sentinel sends repository owner/name, immutable commit SHA, dependency type, proposal, and policy only. It never sends a GitHub OAuth token, database credentials, OpenAI keys, Auth.js secrets, or any Sentinel application secret.

## HTTP provider contract

The provider-neutral app adapter uses `POST /v1/validations`. It signs the exact JSON body with HMAC-SHA256 (`base64url`) in `x-sentinel-request-signature`, along with `x-sentinel-request-timestamp`. The worker must reject stale timestamps and invalid signatures. It returns the `ValidationWorkerResult` shape and signs the exact response body in `x-sentinel-worker-signature`. Sentinel verifies that signature, job ID, commit SHA, bounded response size, and every status field before it persists or issues a validation ticket.

The endpoint must be HTTPS and exactly `/v1/validations`. A provider can queue internally but must return the finished structured result within the configured request lifetime; Sentinel intentionally has no validation-job database table yet. If a long-running asynchronous design is needed, stop and add durable job persistence first rather than pretending a serverless request is reliable.

## Manual configuration (not enabled by this change)

After the worker and its GitHub App are independently deployed and audited, set these values in the hosting provider's production environment configuration:

```text
SENTINEL_VALIDATION_ENABLED=true
SENTINEL_VALIDATION_PROVIDER=http
SENTINEL_VALIDATION_WORKER_URL=https://your-worker.example/v1/validations
SENTINEL_VALIDATION_WORKER_SHARED_SECRET=<new random value, at least 32 characters>
```

Do not add these values to `.env` or `.env.local` in this repository. Keep `SENTINEL_PR_CREATION_ENABLED` unset or `false`: validation does not enable draft PR creation. Draft PRs remain human-triggered and are never auto-merged.
