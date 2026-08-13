# Production Validation Worker

Sentinel's web application does not execute customer repository code. Production validation remains disabled until a separately deployed worker is configured.

## Required isolation boundary

Deploy the worker as a short-lived container job service (for example, a managed container-job platform) outside Vercel. Do not run Docker in Vercel and do not mount the web-app filesystem, environment, service account, or database into the worker.

This repository includes a Modal implementation at `worker/modal_app.py`. It is a separately deployed Python application; it is not imported by the Next.js application and does not use Vercel configuration.

For every job, the worker must enforce the policy sent in `lib/validation/worker-contract.ts`:

- an ephemeral workspace and non-root UID; no privileged container, host mounts, Docker socket, or writable root filesystem;
- 1 vCPU, 2 GiB memory, a five-minute total deadline, and a 24 KiB output cap per command. The worker reserves 20 seconds for cleanup/signing and bounds commands by the remaining shared budget: typecheck 45 seconds, lint 60 seconds, tests 120 seconds, and build 75 seconds;
- bounded archive download/extraction; reject absolute paths, `..`, symlinks, and over-size archives before writing files;
- package-manager argv allowlists only: never use a shell or accept arbitrary repository commands;
- dependency-install scripts disabled; registry-only network during installation, then network disabled for typecheck, lint, test, and build;
- workspace and any package cache destroyed after the job, including failed or timed-out jobs.

Repositories requiring a package source outside the two allowlisted registries (for example a Git URL) must return `UNABLE_TO_VALIDATE` until that source has been explicitly reviewed and added to the worker policy.

The worker needs its **own** narrowly scoped GitHub App installation identity, restricted to the repositories it validates and read-only contents access. Sentinel sends repository owner/name, immutable commit SHA, dependency type, proposal, and policy only. It never sends a GitHub OAuth token, database credentials, OpenAI keys, Auth.js secrets, or any Sentinel application secret.

## HTTP provider contract

The provider-neutral app adapter uses `POST /v1/validations`. It signs the exact JSON body with HMAC-SHA256 (`base64url`) in `x-sentinel-request-signature`, along with `x-sentinel-request-timestamp`. The worker must reject stale timestamps and invalid signatures. It returns the `ValidationWorkerResult` shape and signs the exact response body in `x-sentinel-worker-signature`. Sentinel verifies that signature first, followed by the result schema, optional artifact, job ID, commit SHA, and bounded response size before it persists or issues a validation ticket.

The endpoint must be HTTPS and exactly `/v1/validations`. A provider can queue internally but must return the finished structured result within the configured request lifetime; Sentinel intentionally has no validation-job database table yet. The Sentinel HTTP caller and the repository page Server Action are configured for the same five-minute worker budget. The deployed Vercel plan must support a 300-second Node.js function duration. If a long-running asynchronous design is needed, stop and add durable job persistence first rather than pretending a serverless request is reliable.

## Modal worker implementation

The Modal worker verifies the raw HMAC-signed request before parsing it, rejects timestamps outside five minutes, requires the policy to exactly equal the versioned policy in this repository, verifies that GitHub resolves the requested immutable SHA, and signs the exact compact JSON response body.

For each accepted job it downloads a bounded GitHub archive in the outer worker, rejects unsafe ZIP entries (including symlinks, traversal, absolute paths, encrypted entries, multiple roots, and size-limit violations), then passes only the checked archive and signed job data to a fresh Sandbox. The Sandbox receives no Modal Secret and no GitHub credential. It uses the `sentinel` UID (10001), has no mounts, no privileged mode, a five-minute lifetime, a hard 1 vCPU / 2 GiB cap, and a new writable `/work` directory that is terminated at the end of every request.

The Sandbox begins with TLS-only access to `registry.npmjs.org` and `registry.yarnpkg.com`; installs use `--ignore-scripts`; then the worker removes all egress before it executes the fixed `typecheck`, `lint`, `test`, and `build` npm/pnpm/yarn argv allowlist. It never uses a shell to run repository commands. Command output is capped at 24 KiB. The signed response is capped at 3 MiB so it can carry at most one bounded npm lockfile artifact.

### Authenticated npm lockfile artifact

The only generated artifact in contract version 1 is the root `package-lock.json`. The optional result field has the exact shape:

```json
{
  "kind": "npm_package_lock",
  "path": "package-lock.json",
  "encoding": "base64",
  "content": "<bounded exact bytes>",
  "byteLength": 123,
  "sha256": "<64 lowercase hexadecimal characters>"
}
```

The raw artifact limit is exactly 2 MiB (2,097,152 bytes); it is rejected rather than truncated. The worker emits it only after the original root npm lockfile was verified, the exact authorized `package.json` value was changed, `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` succeeded, the synchronized root lock metadata contains the target dependency range, and `npm ci --ignore-scripts --no-audit --no-fund` succeeded. It must be a non-empty regular file at exactly `/work/repo/package-lock.json`, valid UTF-8 JSON, and lockfile version 2 or 3.

Sentinel verifies the HMAC over the complete response before decoding the artifact. It then enforces the encoded and decoded limits, canonical base64, exact byte length, recomputed SHA-256, strict UTF-8, JSON structure, lockfile version, root package metadata, and the dependency section/target range. The exact verified bytes are persisted only on the corresponding `ValidationRun`; artifact contents are not sent to the browser or placed in a workflow ticket. The ticket contains only the validation-run ID, while the database relationship binds that run to the proposed fix and immutable base commit.

No arbitrary artifact path, source file, archive, public download URL, or Cloudflare storage is supported. `npm-shrinkwrap.json`, pnpm, Yarn, and Bun lockfiles remain fail-closed for Draft PR creation.

Modal's egress transition uses its current experimental Sandbox API. Do not deploy with a Modal client that lacks `Sandbox._experimental_set_outbound_network_policy`: that would leave checks with package-registry egress, which violates Sentinel policy. The worker tests and authenticated development profile currently target Modal SDK 1.5.x.

Modal does not presently expose a `readOnlyRootFilesystem` Sandbox parameter. The image runs the repository process as the unprivileged `sentinel` user and confines all worker writes to `/work`; this is the closest enforceable Modal configuration. Treat a platform-level read-only-root guarantee as a production-audit gate, not as a claim this implementation makes.

### Required Modal secret (manual setup only)

Create exactly one Modal secret named `sentinel-validation-worker`; attach it only to the outer `web` function. Do not attach it to a Sandbox or to any Next.js/Vercel deployment. Its required keys are:

```text
SENTINEL_VALIDATION_WORKER_SHARED_SECRET=<new random value, at least 32 characters>
SENTINEL_GITHUB_READ_TOKEN=<GitHub App installation token or fine-grained token with read-only Contents access, installed only on repositories Sentinel may validate>
```

Use a GitHub App installation token in production where possible. It must have read-only repository contents access and no administration, pull-request write, workflow write, or organization scopes. The worker does not need a GitHub token for public repositories only if the outer-fetch path is separately changed and audited; this implementation intentionally fails closed without one.

### Deployment procedure (manual; not performed by this change)

From the repository root, use a clean Python virtual environment and a Modal client recent enough to support dynamic Sandbox egress policy:

```bash
python3 -m venv .venv-modal
. .venv-modal/bin/activate
python -m pip install --upgrade -r worker/requirements.txt
python -m modal profile current
python -m modal secret create sentinel-validation-worker \
  SENTINEL_VALIDATION_WORKER_SHARED_SECRET='<placeholder-at-least-32-characters>' \
  SENTINEL_GITHUB_READ_TOKEN='<placeholder-read-only-GitHub-App-installation-token>'
python -m modal deploy worker/modal_app.py
```

After deployment, Modal displays a base HTTPS URL. The Sentinel endpoint is that base URL with `/v1/validations` appended. First perform an isolated staging request with a non-sensitive test repository and independently verify the response HMAC. Do not set Sentinel production variables, enable validation, or enable PR creation as part of deployment.

## Manual configuration (not enabled by this change)

After the worker and its GitHub App are independently deployed and audited, set these values in the hosting provider's production environment configuration:

```text
SENTINEL_VALIDATION_ENABLED=true
SENTINEL_VALIDATION_PROVIDER=http
SENTINEL_VALIDATION_WORKER_URL=https://your-worker.example/v1/validations
SENTINEL_VALIDATION_WORKER_SHARED_SECRET=<new random value, at least 32 characters>
```

Do not add these values to `.env` or `.env.local` in this repository. Keep `SENTINEL_PR_CREATION_ENABLED` unset or `false`: validation does not enable draft PR creation. Draft PRs remain human-triggered and are never auto-merged.

For this artifact contract, deploy in this order: apply the backward-compatible database migration, deploy the Vercel consumer/persistence changes, then deploy the Modal artifact producer. This lets the new application accept an artifact-absent response from the old worker during rollout and avoids sending a large new result to an old parser. Cloudflare remains a transparent credential-free proxy and does not require a code deployment. Keep Draft PR creation disabled throughout rollout; enable it only later for one separately approved controlled test.
