"""Modal HTTP boundary for Sentinel validation. Deploy separately from Next.js."""

from __future__ import annotations

import json
import logging
import os
import time
import urllib.error
import urllib.request
from typing import Any

import modal
from fastapi import Request

from worker.core import CHECK_NAMES, MAX_ARCHIVE_COMPRESSED_BYTES, MAX_COMMAND_OUTPUT_BYTES, MAX_REQUEST_BYTES, POLICY, ValidationError, canonical_json, inspect_github_zip, parse_and_validate_job, request_auth_failure_reason, result_for_error, sign

APP_NAME = "sentinel-validation-worker"
SECRET_NAME = "sentinel-validation-worker"
WORKER_IMAGE = (
    # The HTTP function imports FastAPI, so its base must provide the `python`
    # executable that Modal's pip layer uses. Keep Node out of this trusted
    # outer worker: repository commands only ever run in SANDBOX_IMAGE.
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("fastapi[standard]")
    .run_commands(
        "useradd --create-home --uid 10001 --shell /usr/sbin/nologin sentinel",
        "mkdir -p /work /opt/sentinel && chown -R sentinel:sentinel /work /opt/sentinel",
    )
    .add_local_dir("worker", remote_path="/opt/sentinel/worker", copy=True)
    .env({"PYTHONPATH": "/opt/sentinel"})
    .run_commands("chown -R sentinel:sentinel /opt/sentinel")
    .run_commands("test \"$(id -u sentinel)\" = 10001")
)

# This image is intentionally separate from the trusted HTTP worker. It has
# Node and package-manager support for the fixed validation argv allowlist,
# plus only the system Python interpreter needed to run sandbox_agent.py. It
# does not include FastAPI or receive the outer worker's secrets.
SANDBOX_IMAGE = (
    modal.Image.from_registry("node:22.14.0-bookworm-slim")
    .apt_install("python3")
    .run_commands(
        "useradd --create-home --uid 10001 --shell /usr/sbin/nologin sentinel",
        "corepack enable",
        "mkdir -p /work /opt/sentinel && chown -R sentinel:sentinel /work /opt/sentinel",
    )
    .add_local_file("worker/sandbox_agent.py", remote_path="/opt/sentinel/worker/sandbox_agent.py", copy=True)
    .run_commands("chown -R sentinel:sentinel /opt/sentinel")
    .run_commands("test \"$(id -u sentinel)\" = 10001")
)
app = modal.App(APP_NAME)
logger = logging.getLogger("sentinel.validation_worker")


def create_api():
    from fastapi import FastAPI
    from fastapi.responses import Response

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    @api.post("/v1/validations")
    async def validate(request: Request) -> Response:
        raw = await request.body()
        secret = os.environ.get("SENTINEL_VALIDATION_WORKER_SHARED_SECRET", "")
        job: dict[str, Any] | None = None
        if not secret or len(secret) < 32:
            return signed_error(secret, job, "Worker configuration is incomplete.", "worker_not_configured", 503)
        if len(raw) > MAX_REQUEST_BYTES:
            log_request_auth_failure("request_too_large")
            return signed_error(secret, job, "Worker request could not be authenticated.", "invalid_request_authentication", 401)
        auth_failure = request_auth_failure_reason(secret, raw, request.headers.get("x-sentinel-request-signature"), request.headers.get("x-sentinel-request-timestamp"))
        if auth_failure:
            log_request_auth_failure(auth_failure)
            return signed_error(secret, job, "Worker request could not be authenticated.", "invalid_request_authentication", 401)
        try:
            job = parse_and_validate_job(json.loads(raw))
        except (ValidationError, json.JSONDecodeError) as error:
            return signed_error(secret, job, "The validation job could not be safely prepared.", getattr(error, "args", ["invalid_job"])[0], 422)
        try:
            return signed_json(secret, execute_job(job), 200)
        except ValidationError as error:
            return signed_json(secret, result_for_error(job, "The isolated validation worker could not safely complete this validation.", error.args[0]), 200)
        except Exception:
            return signed_json(secret, result_for_error(job, "The isolated validation worker could not complete this validation.", "worker_failure"), 200)

    return api


@app.function(image=WORKER_IMAGE, secrets=[modal.Secret.from_name(SECRET_NAME)], timeout=300, cpu=(1.0, 1.0), memory=(2048, 2048), max_containers=2)
@modal.asgi_app()
def web():
    return create_api()


def execute_job(job: dict[str, Any]) -> dict[str, Any]:
    archive = fetch_verified_archive(job)
    inspect_github_zip(archive)
    sandbox = None
    started = time.monotonic()
    try:
        sandbox = create_sandbox(job)
        sandbox.filesystem.write_bytes(archive, "/tmp/source.zip")
        sandbox.filesystem.write_bytes(canonical_json(job), "/tmp/job.json")
        prepare = sandbox.exec("/usr/bin/python3", "/opt/sentinel/worker/sandbox_agent.py", "/tmp/source.zip", "/tmp/job.json", timeout=30, workdir="/work")
        if prepare.wait() != 0:
            raise ValidationError("patch_binding_failed")
        manager = determine_package_manager(sandbox)
        install = run_command(sandbox, install_argv(manager), 90)
        if install["status"] != "passed":
            return completed_result(job, "failed", {"status": "failed", "summary": install["summary"]}, skipped_checks("Not run because dependency installation failed."), ["dependency_install_failed"], [])
        # This method is deliberately required: it replaces the initial registry
        # allowlist with no egress before any repository-defined npm script runs.
        sandbox._experimental_set_outbound_network_policy(outbound_domain_allowlist=[], outbound_cidr_allowlist=[])
        checks = []
        for name in CHECK_NAMES:
            if time.monotonic() - started >= 300:
                checks.extend(skipped_checks("Not run because the total job deadline was reached.", names=CHECK_NAMES[len(checks) :]))
                return completed_result(job, "partial", {"status": "passed", "summary": "Installed with scripts disabled."}, checks, ["total_deadline_reached"], ["skipped_checks"])
            if not has_package_script(sandbox, name):
                checks.append({"name": name, "status": "skipped", "durationMs": 0, "summary": "No package script is defined."})
                continue
            checks.append(run_command(sandbox, [manager, "run", name, "--if-present"], 90, name=name))
            if checks[-1]["status"] in {"failed", "timed_out"}:
                checks.extend(skipped_checks("Not run after a failed check.", names=CHECK_NAMES[len(checks) :]))
                return completed_result(job, "failed", {"status": "passed", "summary": "Installed with scripts disabled."}, checks, ["validation_check_failed"], [])
        skipped = any(check["status"] == "skipped" for check in checks)
        return completed_result(job, "partial" if skipped else "passed", {"status": "passed", "summary": "Installed with scripts disabled."}, checks, ["one_or_more_allowlisted_checks_not_defined"] if skipped else [], ["skipped_checks"] if skipped else [])
    finally:
        if sandbox is not None:
            sandbox.terminate(wait=True)
            sandbox.detach()


def create_sandbox(job: dict[str, Any]):
    # No Modal Secret or inherited environment is attached to this Sandbox.
    # The initial TLS-only egress allowlist is removed before checks execute.
    return modal.Sandbox.create(
        "sleep", "300", app=app, image=SANDBOX_IMAGE, timeout=300, idle_timeout=300,
        cpu=(1.0, 1.0), memory=(2048, 2048), workdir="/work/repo", secrets=[],
        outbound_domain_allowlist=["registry.npmjs.org", "registry.yarnpkg.com"], outbound_cidr_allowlist=[],
        env={"HOME": "/tmp", "npm_config_ignore_scripts": "true", "npm_config_audit": "false", "npm_config_fund": "false"},
    )


def fetch_verified_archive(job: dict[str, Any]) -> bytes:
    token = os.environ.get("SENTINEL_GITHUB_READ_TOKEN")
    if not token:
        raise ValidationError("github_identity_missing")
    repo = job["repository"]
    base = f"https://api.github.com/repos/{repo['owner']}/{repo['name']}"
    commit = github_json(f"{base}/commits/{repo['commitSha']}", token)
    if not isinstance(commit, dict) or str(commit.get("sha", "")).lower() != repo["commitSha"].lower():
        raise ValidationError("commit_binding_failed")
    return github_bytes(f"{base}/zipball/{repo['commitSha']}", token)


def github_json(url: str, token: str) -> Any:
    return json.loads(github_bytes(url, token, maximum=512 * 1024))


def github_bytes(url: str, token: str, maximum: int = MAX_ARCHIVE_COMPRESSED_BYTES) -> bytes:
    request = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "Authorization": f"Bearer {token}", "User-Agent": "sentinel-validation-worker"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            if response.status != 200:
                raise ValidationError("github_fetch_failed")
            length = response.headers.get("Content-Length")
            if length and int(length) > maximum:
                raise ValidationError("github_response_too_large")
            chunks, total = [], 0
            while chunk := response.read(64 * 1024):
                total += len(chunk)
                if total > maximum:
                    raise ValidationError("github_response_too_large")
                chunks.append(chunk)
            return b"".join(chunks)
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as error:
        raise ValidationError("github_fetch_failed") from error


def determine_package_manager(sandbox) -> str:
    # Lockfile selection is fixed and does not inspect or execute package scripts.
    files = {entry.path.rsplit("/", 1)[-1] for entry in sandbox.filesystem.list_files("/work/repo")}
    if "package-lock.json" in files:
        return "npm"
    if "pnpm-lock.yaml" in files:
        return "pnpm"
    if "yarn.lock" in files:
        return "yarn"
    raise ValidationError("no_lockfile")


def install_argv(manager: str) -> list[str]:
    return {"npm": ["npm", "ci", "--ignore-scripts", "--no-audit", "--fund=false"], "pnpm": ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], "yarn": ["yarn", "install", "--immutable", "--ignore-scripts"]}[manager]


def run_command(sandbox, argv: list[str], timeout_seconds: int, *, name: str | None = None) -> dict[str, Any]:
    started = time.monotonic()
    process = sandbox.exec(*argv, timeout=timeout_seconds, workdir="/work/repo", env={"HOME": "/tmp", "npm_config_ignore_scripts": "true", "npm_config_audit": "false", "npm_config_fund": "false"}, pty=True)
    try:
        output = read_bounded_output(process, sandbox)
        exit_code = process.wait()
    except Exception:
        output = "Command did not complete before its execution limit."
        exit_code = 1
    duration = min(int((time.monotonic() - started) * 1000), 90000)
    summary = output or ("Completed." if exit_code == 0 else "Command failed without output.")
    if name is None:
        return {"status": "passed" if exit_code == 0 else "failed", "summary": summary}
    status = "passed" if exit_code == 0 else ("timed_out" if duration >= 89_000 else "failed")
    return {"name": name, "status": status, "durationMs": duration, "summary": summary}


def read_bounded_output(process, sandbox) -> str:
    fragments: list[str] = []
    size = 0
    # PTY mode intentionally multiplexes stdout and stderr into one stream,
    # avoiding a blocked process on an unread stderr pipe.
    for line in process.stdout:
        encoded = line.encode("utf-8", "replace")
        if size + len(encoded) > MAX_COMMAND_OUTPUT_BYTES:
            sandbox.terminate(wait=False)
            return "Command output exceeded the 24 KiB limit."
        fragments.append(line)
        size += len(encoded)
    return "".join(fragments).strip()[:1000] or "Completed without output."


def has_package_script(sandbox, name: str) -> bool:
    try:
        package = json.loads(sandbox.filesystem.read_text("/work/repo/package.json"))
    except (OSError, ValueError, json.JSONDecodeError):
        return False
    return isinstance(package, dict) and isinstance(package.get("scripts"), dict) and isinstance(package["scripts"].get(name), str)


def skipped_checks(summary: str, *, names=CHECK_NAMES) -> list[dict[str, Any]]:
    return [{"name": name, "status": "skipped", "durationMs": 0, "summary": summary} for name in names]


def completed_result(job: dict[str, Any], overall: str, install: dict[str, str], checks: list[dict[str, Any]], warnings: list[str], partial: list[str]) -> dict[str, Any]:
    return {"version": 1, "jobId": job["jobId"], "repository": {"commitSha": job["repository"]["commitSha"]}, "overallStatus": overall, "install": install, "checks": checks, "warnings": warnings[:12], "partialReasons": partial}


def signed_json(secret: str, payload: dict[str, Any], status: int):
    from fastapi.responses import Response
    body = canonical_json(payload)
    return Response(content=body, status_code=status, media_type="application/json", headers={"x-sentinel-worker-signature": sign(secret, body), "cache-control": "no-store"})


def signed_error(secret: str, job: dict[str, Any] | None, summary: str, warning: str, status: int):
    return signed_json(secret, result_for_error(job, summary, warning), status)


def log_request_auth_failure(reason: str) -> None:
    # Reasons are fixed labels only: never log credentials, signatures, or body data.
    logger.warning("validation request authentication rejected: reason=%s", reason)
