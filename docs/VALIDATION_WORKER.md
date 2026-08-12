# Production Validation Worker

Sentinel's web application does not execute customer repository code. Production validation remains disabled until a separately deployed worker is configured.

## Required isolation boundary

Deploy the worker as a short-lived container job service (for example, a managed container-job platform) outside Vercel. Do not run Docker in Vercel and do not mount the web-app filesystem, environment, service account, or database into the worker.

This repository includes a Modal implementation at `worker/modal_app.py`. It is a separately deployed Python application; it is not imported by the Next.js application and does not use Vercel configuration.

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

The endpoint must be HTTPS and exactly `/v1/validations`. A provider can queue internally but must return the finished structured result within the configured request lifetime; Sentinel intentionally has no validation-job database table yet. The Sentinel HTTP caller and the repository page Server Action are configured for the same five-minute worker budget. The deployed Vercel plan must support a 300-second Node.js function duration. If a long-running asynchronous design is needed, stop and add durable job persistence first rather than pretending a serverless request is reliable.

## Modal worker implementation

The Modal worker verifies the raw HMAC-signed request before parsing it, rejects timestamps outside five minutes, requires the policy to exactly equal the versioned policy in this repository, verifies that GitHub resolves the requested immutable SHA, and signs the exact compact JSON response body.

For each accepted job it downloads a bounded GitHub archive in the outer worker, rejects unsafe ZIP entries (including symlinks, traversal, absolute paths, encrypted entries, multiple roots, and size-limit violations), then passes only the checked archive and signed job data to a fresh Sandbox. The Sandbox receives no Modal Secret and no GitHub credential. It uses the `sentinel` UID (10001), has no mounts, no privileged mode, a five-minute lifetime, a hard 1 vCPU / 2 GiB cap, and a new writable `/work` directory that is terminated at the end of every request.

The Sandbox begins with TLS-only access to `registry.npmjs.org` and `registry.yarnpkg.com`; installs use `--ignore-scripts`; then the worker removes all egress before it executes the fixed `typecheck`, `lint`, `test`, and `build` npm/pnpm/yarn argv allowlist. It never uses a shell to run repository commands. Command output is capped at 24 KiB and response output at 64 KiB.

Modal's egress transition uses its current experimental Sandbox API. Do not deploy with a Modal client that lacks `Sandbox._experimental_set_outbound_network_policy`: that would leave checks with package-registry egress, which violates Sentinel policy. The authenticated CLI currently installed on this machine is `1.2.6` and does not expose that API, so this change deliberately does not deploy or even create a remote test app.

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
