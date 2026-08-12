"""Modal HTTP boundary for Sentinel validation. Deploy separately from Next.js."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
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
    .apt_install("python3", "util-linux")
    .run_commands(
        "useradd --create-home --uid 10001 --shell /usr/sbin/nologin sentinel",
        "corepack enable",
        "mkdir -p /work/repo && chown -R sentinel:sentinel /work",
    )
    .run_commands("test \"$(id -u sentinel)\" = 10001")
    .run_commands(
        "test \"$(/usr/bin/setpriv --reuid=10001 --regid=10001 --clear-groups --no-new-privs -- /usr/bin/id -u)\" = 10001"
    )
)
app = modal.App(APP_NAME)
logger = logging.getLogger("sentinel.validation_worker")

TRUSTED_SANDBOX_AGENT_PATH = Path("/opt/sentinel/worker/sandbox_agent.py")
SANDBOX_AGENT_REMOTE_PATH = "/tmp/sentinel/sandbox_agent.py"
MAX_SANDBOX_AGENT_BYTES = 64 * 1024
SANDBOX_USER_PREFIX = (
    "/usr/bin/setpriv",
    "--reuid=10001",
    "--regid=10001",
    "--clear-groups",
    "--no-new-privs",
    "--",
)
SANDBOX_COMMAND_ENV = {
    "HOME": "/tmp",
    "npm_config_ignore_scripts": "true",
    "npm_config_audit": "false",
    "npm_config_fund": "false",
}
MAX_SAFE_SDK_REASON_CHARS = 240
ANSI_ESCAPE_RE = re.compile(
    r"\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[()#][0-2AB]|[@-_])"
)
MALFORMED_ANSI_ESCAPE_RE = re.compile(r"\ufffd\[[0-?]*[ -/]*[@-~]")

SAFE_SANDBOX_FAILURE_STAGES = frozenset(
    {
        "sandbox_create_failed",
        "sandbox_upload_failed",
        "sandbox_network_lockdown_failed",
        "sandbox_exec_failed",
        "sandbox_result_invalid",
        "sandbox_cleanup_failed",
    }
)


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
            return signed_json(secret, await execute_job(job), 200)
        except ValidationError as error:
            return signed_json(secret, result_for_error(job, "The isolated validation worker could not safely complete this validation.", error.args[0]), 200)
        except Exception:
            log_sandbox_failure("sandbox_result_invalid")
            return signed_json(secret, result_for_error(job, "The isolated validation worker could not complete this validation.", "worker_failure"), 200)

    return api


@app.function(image=WORKER_IMAGE, secrets=[modal.Secret.from_name(SECRET_NAME)], timeout=300, cpu=(1.0, 1.0), memory=(2048, 2048), max_containers=2)
@modal.asgi_app()
def web():
    return create_api()


async def execute_job(job: dict[str, Any]) -> dict[str, Any]:
    # urllib is only used for the trusted outer-worker GitHub fetch. Modal
    # operations below always use the SDK's native async .aio interface.
    archive = await asyncio.to_thread(fetch_verified_archive, job)
    await asyncio.to_thread(inspect_github_zip, archive)
    sandbox = None
    result: dict[str, Any] | None = None
    started = time.monotonic()
    try:
        sandbox = await create_sandbox(job)
        await upload_sandbox_inputs(sandbox, archive, job)
        await prepare_sandbox_workspace(sandbox)
        manager = await determine_package_manager(sandbox)
        lockfile_synchronized = False
        if manager == "npm" and job["proposedFix"]["packageJsonChange"]["required"]:
            await verify_npm_lockfile_binding(sandbox, job)
            lockfile_sync = await run_command(sandbox, npm_lockfile_sync_argv(), 90)
            if lockfile_sync["status"] != "passed":
                result = completed_result(
                    job,
                    "failed",
                    {"status": "failed", "summary": lockfile_sync["summary"]},
                    skipped_checks("Not run because package-lock synchronization failed."),
                    ["lockfile_update_failed"],
                    [],
                )
            else:
                # `npm install --package-lock-only` must not be allowed to
                # alter the authorized package.json edit while it resolves the
                # transitive graph. Recheck the exact server-authorized value.
                await verify_npm_lockfile_binding(sandbox, job)
                lockfile_synchronized = True
        if result is None:
            install = await run_command(sandbox, install_argv(manager), 90)
            if install["status"] != "passed":
                result = completed_result(job, "failed", {"status": "failed", "summary": install["summary"]}, skipped_checks("Not run because dependency installation failed."), ["dependency_install_failed"], [])
            else:
                await disable_sandbox_egress(sandbox)
                checks = []
                for name in CHECK_NAMES:
                    if time.monotonic() - started >= 300:
                        checks.extend(skipped_checks("Not run because the total job deadline was reached.", names=CHECK_NAMES[len(checks) :]))
                        result = completed_result(job, "partial", {"status": "passed", "summary": install_summary(lockfile_synchronized)}, checks, ["total_deadline_reached"], ["skipped_checks"])
                        break
                    if not await has_package_script(sandbox, name):
                        checks.append({"name": name, "status": "skipped", "durationMs": 0, "summary": "No package script is defined."})
                        continue
                    checks.append(await run_command(sandbox, [manager, "run", name, "--if-present"], 90, name=name))
                    if checks[-1]["status"] in {"failed", "timed_out"}:
                        checks.extend(skipped_checks("Not run after a failed check.", names=CHECK_NAMES[len(checks) :]))
                        result = completed_result(job, "failed", {"status": "passed", "summary": install_summary(lockfile_synchronized)}, checks, ["validation_check_failed"], [])
                        break
                if result is None:
                    skipped = any(check["status"] == "skipped" for check in checks)
                    warnings = ["package_lock_synchronized_in_sandbox"] if lockfile_synchronized else []
                    if skipped:
                        warnings.append("one_or_more_allowlisted_checks_not_defined")
                    result = completed_result(job, "partial" if skipped else "passed", {"status": "passed", "summary": install_summary(lockfile_synchronized)}, checks, warnings, ["skipped_checks"] if skipped else [])
    finally:
        if sandbox is not None:
            cleanup_succeeded = await cleanup_sandbox(sandbox)
            if result is not None and not cleanup_succeeded:
                mark_cleanup_unconfirmed(result)
    if result is None:
        log_sandbox_failure("sandbox_result_invalid")
        raise ValidationError("sandbox_result_invalid")
    return result


async def create_sandbox(job: dict[str, Any]):
    # No Modal Secret or inherited environment is attached to this Sandbox.
    # The initial TLS-only egress allowlist is removed before checks execute.
    try:
        return await modal.Sandbox.create.aio(
            *SANDBOX_USER_PREFIX, "/usr/bin/sleep", "300",
            app=app, image=SANDBOX_IMAGE, timeout=300, idle_timeout=300,
            cpu=(1.0, 1.0), memory=(2048, 2048), workdir="/work", secrets=[],
            outbound_domain_allowlist=["registry.npmjs.org", "registry.yarnpkg.com"], outbound_cidr_allowlist=[],
        )
    except Exception as error:
        log_sandbox_create_failure(error)
        raise ValidationError("sandbox_create_failed") from error


async def upload_sandbox_inputs(sandbox, archive: bytes, job: dict[str, Any]) -> None:
    try:
        await sandbox.filesystem.write_bytes.aio(archive, "/tmp/source.zip")
    except Exception as error:
        log_sandbox_upload_failure(error, "archive")
        raise ValidationError("sandbox_upload_failed") from error
    try:
        await sandbox.filesystem.write_bytes.aio(canonical_json(job), "/tmp/job.json")
    except Exception as error:
        log_sandbox_upload_failure(error, "job")
        raise ValidationError("sandbox_upload_failed") from error
    try:
        await sandbox.filesystem.copy_from_local.aio(
            trusted_sandbox_agent_path(), SANDBOX_AGENT_REMOTE_PATH
        )
    except Exception as error:
        log_sandbox_upload_failure(error, "trusted_agent")
        raise ValidationError("sandbox_upload_failed") from error


async def prepare_sandbox_workspace(sandbox) -> None:
    try:
        process = await sandbox.exec.aio(
            *SANDBOX_USER_PREFIX,
            "/usr/bin/python3",
            SANDBOX_AGENT_REMOTE_PATH,
            "/tmp/source.zip",
            "/tmp/job.json",
            timeout=30,
            workdir="/work",
        )
        await read_bounded_output(process)
        exit_code = await process.wait.aio()
    except Exception as error:
        log_sandbox_failure("sandbox_exec_failed")
        raise ValidationError("sandbox_exec_failed") from error
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        log_sandbox_failure("sandbox_result_invalid")
        raise ValidationError("sandbox_result_invalid")
    if exit_code == 3:
        # Exit code 3 is reserved by the trusted setup agent for a lockfile
        # that did not identify the unpacked root package before it changed
        # package.json. Do not continue with dependency resolution.
        raise ValidationError("lockfile_update_failed")
    if exit_code != 0:
        log_sandbox_failure("sandbox_exec_failed")
        raise ValidationError("patch_binding_failed")


async def disable_sandbox_egress(sandbox) -> None:
    # This method is deliberately required: it replaces the initial registry
    # allowlist with no egress before any repository-defined npm script runs.
    try:
        await sandbox._experimental_set_outbound_network_policy.aio(outbound_domain_allowlist=[], outbound_cidr_allowlist=[])
    except Exception as error:
        log_sandbox_failure("sandbox_network_lockdown_failed")
        raise ValidationError("sandbox_network_lockdown_failed") from error


async def cleanup_sandbox(sandbox) -> bool:
    cleanup_succeeded = True
    try:
        await sandbox.terminate.aio(wait=True)
    except Exception:
        cleanup_succeeded = False
        log_sandbox_failure("sandbox_cleanup_failed")
    finally:
        try:
            await sandbox.detach.aio()
        except Exception:
            cleanup_succeeded = False
            log_sandbox_failure("sandbox_cleanup_failed")
    return cleanup_succeeded


def mark_cleanup_unconfirmed(result: dict[str, Any]) -> None:
    if "sandbox_cleanup_failed" not in result["warnings"]:
        result["warnings"].append("sandbox_cleanup_failed")
    if "cleanup_unconfirmed" not in result["partialReasons"]:
        result["partialReasons"].append("cleanup_unconfirmed")
    if result["overallStatus"] == "passed":
        result["overallStatus"] = "partial"


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


async def determine_package_manager(sandbox) -> str:
    # Lockfile selection is fixed and does not inspect or execute package scripts.
    try:
        files = {entry.path.rsplit("/", 1)[-1] for entry in await sandbox.filesystem.list_files.aio("/work/repo")}
    except Exception as error:
        log_sandbox_failure("sandbox_result_invalid")
        raise ValidationError("sandbox_result_invalid") from error
    if "package-lock.json" in files:
        return "npm"
    if "pnpm-lock.yaml" in files:
        return "pnpm"
    if "yarn.lock" in files:
        return "yarn"
    raise ValidationError("no_lockfile")


async def verify_npm_lockfile_binding(sandbox, job: dict[str, Any]) -> None:
    """Accept only an npm lockfile that identifies the validated root package."""
    try:
        package = json.loads(await sandbox.filesystem.read_text.aio("/work/repo/package.json"))
        lockfile = json.loads(await sandbox.filesystem.read_text.aio("/work/repo/package-lock.json"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ValidationError("lockfile_update_failed") from error
    root = npm_lockfile_root(lockfile)
    change = job["proposedFix"]["packageJsonChange"]
    section = {
        "dependency": "dependencies",
        "devDependency": "devDependencies",
        "peerDependency": "peerDependencies",
        "optionalDependency": "optionalDependencies",
    }[job["dependencyType"]]
    dependencies = package.get(section) if isinstance(package, dict) else None
    if (
        not isinstance(package, dict)
        or not isinstance(root, dict)
        or package.get("name") != root.get("name")
        or package.get("version") != root.get("version")
        or not isinstance(dependencies, dict)
        or dependencies.get(change["dependency"]) != change["to"]
    ):
        raise ValidationError("lockfile_update_failed")


def npm_lockfile_root(lockfile: Any) -> dict[str, Any] | None:
    """Read root metadata from npm lockfile v1, v2, or v3 without guessing."""
    if not isinstance(lockfile, dict):
        return None
    packages = lockfile.get("packages")
    if isinstance(packages, dict) and isinstance(packages.get(""), dict):
        return packages[""]
    if "name" in lockfile and "version" in lockfile:
        return {"name": lockfile["name"], "version": lockfile["version"]}
    return None


def npm_lockfile_sync_argv() -> list[str]:
    return ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]


def install_argv(manager: str) -> list[str]:
    return {"npm": ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], "pnpm": ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], "yarn": ["yarn", "install", "--immutable", "--ignore-scripts"]}[manager]


def install_summary(lockfile_synchronized: bool) -> str:
    if lockfile_synchronized:
        return "package-lock.json was regenerated only inside the isolated validation sandbox; dependencies installed with scripts disabled."
    return "Installed with scripts disabled."


async def run_command(sandbox, argv: list[str], timeout_seconds: int, *, name: str | None = None) -> dict[str, Any]:
    started = time.monotonic()
    try:
        process = await sandbox.exec.aio(
            *SANDBOX_USER_PREFIX,
            *argv,
            timeout=timeout_seconds,
            workdir="/work/repo",
            env=SANDBOX_COMMAND_ENV,
            pty=True,
        )
    except Exception as error:
        log_sandbox_failure("sandbox_exec_failed")
        raise ValidationError("sandbox_exec_failed") from error
    timed_out = False
    try:
        output = await read_bounded_output(process)
        exit_code = await process.wait.aio()
    except TimeoutError:
        # A command reaching its fixed 90-second execution limit is a normal
        # validation outcome, not a worker orchestration failure.
        output = "Command did not complete before its execution limit."
        exit_code = 1
        timed_out = True
    except Exception as error:
        log_sandbox_failure("sandbox_exec_failed")
        raise ValidationError("sandbox_exec_failed") from error
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        log_sandbox_failure("sandbox_result_invalid")
        raise ValidationError("sandbox_result_invalid")
    duration = min(int((time.monotonic() - started) * 1000), 90000)
    summary = output or ("Completed." if exit_code == 0 else "Command failed without output.")
    if name is None:
        return {"status": "passed" if exit_code == 0 else "failed", "summary": summary}
    status = "passed" if exit_code == 0 else ("timed_out" if timed_out or duration >= 89_000 else "failed")
    return {"name": name, "status": status, "durationMs": duration, "summary": summary}


async def read_bounded_output(process) -> str:
    fragments: list[str] = []
    size = 0
    truncated = False
    # PTY mode intentionally multiplexes stdout and stderr into one stream,
    # avoiding a blocked process on an unread stderr pipe.
    async for line in process.stdout:
        encoded = line.encode("utf-8", "replace")
        remaining = MAX_COMMAND_OUTPUT_BYTES - size
        if remaining <= 0:
            truncated = True
            continue
        if len(encoded) > remaining:
            fragments.append(encoded[:remaining].decode("utf-8", "ignore"))
            size = MAX_COMMAND_OUTPUT_BYTES
            truncated = True
            continue
        fragments.append(line)
        size += len(encoded)
    output = normalize_command_output("".join(fragments)).strip()[:1000]
    if truncated:
        return (output + "\nCommand output was truncated at the 24 KiB diagnostic limit.").strip()
    return output or "Completed without output."


def normalize_command_output(output: str) -> str:
    """Remove terminal controls while retaining readable, bounded command diagnostics."""
    output = output.replace("\r\n", "\n").replace("\r", "\n")
    output = ANSI_ESCAPE_RE.sub("", output)
    output = MALFORMED_ANSI_ESCAPE_RE.sub("", output)
    return "".join(character for character in output if character in {"\n", "\t"} or ord(character) >= 32 and ord(character) != 127)


async def has_package_script(sandbox, name: str) -> bool:
    try:
        package = json.loads(await sandbox.filesystem.read_text.aio("/work/repo/package.json"))
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


def log_sandbox_failure(stage: str) -> None:
    # This is intentionally restricted to fixed labels: never emit a request,
    # repository path, command output, exception text, or environment value.
    if stage not in SAFE_SANDBOX_FAILURE_STAGES:
        stage = "sandbox_result_invalid"
    logger.warning("[sentinel:validation-worker] %s", stage)


def trusted_sandbox_agent_path() -> Path:
    """Return the immutable trusted agent baked into the outer worker image."""
    try:
        metadata = TRUSTED_SANDBOX_AGENT_PATH.stat()
    except OSError as error:
        raise FileNotFoundError("trusted_agent_source_missing") from error
    if not TRUSTED_SANDBOX_AGENT_PATH.is_file():
        raise FileNotFoundError("trusted_agent_source_missing")
    if metadata.st_size <= 0 or metadata.st_size > MAX_SANDBOX_AGENT_BYTES:
        raise ValueError("trusted_agent_source_invalid")
    return TRUSTED_SANDBOX_AGENT_PATH


def log_sandbox_create_failure(error: Exception) -> None:
    metadata = {
        "errorType": safe_sdk_identifier(type(error).__name__, "ModalError"),
        "reason": sanitize_sdk_error_reason(error),
    }
    grpc_status = getattr(error, "_grpc_status", None)
    if grpc_status is not None:
        metadata["modalStatus"] = safe_sdk_identifier(getattr(grpc_status, "name", ""), "UNKNOWN")
    logger.warning(
        "[sentinel:validation-worker] sandbox_create_failed %s",
        json.dumps(metadata, sort_keys=True, separators=(",", ":")),
    )


def log_sandbox_upload_failure(error: Exception, destination: str) -> None:
    metadata = {
        "destination": destination if destination in {"archive", "job", "trusted_agent"} else "unknown",
        "errorType": safe_sdk_identifier(type(error).__name__, "UploadError"),
        "reason": sanitize_sdk_error_reason(error),
    }
    grpc_status = getattr(error, "_grpc_status", None)
    if grpc_status is not None:
        metadata["modalStatus"] = safe_sdk_identifier(getattr(grpc_status, "name", ""), "UNKNOWN")
    logger.warning(
        "[sentinel:validation-worker] sandbox_upload_failed %s",
        json.dumps(metadata, sort_keys=True, separators=(",", ":")),
    )


def safe_sdk_identifier(value: Any, fallback: str) -> str:
    text = str(value)
    return text if re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,79}", text) else fallback


def sanitize_sdk_error_reason(error: Exception) -> str:
    reason = " ".join(str(error).split())
    reason = re.sub(
        r"(?i)\b(authorization|bearer|token|secret|signature|password|credential|api[_-]?key)\b\s*[:=]\s*(?:\"[^\"]*\"|'[^']*'|\S+)",
        r"\1=<redacted>",
        reason,
    )
    reason = re.sub(r"\b[A-Z][A-Z0-9_]{2,}\s*=\s*(?:\"[^\"]*\"|'[^']*'|\S+)", "<env>=<redacted>", reason)
    reason = re.sub(r"https?://\S+", "<url>", reason)
    reason = re.sub(r"(?:[A-Za-z]:)?/(?:[^\s/]+/)*[^\s,;:)]*", "<path>", reason)
    reason = re.sub(r"\b[A-Fa-f0-9]{32,}\b", "<opaque>", reason)
    reason = re.sub(r"\b[A-Za-z0-9_-]{40,}\b", "<opaque>", reason)
    reason = "".join(character if 32 <= ord(character) <= 126 else "?" for character in reason)
    return (reason[:MAX_SAFE_SDK_REASON_CHARS] or "unclassified_modal_sdk_error").strip()
