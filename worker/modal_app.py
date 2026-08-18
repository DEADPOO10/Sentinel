"""Modal HTTP boundary for Sentinel validation. Deploy separately from Next.js."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

import modal
from fastapi import Request

from worker.core import (
    ASYNC_VALIDATION_FAILURE_CATEGORIES,
    ASYNC_VALIDATION_PROTOCOL_VERSION,
    CHECK_NAMES,
    MAX_ARCHIVE_COMPRESSED_BYTES,
    MAX_COMMAND_OUTPUT_BYTES,
    MAX_REQUEST_BYTES,
    MAX_RESPONSE_BYTES,
    POLICY,
    ValidationError,
    canonical_json,
    inspect_github_zip,
    parse_and_validate_job,
    parse_async_status_request,
    parse_async_submit_request,
    request_auth_failure_reason,
    result_for_error,
    sign,
    validate_worker_result,
    verify_signature,
)

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
# Modal Dict entries are durable across containers and expire after seven days
# of inactivity under Modal's storage contract. The application stores only a
# domain-separated digest, never a request signature or body.
REQUEST_REPLAY_CACHE = modal.Dict.from_name(
    "sentinel-validation-request-replay-v1",
    create_if_missing=True,
)
# Modal 1.5.3 stores named Dict entries durably across containers and expires
# each entry after seven days without a read or write. Values here are strict,
# bounded state/result records; execution claims contain only job/commit IDs.
ASYNC_VALIDATION_JOB_STATE = modal.Dict.from_name(
    "sentinel-validation-jobs-v2",
    create_if_missing=True,
)
SignatureScheme = Literal["v1", "legacy", "v2_submit", "v2_status"]
ReplayReserver = Callable[[SignatureScheme, str], Awaitable[bool]]
AsyncJobReserver = Callable[[dict[str, Any]], Awaitable[bool]]
AsyncJobReader = Callable[[str], Awaitable[dict[str, Any] | None]]
AsyncJobWriter = Callable[[dict[str, Any]], Awaitable[None]]
AsyncJobSpawner = Callable[[dict[str, Any]], Awaitable[None]]
AsyncExecutionClaimReserver = Callable[[dict[str, Any]], Awaitable[bool]]
AsyncJobExecutor = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
LEGACY_SIGNATURE_COMPATIBILITY_ENV = "SENTINEL_VALIDATION_ACCEPT_LEGACY_SIGNATURES"

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
MAX_RESULT_SUMMARY_CHARS = 1_000
MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES = 2 * 1024 * 1024
NPM_PACKAGE_LOCK_PATH = "/work/repo/package-lock.json"
TRUNCATED_OUTPUT_NOTICE = "Command output was truncated at the 24 KiB diagnostic limit."
# Keep a small beginning for command identity and a larger ending for the
# failure summary most test runners print last. Together with the marker these
# never exceed MAX_COMMAND_OUTPUT_BYTES.
COMMAND_OUTPUT_HEAD_BYTES = 8 * 1024
COMMAND_OUTPUT_TRUNCATION_MARKER = "\n\n... output truncated by Sentinel ...\n\n"
COMMAND_OUTPUT_TAIL_BYTES = MAX_COMMAND_OUTPUT_BYTES - COMMAND_OUTPUT_HEAD_BYTES - len(COMMAND_OUTPUT_TRUNCATION_MARKER.encode("utf-8"))
# The Modal function has a hard five-minute limit. Keep a small, explicit
# reserve so termination, result signing, and response delivery are not
# competing with an in-flight repository command at that deadline.
TOTAL_VALIDATION_DURATION_SECONDS = 300
ASYNC_BACKGROUND_FUNCTION_TIMEOUT_SECONDS = 330
CLEANUP_RESERVE_SECONDS = 20
VALIDATION_EXECUTION_BUDGET_SECONDS = TOTAL_VALIDATION_DURATION_SECONDS - CLEANUP_RESERVE_SECONDS
SETUP_COMMAND_TIMEOUT_SECONDS = 90
CHECK_TIMEOUT_SECONDS = {
    "typecheck": 45,
    "lint": 60,
    "test": 120,
    "build": 75,
}
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


def create_api(
    replay_reserver: ReplayReserver | None = None,
    async_job_reserver: AsyncJobReserver | None = None,
    async_job_reader: AsyncJobReader | None = None,
    async_job_writer: AsyncJobWriter | None = None,
    async_job_spawner: AsyncJobSpawner | None = None,
):
    from fastapi import FastAPI
    from fastapi.responses import Response

    api = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    reserve_replay = replay_reserver or reserve_validation_request
    reserve_async_job = async_job_reserver or reserve_async_validation_job
    read_async_job = async_job_reader or read_async_validation_job
    write_async_job = async_job_writer or write_async_validation_job
    spawn_async_job = async_job_spawner or spawn_async_validation_job

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
        request_signature = request.headers.get("x-sentinel-request-signature")
        request_timestamp = request.headers.get("x-sentinel-request-timestamp")
        auth_failure = request_auth_failure_reason(secret, raw, request_signature, request_timestamp)
        signature_scheme: SignatureScheme = "v1"
        if auth_failure == "signature_mismatch" and legacy_signature_compatibility_enabled():
            # The rollout bridge is available only to otherwise-valid jobs.
            # Parsing before legacy verification prevents malformed or
            # unsupported bodies from entering the fallback path.
            try:
                legacy_job = parse_and_validate_job(json.loads(raw))
            except (ValidationError, json.JSONDecodeError):
                legacy_job = None
            if legacy_job is not None and verify_signature(secret, raw, request_signature):
                job = legacy_job
                signature_scheme = "legacy"
                auth_failure = None
        if auth_failure:
            log_request_auth_failure(auth_failure)
            return signed_error(secret, job, "Worker request could not be authenticated.", "invalid_request_authentication", 401)
        if request_signature is None:
            # request_auth_failure_reason rejects this condition above. Keep a
            # fail-closed guard so the replay store never receives bad input.
            log_request_auth_failure("missing_headers")
            return signed_error(secret, job, "Worker request could not be authenticated.", "invalid_request_authentication", 401)
        try:
            replay_reserved = await reserve_replay(signature_scheme, request_signature)
        except Exception:
            log_request_auth_failure("replay_store_unavailable")
            return signed_error(secret, job, "Worker replay protection is temporarily unavailable.", "worker_replay_protection_unavailable", 503)
        if not replay_reserved:
            log_request_auth_failure("replay_detected")
            return signed_error(secret, job, "Worker request could not be authenticated.", "invalid_request_authentication", 401)
        if signature_scheme == "legacy":
            log_legacy_signature_accepted()
        if job is None:
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

    @api.post("/v2/validations/submit")
    async def submit_validation(request: Request) -> Response:
        raw = await request.body()
        secret = os.environ.get("SENTINEL_VALIDATION_WORKER_SHARED_SECRET", "")
        if not secret or len(secret) < 32:
            return signed_async_failure(secret, None, None, "worker_unavailable", 503)
        if len(raw) > MAX_REQUEST_BYTES:
            log_request_auth_failure("request_too_large")
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        request_signature = request.headers.get("x-sentinel-request-signature")
        request_timestamp = request.headers.get("x-sentinel-request-timestamp")
        auth_failure = request_auth_failure_reason(secret, raw, request_signature, request_timestamp)
        if auth_failure:
            log_request_auth_failure(auth_failure)
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        if request_signature is None:
            log_request_auth_failure("missing_headers")
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        try:
            replay_reserved = await reserve_replay("v2_submit", request_signature)
        except Exception:
            log_request_auth_failure("replay_store_unavailable")
            return signed_async_failure(secret, None, None, "worker_unavailable", 503)
        if not replay_reserved:
            log_request_auth_failure("replay_detected")
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        try:
            job = parse_async_submit_request(json.loads(raw))
        except (ValidationError, json.JSONDecodeError):
            return signed_async_failure(secret, None, None, "result_invalid", 422)

        try:
            reserved = await reserve_async_job(job)
            if reserved:
                try:
                    await spawn_async_job(job)
                except Exception:
                    failed = failed_async_job_state(job, "worker_unavailable")
                    await write_async_job(failed)
                    log_async_job_failure("worker_unavailable")
                    return signed_json(secret, async_status_payload(failed), 503)
            else:
                existing = await read_async_job(job["jobId"])
                if not valid_async_job_state(existing) or existing["repository"]["commitSha"].lower() != job["repository"]["commitSha"].lower():
                    return signed_async_failure(secret, job["jobId"], job["repository"]["commitSha"], "result_invalid", 409)
        except Exception:
            log_async_job_failure("worker_unavailable")
            return signed_async_failure(secret, job["jobId"], job["repository"]["commitSha"], "worker_unavailable", 503)

        return signed_json(secret, async_submit_receipt(job), 202)

    @api.post("/v2/validations/status")
    async def validation_status(request: Request) -> Response:
        raw = await request.body()
        secret = os.environ.get("SENTINEL_VALIDATION_WORKER_SHARED_SECRET", "")
        if not secret or len(secret) < 32:
            return signed_async_failure(secret, None, None, "worker_unavailable", 503)
        if len(raw) > MAX_REQUEST_BYTES:
            log_request_auth_failure("request_too_large")
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        request_signature = request.headers.get("x-sentinel-request-signature")
        request_timestamp = request.headers.get("x-sentinel-request-timestamp")
        auth_failure = request_auth_failure_reason(secret, raw, request_signature, request_timestamp)
        if auth_failure:
            log_request_auth_failure(auth_failure)
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        if request_signature is None:
            log_request_auth_failure("missing_headers")
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        try:
            replay_reserved = await reserve_replay("v2_status", request_signature)
        except Exception:
            log_request_auth_failure("replay_store_unavailable")
            return signed_async_failure(secret, None, None, "worker_unavailable", 503)
        if not replay_reserved:
            log_request_auth_failure("replay_detected")
            return signed_async_failure(secret, None, None, "result_invalid", 401)
        try:
            status_request = parse_async_status_request(json.loads(raw))
        except (ValidationError, json.JSONDecodeError):
            return signed_async_failure(secret, None, None, "result_invalid", 422)

        job_id = status_request["jobId"]
        commit_sha = status_request["repository"]["commitSha"]
        try:
            state = await read_async_job(job_id)
        except Exception:
            log_async_job_failure("worker_unavailable")
            return signed_async_failure(secret, job_id, commit_sha, "worker_unavailable", 503)
        if state is None:
            return signed_async_failure(secret, job_id, commit_sha, "job_expired", 404)
        if not valid_async_job_state(state):
            return signed_async_failure(secret, job_id, commit_sha, "result_invalid", 500)
        if state["repository"]["commitSha"].lower() != commit_sha.lower():
            return signed_async_failure(secret, job_id, commit_sha, "result_invalid", 404)
        return signed_json(secret, async_status_payload(state), 200)

    return api


@app.function(
    image=WORKER_IMAGE,
    secrets=[
        modal.Secret.from_name(SECRET_NAME),
        modal.Secret.from_name(
            "sentinel-validation-rollout",
            required_keys=[LEGACY_SIGNATURE_COMPATIBILITY_ENV],
        ),
    ],
    timeout=300,
    cpu=(1.0, 1.0),
    memory=(2048, 2048),
    max_containers=2,
)
@modal.asgi_app()
def web():
    return create_api()


@app.function(
    image=WORKER_IMAGE,
    secrets=[modal.Secret.from_name(SECRET_NAME)],
    timeout=ASYNC_BACKGROUND_FUNCTION_TIMEOUT_SECONDS,
    retries=0,
    cpu=(1.0, 1.0),
    memory=(2048, 2048),
    max_containers=2,
)
async def execute_async_validation_background(job: dict[str, Any]) -> None:
    await run_async_validation_background(job)


async def run_async_validation_background(
    job: dict[str, Any],
    *,
    claim_reserver: AsyncExecutionClaimReserver | None = None,
    job_reader: AsyncJobReader | None = None,
    job_writer: AsyncJobWriter | None = None,
    executor: AsyncJobExecutor | None = None,
) -> None:
    """Claim and execute one accepted job; duplicate invocations are no-ops."""
    parsed_job = parse_and_validate_job(job)
    reserve_claim = claim_reserver or reserve_async_execution_claim
    read_job = job_reader or read_async_validation_job
    write_job = job_writer or write_async_validation_job
    execute = executor or execute_job

    if not await reserve_claim(parsed_job):
        return
    state = await read_job(parsed_job["jobId"])
    if (
        not valid_async_job_state(state)
        or state["repository"]["commitSha"].lower() != parsed_job["repository"]["commitSha"].lower()
        or state["status"] != "queued"
    ):
        return

    running = running_async_job_state(state)
    await write_job(running)
    try:
        result = await asyncio.wait_for(execute(parsed_job), timeout=TOTAL_VALIDATION_DURATION_SECONDS)
    except (asyncio.TimeoutError, TimeoutError):
        log_async_job_failure("worker_timeout")
        await write_job(failed_async_job_state(parsed_job, "worker_timeout", running))
        return
    except ValidationError as error:
        reason = error.args[0] if error.args and isinstance(error.args[0], str) else "worker_failure"
        result = result_for_error(
            parsed_job,
            "The isolated validation worker could not safely complete this validation.",
            reason,
        )
    except Exception:
        log_async_job_failure("internal_error")
        await write_job(failed_async_job_state(parsed_job, "internal_error", running))
        return

    try:
        validated_result = validate_worker_result(
            result,
            parsed_job["jobId"],
            parsed_job["repository"]["commitSha"],
        )
    except ValidationError:
        log_async_job_failure("result_invalid")
        await write_job(failed_async_job_state(parsed_job, "result_invalid", running))
        return
    await write_job(completed_async_job_state(running, validated_result))


async def spawn_async_validation_job(job: dict[str, Any]) -> None:
    # Modal 1.5.3's async spawn returns after durable function-call submission.
    await execute_async_validation_background.spawn.aio(job)


def async_job_state_key(job_id: str) -> str:
    return f"job:{job_id}"


def async_execution_claim_key(job_id: str) -> str:
    return f"execution:{job_id}"


def current_timestamp_ms() -> int:
    return int(time.time() * 1000)


def queued_async_job_state(job: dict[str, Any], *, timestamp_ms: int | None = None) -> dict[str, Any]:
    timestamp = timestamp_ms if timestamp_ms is not None else current_timestamp_ms()
    return {
        "version": ASYNC_VALIDATION_PROTOCOL_VERSION,
        "jobId": job["jobId"],
        "repository": {"commitSha": job["repository"]["commitSha"]},
        "status": "queued",
        "queuedAt": timestamp,
        "updatedAt": timestamp,
    }


def running_async_job_state(state: dict[str, Any], *, timestamp_ms: int | None = None) -> dict[str, Any]:
    timestamp = timestamp_ms if timestamp_ms is not None else current_timestamp_ms()
    return {
        "version": ASYNC_VALIDATION_PROTOCOL_VERSION,
        "jobId": state["jobId"],
        "repository": {"commitSha": state["repository"]["commitSha"]},
        "status": "running",
        "queuedAt": state["queuedAt"],
        "startedAt": timestamp,
        "updatedAt": timestamp,
    }


def completed_async_job_state(
    state: dict[str, Any],
    result: dict[str, Any],
    *,
    timestamp_ms: int | None = None,
) -> dict[str, Any]:
    timestamp = timestamp_ms if timestamp_ms is not None else current_timestamp_ms()
    return {
        "version": ASYNC_VALIDATION_PROTOCOL_VERSION,
        "jobId": state["jobId"],
        "repository": {"commitSha": state["repository"]["commitSha"]},
        "status": "completed",
        "queuedAt": state["queuedAt"],
        "startedAt": state["startedAt"],
        "completedAt": timestamp,
        "updatedAt": timestamp,
        "result": result,
    }


def failed_async_job_state(
    job: dict[str, Any],
    failure_category: str,
    previous: dict[str, Any] | None = None,
    *,
    timestamp_ms: int | None = None,
) -> dict[str, Any]:
    if failure_category not in ASYNC_VALIDATION_FAILURE_CATEGORIES:
        failure_category = "internal_error"
    timestamp = timestamp_ms if timestamp_ms is not None else current_timestamp_ms()
    state = {
        "version": ASYNC_VALIDATION_PROTOCOL_VERSION,
        "jobId": job["jobId"],
        "repository": {"commitSha": job["repository"]["commitSha"]},
        "status": "failed",
        "queuedAt": previous["queuedAt"] if previous else timestamp,
        "completedAt": timestamp,
        "updatedAt": timestamp,
        "failureCategory": failure_category,
    }
    if previous and isinstance(previous.get("startedAt"), int):
        state["startedAt"] = previous["startedAt"]
    return state


def valid_async_job_state(value: Any) -> bool:
    if not isinstance(value, dict):
        return False
    base = {"version", "jobId", "repository", "status", "queuedAt", "updatedAt"}
    status = value.get("status")
    allowed_keys = {
        "queued": {frozenset(base)},
        "running": {frozenset(base | {"startedAt"})},
        "completed": {frozenset(base | {"startedAt", "completedAt", "result"})},
        "failed": {
            frozenset(base | {"completedAt", "failureCategory"}),
            frozenset(base | {"startedAt", "completedAt", "failureCategory"}),
        },
    }
    if not isinstance(status, str) or status not in allowed_keys or frozenset(value) not in allowed_keys[status]:
        return False
    if (
        value.get("version") != ASYNC_VALIDATION_PROTOCOL_VERSION
        or not isinstance(value.get("jobId"), str)
        or not re.fullmatch(r"[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89ab][a-fA-F0-9]{3}-[a-fA-F0-9]{12}", value["jobId"])
        or not isinstance(value.get("repository"), dict)
        or set(value["repository"]) != {"commitSha"}
        or not isinstance(value["repository"].get("commitSha"), str)
        or not re.fullmatch(r"[a-fA-F0-9]{40,64}", value["repository"]["commitSha"])
    ):
        return False
    timestamps = [value.get("queuedAt"), value.get("updatedAt")]
    timestamps.extend(value[field] for field in ("startedAt", "completedAt") if field in value)
    if not all(isinstance(item, int) and not isinstance(item, bool) and item > 0 for item in timestamps):
        return False
    if status == "failed" and value.get("failureCategory") not in ASYNC_VALIDATION_FAILURE_CATEGORIES:
        return False
    if status == "completed":
        try:
            validate_worker_result(value.get("result"), value["jobId"], value["repository"]["commitSha"])
        except ValidationError:
            return False
    return True


async def reserve_async_validation_job(job: dict[str, Any]) -> bool:
    parsed = parse_and_validate_job(job)
    return await ASYNC_VALIDATION_JOB_STATE.put.aio(
        async_job_state_key(parsed["jobId"]),
        queued_async_job_state(parsed),
        skip_if_exists=True,
    )


async def read_async_validation_job(job_id: str) -> dict[str, Any] | None:
    return await ASYNC_VALIDATION_JOB_STATE.get.aio(async_job_state_key(job_id), None)


async def write_async_validation_job(state: dict[str, Any]) -> None:
    if not valid_async_job_state(state):
        raise ValidationError("result_invalid")
    await ASYNC_VALIDATION_JOB_STATE.put.aio(async_job_state_key(state["jobId"]), state)


async def reserve_async_execution_claim(job: dict[str, Any]) -> bool:
    parsed = parse_and_validate_job(job)
    return await ASYNC_VALIDATION_JOB_STATE.put.aio(
        async_execution_claim_key(parsed["jobId"]),
        {
            "jobId": parsed["jobId"],
            "repository": {"commitSha": parsed["repository"]["commitSha"]},
            "claimedAt": current_timestamp_ms(),
        },
        skip_if_exists=True,
    )


def async_submit_receipt(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "version": ASYNC_VALIDATION_PROTOCOL_VERSION,
        "jobId": job["jobId"],
        "repository": {"commitSha": job["repository"]["commitSha"]},
        "status": "queued",
    }


def async_status_payload(state: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "version": ASYNC_VALIDATION_PROTOCOL_VERSION,
        "jobId": state["jobId"],
        "repository": {"commitSha": state["repository"]["commitSha"]},
        "status": state["status"],
    }
    if state["status"] == "completed":
        payload["result"] = state["result"]
    elif state["status"] == "failed":
        payload["failureCategory"] = state["failureCategory"]
    return payload


def signed_async_failure(
    secret: str,
    job_id: str | None,
    commit_sha: str | None,
    failure_category: str,
    status: int,
):
    if failure_category not in ASYNC_VALIDATION_FAILURE_CATEGORIES:
        failure_category = "internal_error"
    return signed_json(
        secret,
        {
            "version": ASYNC_VALIDATION_PROTOCOL_VERSION,
            "jobId": job_id or "00000000-0000-4000-8000-000000000000",
            "repository": {"commitSha": commit_sha or "0" * 40},
            "status": "failed",
            "failureCategory": failure_category,
        },
        status,
    )


async def execute_job(job: dict[str, Any]) -> dict[str, Any]:
    # urllib is only used for the trusted outer-worker GitHub fetch. Modal
    # operations below always use the SDK's native async .aio interface.
    started = time.monotonic()
    validation_deadline = started + VALIDATION_EXECUTION_BUDGET_SECONDS
    archive = await asyncio.to_thread(fetch_verified_archive, job)
    await asyncio.to_thread(inspect_github_zip, archive)
    sandbox = None
    result: dict[str, Any] | None = None
    artifact: dict[str, Any] | None = None
    artifact_unavailable = False
    try:
        sandbox = await create_sandbox(job)
        await upload_sandbox_inputs(sandbox, archive, job)
        await prepare_sandbox_workspace(sandbox)
        manager = await determine_package_manager(sandbox)
        lockfile_synchronized = False
        if manager == "npm" and job["proposedFix"]["packageJsonChange"]["required"]:
            await verify_npm_lockfile_binding(sandbox, job)
            lockfile_sync_timeout = command_timeout_seconds(validation_deadline, SETUP_COMMAND_TIMEOUT_SECONDS)
            if lockfile_sync_timeout == 0:
                result = time_budget_result(job)
            else:
                lockfile_sync = await run_command(sandbox, npm_lockfile_sync_argv(), lockfile_sync_timeout)
            if result is None and lockfile_sync["status"] != "passed":
                result = completed_result(
                    job,
                    "failed",
                    {"status": "failed", "summary": lockfile_sync["summary"]},
                    skipped_checks("Not run because package-lock synchronization failed."),
                    ["lockfile_update_failed"],
                    [],
                )
            elif result is None:
                # `npm install --package-lock-only` must not be allowed to
                # alter the authorized package.json edit while it resolves the
                # transitive graph. Recheck the exact server-authorized value.
                await verify_npm_lockfile_binding(sandbox, job, require_synchronized_dependency=True)
                lockfile_synchronized = True
        if result is None:
            install_timeout = command_timeout_seconds(validation_deadline, SETUP_COMMAND_TIMEOUT_SECONDS)
            if install_timeout == 0:
                result = time_budget_result(job)
            else:
                install = await run_command(sandbox, install_argv(manager), install_timeout)
            if result is None and install["status"] != "passed":
                result = completed_result(job, "failed", {"status": "failed", "summary": install["summary"]}, skipped_checks("Not run because dependency installation failed."), ["dependency_install_failed"], [])
            elif result is None:
                if lockfile_synchronized:
                    try:
                        artifact = await collect_npm_package_lock_artifact(sandbox, job)
                    except ValidationError as error:
                        artifact_unavailable = True
                        log_lockfile_artifact_failure(error.args[0] if error.args else "artifact_invalid")
                await disable_sandbox_egress(sandbox)
                checks, timed_out, deadline_reached, failed, missing_script = await run_validation_checks(sandbox, manager, validation_deadline)
                skipped = any(check["status"] == "skipped" for check in checks)
                warnings = ["package_lock_synchronized_in_sandbox"] if lockfile_synchronized else []
                if artifact_unavailable:
                    warnings.append("validated_lockfile_artifact_unavailable")
                partial_reasons: list[str] = []
                if failed:
                    warnings.append("validation_check_failed")
                    overall = "failed"
                elif timed_out or deadline_reached:
                    warnings.append("validation_check_timed_out" if timed_out else "validation_time_budget_exhausted")
                    partial_reasons.append("validation_timeout")
                    overall = "partial"
                elif skipped:
                    overall = "partial"
                else:
                    overall = "passed"
                if skipped and not failed:
                    if missing_script:
                        warnings.append("one_or_more_allowlisted_checks_not_defined")
                    partial_reasons.append("skipped_checks")
                result = completed_result(job, overall, {"status": "passed", "summary": install_summary(lockfile_synchronized)}, checks, warnings, partial_reasons, artifact=artifact)
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


async def verify_npm_lockfile_binding(sandbox, job: dict[str, Any], *, require_synchronized_dependency: bool = False) -> None:
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
    lock_dependencies = root.get(section) if isinstance(root, dict) else None
    if (
        not isinstance(package, dict)
        or not isinstance(root, dict)
        or package.get("name") != root.get("name")
        or package.get("version") != root.get("version")
        or not isinstance(dependencies, dict)
        or dependencies.get(change["dependency"]) != change["to"]
        or (require_synchronized_dependency and (not isinstance(lock_dependencies, dict) or lock_dependencies.get(change["dependency"]) != change["to"]))
    ):
        raise ValidationError("lockfile_update_failed")


async def collect_npm_package_lock_artifact(sandbox, job: dict[str, Any]) -> dict[str, Any]:
    """Read exactly one bounded regular root package-lock after install succeeds."""
    try:
        entries = await sandbox.filesystem.list_files.aio("/work/repo")
        matches = [entry for entry in entries if getattr(entry, "path", None) == NPM_PACKAGE_LOCK_PATH]
        if len(matches) != 1 or not matches[0].is_file():
            raise ValidationError("artifact_not_regular_file")
        declared_size = getattr(matches[0], "size", None)
        if not isinstance(declared_size, int) or isinstance(declared_size, bool) or declared_size <= 0:
            raise ValidationError("artifact_empty")
        if declared_size > MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES:
            raise ValidationError("artifact_oversized")
        raw = await sandbox.filesystem.read_bytes.aio(NPM_PACKAGE_LOCK_PATH)
        package_text = await sandbox.filesystem.read_text.aio("/work/repo/package.json")
    except ValidationError:
        raise
    except Exception as error:
        raise ValidationError("artifact_read_failed") from error
    if len(raw) != declared_size:
        raise ValidationError("artifact_size_mismatch")
    return create_npm_package_lock_artifact(raw, package_text, job)


def create_npm_package_lock_artifact(raw: bytes, package_text: str, job: dict[str, Any]) -> dict[str, Any]:
    if not raw:
        raise ValidationError("artifact_empty")
    if len(raw) > MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES:
        raise ValidationError("artifact_oversized")
    try:
        content = raw.decode("utf-8", "strict")
        lockfile = json.loads(content)
        package = json.loads(package_text)
    except (UnicodeDecodeError, json.JSONDecodeError, TypeError) as error:
        raise ValidationError("artifact_invalid_json") from error
    version = lockfile.get("lockfileVersion") if isinstance(lockfile, dict) else None
    packages = lockfile.get("packages") if isinstance(lockfile, dict) else None
    root = packages.get("") if isinstance(packages, dict) else None
    change = job["proposedFix"]["packageJsonChange"]
    section = {
        "dependency": "dependencies",
        "devDependency": "devDependencies",
        "peerDependency": "peerDependencies",
        "optionalDependency": "optionalDependencies",
    }[job["dependencyType"]]
    package_dependencies = package.get(section) if isinstance(package, dict) else None
    lock_dependencies = root.get(section) if isinstance(root, dict) else None
    if version not in {2, 3} or isinstance(version, bool):
        raise ValidationError("artifact_unsupported_lockfile_version")
    if (
        not isinstance(package, dict)
        or not isinstance(root, dict)
        or package.get("name") != root.get("name")
        or package.get("version") != root.get("version")
        or not isinstance(package_dependencies, dict)
        or package_dependencies.get(change["dependency"]) != change["to"]
        or not isinstance(lock_dependencies, dict)
        or lock_dependencies.get(change["dependency"]) != change["to"]
    ):
        raise ValidationError("artifact_dependency_mismatch")
    return {
        "kind": "npm_package_lock",
        "path": "package-lock.json",
        "encoding": "base64",
        "content": base64.b64encode(raw).decode("ascii"),
        "byteLength": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


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


def command_timeout_seconds(deadline: float, requested_timeout_seconds: int) -> int:
    """Bound every command by both its own cap and the shared job budget."""
    remaining = int(deadline - time.monotonic())
    return max(0, min(requested_timeout_seconds, remaining))


def time_budget_result(job: dict[str, Any]) -> dict[str, Any]:
    return completed_result(
        job,
        "partial",
        {"status": "skipped", "summary": "Dependency installation was not started because the isolated validation time budget was exhausted."},
        skipped_checks("Not run because insufficient time remained in the total validation budget."),
        ["validation_time_budget_exhausted"],
        ["validation_timeout", "skipped_checks"],
    )


async def run_validation_checks(sandbox, manager: str, deadline: float) -> tuple[list[dict[str, Any]], bool, bool, bool, bool]:
    """Run independent allowlisted checks without treating a timeout as failure.

    Returns checks plus flags for a timed-out check, exhausted shared budget,
    a definitive check failure, and scripts that were not defined.
    """
    checks: list[dict[str, Any]] = []
    timed_out = deadline_reached = failed = missing_script = False
    for index, name in enumerate(CHECK_NAMES):
        timeout_seconds = command_timeout_seconds(deadline, CHECK_TIMEOUT_SECONDS[name])
        if timeout_seconds == 0:
            checks.extend(skipped_checks("Not run because insufficient time remained in the total validation budget.", names=CHECK_NAMES[index:]))
            deadline_reached = True
            break
        if not await has_package_script(sandbox, name):
            checks.append({"name": name, "status": "skipped", "durationMs": 0, "summary": "No package script is defined."})
            missing_script = True
            continue
        check = await run_command(sandbox, [manager, "run", name, "--if-present"], timeout_seconds, name=name)
        checks.append(check)
        if check["status"] == "failed":
            checks.extend(skipped_checks("Not run after a failed check.", names=CHECK_NAMES[index + 1 :]))
            failed = True
            break
        if check["status"] == "timed_out":
            timed_out = True
    return checks, timed_out, deadline_reached, failed, missing_script


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
        captured_output = await read_bounded_output(process)
    except TimeoutError:
        # A command reaching its execution limit is a normal
        # validation outcome, not a worker orchestration failure.
        check_label = {"typecheck": "Typecheck", "lint": "Lint", "test": "Tests", "build": "Build"}.get(name or "", "This check")
        captured_output = CapturedCommandOutput(
            text=f"{check_label} exceeded the isolated validation time budget." if name is not None else "Dependency installation did not complete before its execution limit.",
            tail="",
            truncated=False,
        )
        exit_code = 1
        timed_out = True
    except Exception as error:
        log_sandbox_failure("sandbox_exec_failed")
        raise ValidationError("sandbox_exec_failed") from error
    if not timed_out:
        try:
            exit_code = await process.wait.aio()
        except TimeoutError:
            check_label = {"typecheck": "Typecheck", "lint": "Lint", "test": "Tests", "build": "Build"}.get(name or "", "This check")
            timeout_summary = f"{check_label} exceeded the isolated validation time budget." if name is not None else "Dependency installation did not complete before its execution limit."
            captured_output = CapturedCommandOutput(
                text=captured_output.text or timeout_summary,
                tail=captured_output.tail,
                truncated=captured_output.truncated,
            )
            exit_code = 1
            timed_out = True
        except Exception as error:
            log_sandbox_failure("sandbox_exec_failed")
            raise ValidationError("sandbox_exec_failed") from error
    if not isinstance(exit_code, int) or isinstance(exit_code, bool):
        log_sandbox_failure("sandbox_result_invalid")
        raise ValidationError("sandbox_result_invalid")
    duration = min(int((time.monotonic() - started) * 1000), timeout_seconds * 1000)
    summary = command_summary(captured_output, failure_or_timeout=exit_code != 0 or timed_out)
    if name is None:
        return {"status": "passed" if exit_code == 0 else "failed", "summary": summary}
    status = "passed" if exit_code == 0 else ("timed_out" if timed_out else "failed")
    return {"name": name, "status": status, "durationMs": duration, "summary": summary}


@dataclass(frozen=True)
class CapturedCommandOutput:
    text: str
    tail: str
    truncated: bool


async def read_bounded_output(process) -> CapturedCommandOutput:
    retained = bytearray()
    tail = bytearray()
    total = 0
    truncated = False
    # PTY mode intentionally multiplexes stdout and stderr into one stream,
    # avoiding a blocked process on an unread stderr pipe.
    async for line in process.stdout:
        encoded = line.encode("utf-8", "replace")
        previous_total = total
        total += len(encoded)
        if len(retained) < MAX_COMMAND_OUTPUT_BYTES:
            retained.extend(encoded[: MAX_COMMAND_OUTPUT_BYTES - len(retained)])
        if total > MAX_COMMAND_OUTPUT_BYTES:
            if not truncated:
                # The first oversized chunk may contain both the retained head
                # and tail. Derive the tail before dropping the middle.
                overflow_start = max(0, MAX_COMMAND_OUTPUT_BYTES - previous_total)
                tail = append_trailing_bytes(retained[-COMMAND_OUTPUT_TAIL_BYTES:], encoded, COMMAND_OUTPUT_TAIL_BYTES, start=overflow_start)
                truncated = True
            else:
                tail = append_trailing_bytes(tail, encoded, COMMAND_OUTPUT_TAIL_BYTES)
    if not truncated:
        output = normalize_command_output(retained.decode("utf-8", "ignore")).strip()
        return CapturedCommandOutput(text=output or "Completed without output.", tail=output, truncated=False)

    head = retained[:COMMAND_OUTPUT_HEAD_BYTES].decode("utf-8", "ignore")
    tail_text = normalize_command_output(tail.decode("utf-8", "ignore")).strip()
    output = normalize_command_output(head).strip() + COMMAND_OUTPUT_TRUNCATION_MARKER + tail_text
    return CapturedCommandOutput(text=output.strip(), tail=tail_text, truncated=True)


def trailing_bytes(value: bytes | bytearray, maximum: int) -> bytearray:
    return bytearray(value[-maximum:])


def append_trailing_bytes(existing: bytearray, addition: bytes, maximum: int, *, start: int = 0) -> bytearray:
    available = len(addition) - start
    if available >= maximum:
        return bytearray(addition[-maximum:])
    relevant = addition[start:]
    if len(existing) + available <= maximum:
        return existing + relevant
    return bytearray(existing[-(maximum - available) :] + relevant)


def command_summary(captured: CapturedCommandOutput, *, failure_or_timeout: bool) -> str:
    """Return the signed 1,000-character summary without expanding the contract."""
    source = captured.tail if failure_or_timeout and captured.tail else captured.text
    if captured.truncated:
        prefix = TRUNCATED_OUTPUT_NOTICE + " Final output:\n"
        return (prefix + source[-(MAX_RESULT_SUMMARY_CHARS - len(prefix)) :]).strip()
    if len(source) <= MAX_RESULT_SUMMARY_CHARS:
        return source or ("Command failed without output." if failure_or_timeout else "Completed without output.")
    if failure_or_timeout:
        return ("…\n" + source[-(MAX_RESULT_SUMMARY_CHARS - 2) :]).strip()
    return source[:MAX_RESULT_SUMMARY_CHARS].rstrip()


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


def completed_result(job: dict[str, Any], overall: str, install: dict[str, str], checks: list[dict[str, Any]], warnings: list[str], partial: list[str], *, artifact: dict[str, Any] | None = None) -> dict[str, Any]:
    result = {"version": 1, "jobId": job["jobId"], "repository": {"commitSha": job["repository"]["commitSha"]}, "overallStatus": overall, "install": install, "checks": checks, "warnings": warnings[:12], "partialReasons": partial}
    if artifact is not None:
        result["artifact"] = artifact
    return result


def signed_json(secret: str, payload: dict[str, Any], status: int):
    from fastapi.responses import Response
    body = canonical_json(payload)
    if len(body) > MAX_RESPONSE_BYTES:
        raise ValidationError("worker_response_too_large")
    return Response(content=body, status_code=status, media_type="application/json", headers={"x-sentinel-worker-signature": sign(secret, body), "cache-control": "no-store"})


def signed_error(secret: str, job: dict[str, Any] | None, summary: str, warning: str, status: int):
    return signed_json(secret, result_for_error(job, summary, warning), status)


def legacy_signature_compatibility_enabled() -> bool:
    """Enable the temporary bridge only for one exact, explicit value."""
    return os.environ.get(LEGACY_SIGNATURE_COMPATIBILITY_ENV) == "true"


def replay_cache_key(signature_scheme: SignatureScheme, signature: str) -> str:
    """Return a domain-separated digest without retaining the signature."""
    if signature_scheme not in {"v1", "legacy", "v2_submit", "v2_status"}:
        raise ValueError("unsupported_signature_scheme")
    material = b"sentinel-validation-replay\x00" + signature_scheme.encode("ascii") + b"\x00" + signature.encode("ascii")
    return hashlib.sha256(material).hexdigest()


async def reserve_validation_request(signature_scheme: SignatureScheme, signature: str) -> bool:
    """Atomically reserve an authenticated request across all worker containers."""
    return await REQUEST_REPLAY_CACHE.put.aio(
        replay_cache_key(signature_scheme, signature),
        int(time.time()),
        skip_if_exists=True,
    )


def log_request_auth_failure(reason: str) -> None:
    # Reasons are fixed labels only: never log credentials, signatures, or body data.
    logger.warning("validation request authentication rejected: reason=%s", reason)


def log_legacy_signature_accepted() -> None:
    # Fixed event only: never log the compatibility flag, signature, or body.
    logger.warning("[sentinel:validation-worker] legacy_signature_accepted")


def log_async_job_failure(category: str) -> None:
    if category not in ASYNC_VALIDATION_FAILURE_CATEGORIES:
        category = "internal_error"
    logger.warning("[sentinel:validation-worker] async_job_failed category=%s", category)


def log_sandbox_failure(stage: str) -> None:
    # This is intentionally restricted to fixed labels: never emit a request,
    # repository path, command output, exception text, or environment value.
    if stage not in SAFE_SANDBOX_FAILURE_STAGES:
        stage = "sandbox_result_invalid"
    logger.warning("[sentinel:validation-worker] %s", stage)


def log_lockfile_artifact_failure(reason: str) -> None:
    allowed = {
        "artifact_not_regular_file",
        "artifact_empty",
        "artifact_oversized",
        "artifact_read_failed",
        "artifact_size_mismatch",
        "artifact_invalid_json",
        "artifact_unsupported_lockfile_version",
        "artifact_dependency_mismatch",
    }
    logger.warning(
        "[sentinel:validation-worker] lockfile_artifact_unavailable reason=%s",
        reason if reason in allowed else "artifact_invalid",
    )


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
