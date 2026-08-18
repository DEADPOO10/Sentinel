"""Pure-Python validation and integrity helpers for the Modal worker.

This module deliberately has no Modal or web-framework dependency so the
security-critical request handling can be unit-tested locally.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import stat
import time
import zipfile
from dataclasses import dataclass
from io import BytesIO
from typing import Any, Mapping

MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 3 * 1024 * 1024
MAX_ARCHIVE_COMPRESSED_BYTES = 25 * 1024 * 1024
MAX_ARCHIVE_EXTRACTED_BYTES = 100 * 1024 * 1024
MAX_COMMAND_OUTPUT_BYTES = 24 * 1024
REQUEST_MAX_AGE_SECONDS = 300
CHECK_NAMES = ("typecheck", "lint", "test", "build")
PACKAGE_MANAGERS = ("npm", "pnpm", "yarn")
ASYNC_VALIDATION_PROTOCOL_VERSION = 1
ASYNC_VALIDATION_FAILURE_CATEGORIES = (
    "worker_unavailable",
    "worker_timeout",
    "result_invalid",
    "job_expired",
    "internal_error",
)
COMMIT_RE = re.compile(r"^[a-fA-F0-9]{40,64}$")
UUID_RE = re.compile(r"^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[1-5][a-fA-F0-9]{3}-[89ab][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,100}$")
OWNER_RE = re.compile(r"^[A-Za-z0-9-]{1,39}$")

POLICY: dict[str, Any] = {
    "version": 1,
    "execution": {"nonRoot": True, "privileged": False, "readOnlyRootFilesystem": True, "ephemeralWorkspace": True, "cpuMillicores": 1000, "memoryMiB": 2048, "maxDurationMs": 300000, "maxCommandDurationMs": 120000, "maxCommandOutputBytes": 24576},
    "archive": {"maxCompressedBytes": MAX_ARCHIVE_COMPRESSED_BYTES, "maxExtractedBytes": MAX_ARCHIVE_EXTRACTED_BYTES, "rejectAbsolutePaths": True, "rejectParentTraversal": True, "rejectSymlinks": True},
    "network": {"install": {"mode": "allowlist", "hosts": ["registry.npmjs.org", "registry.yarnpkg.com"]}, "checks": {"mode": "disabled"}},
    "installScripts": "disabled",
    "allowedCommands": [["npm", "ci", "--ignore-scripts", "--no-audit", "--fund=false"], ["pnpm", "install", "--frozen-lockfile", "--ignore-scripts"], ["yarn", "install", "--immutable", "--ignore-scripts"], *[["$PACKAGE_MANAGER", "run", name, "--if-present"] for name in CHECK_NAMES]],
}


class ValidationError(ValueError):
    """A safe, public reason that must not include user-controlled content."""


@dataclass(frozen=True)
class ArchiveInfo:
    root: str
    compressed_bytes: int
    extracted_bytes: int


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sign(secret: str, body: bytes) -> str:
    return base64.urlsafe_b64encode(hmac.new(secret.encode("utf-8"), body, hashlib.sha256).digest()).rstrip(b"=").decode("ascii")


def verify_signature(secret: str, body: bytes, signature: str | None) -> bool:
    if not signature or not re.fullmatch(r"[A-Za-z0-9_-]{43}", signature):
        return False
    return hmac.compare_digest(sign(secret, body), signature)


def request_signed_message(timestamp: str, body: bytes) -> bytes:
    return b"v1\n" + timestamp.encode("ascii") + b"\n" + body


def sign_request(secret: str, timestamp: str, body: bytes) -> str:
    return sign(secret, request_signed_message(timestamp, body))


def verify_request_signature(secret: str, timestamp: str, body: bytes, signature: str | None) -> bool:
    try:
        signed_message = request_signed_message(timestamp, body)
    except UnicodeEncodeError:
        return False
    return verify_signature(secret, signed_message, signature)


def verify_timestamp(value: str | None, *, now: float | None = None) -> bool:
    if not value or not re.fullmatch(r"\d{13}", value):
        return False
    try:
        timestamp_ms = int(value)
    except ValueError:
        return False
    current = time.time() if now is None else now
    return abs(current - timestamp_ms / 1000) <= REQUEST_MAX_AGE_SECONDS


def request_auth_failure_reason(secret: str, body: bytes, signature: str | None, timestamp: str | None) -> str | None:
    """Return a fixed, non-sensitive request-authentication failure category."""
    if not signature or not timestamp:
        return "missing_headers"
    if not verify_timestamp(timestamp):
        return "timestamp_invalid"
    if not verify_request_signature(secret, timestamp, body, signature):
        return "signature_mismatch"
    return None


def safe_archive_path(path: str) -> bool:
    return bool(path) and len(path) <= 1024 and "\\" not in path and "\x00" not in path and not path.startswith("/") and all(part not in {"", ".", ".."} for part in path.split("/"))


def inspect_github_zip(data: bytes) -> ArchiveInfo:
    if len(data) > MAX_ARCHIVE_COMPRESSED_BYTES:
        raise ValidationError("archive_too_large")
    try:
        archive = zipfile.ZipFile(BytesIO(data))
    except zipfile.BadZipFile as error:
        raise ValidationError("invalid_archive") from error
    compressed = extracted = 0
    root: str | None = None
    for entry in archive.infolist():
        if entry.flag_bits & 0x1 or entry.is_dir():
            if entry.flag_bits & 0x1:
                raise ValidationError("encrypted_archive")
            continue
        if not safe_archive_path(entry.filename) or stat.S_ISLNK(entry.external_attr >> 16):
            raise ValidationError("unsafe_archive_path")
        parts = entry.filename.split("/")
        if len(parts) < 2:
            raise ValidationError("invalid_archive_layout")
        if root is None:
            root = parts[0]
        elif root != parts[0]:
            raise ValidationError("invalid_archive_layout")
        compressed += entry.compress_size
        extracted += entry.file_size
        if compressed > MAX_ARCHIVE_COMPRESSED_BYTES or extracted > MAX_ARCHIVE_EXTRACTED_BYTES:
            raise ValidationError("archive_too_large")
    if root is None:
        raise ValidationError("empty_archive")
    return ArchiveInfo(root=root, compressed_bytes=compressed, extracted_bytes=extracted)


def parse_and_validate_job(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"version", "jobId", "repository", "dependencyType", "proposedFix", "policy"}:
        raise ValidationError("invalid_job")
    if value["version"] != 1 or not isinstance(value["jobId"], str) or not UUID_RE.fullmatch(value["jobId"]):
        raise ValidationError("invalid_job")
    repository = value["repository"]
    if not isinstance(repository, dict) or set(repository) != {"owner", "name", "commitSha"} or not isinstance(repository.get("owner"), str) or not OWNER_RE.fullmatch(repository["owner"]) or not isinstance(repository.get("name"), str) or not NAME_RE.fullmatch(repository["name"]) or not isinstance(repository.get("commitSha"), str) or not COMMIT_RE.fullmatch(repository["commitSha"]):
        raise ValidationError("invalid_repository")
    if value["dependencyType"] not in {"dependency", "devDependency", "peerDependency", "optionalDependency"}:
        raise ValidationError("invalid_job")
    if value["policy"] != POLICY:
        raise ValidationError("policy_mismatch")
    fix = value["proposedFix"]
    if not isinstance(fix, dict) or set(fix) != {"title", "summary", "confidence", "files", "packageJsonChange", "validationSteps", "warnings"}:
        raise ValidationError("invalid_proposed_fix")
    if not _safe_text(fix["title"], 160) or not _safe_text(fix["summary"], 1000) or not isinstance(fix["confidence"], (int, float)) or isinstance(fix["confidence"], bool) or not 0 <= fix["confidence"] <= 100:
        raise ValidationError("invalid_proposed_fix")
    files = fix["files"]
    if not isinstance(files, list) or len(files) > 3:
        raise ValidationError("invalid_proposed_fix")
    paths: set[str] = set()
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "reason", "originalSnippet", "proposedSnippet"} or not isinstance(item.get("path"), str) or not safe_archive_path(item["path"]) or item["path"] == "package.json" or item["path"] in paths or not all(_safe_text(item.get(field), 2000) for field in ("reason", "originalSnippet", "proposedSnippet")):
            raise ValidationError("invalid_proposed_fix")
        paths.add(item["path"])
    change = fix["packageJsonChange"]
    if not isinstance(change, dict) or set(change) != {"required", "dependency", "from", "to"} or not isinstance(change.get("required"), bool) or not all(_safe_text(change.get(field), 300) for field in ("dependency", "from", "to")):
        raise ValidationError("invalid_proposed_fix")
    for field in ("validationSteps", "warnings"):
        entries = fix[field]
        if not isinstance(entries, list) or len(entries) > 8 or not all(_safe_text(item, 400) for item in entries):
            raise ValidationError("invalid_proposed_fix")
    return value


def parse_async_submit_request(value: Any) -> dict[str, Any]:
    """Validate the v2 submit envelope without changing the v1 job contract."""
    if not isinstance(value, dict) or set(value) != {"version", "operation", "validation"}:
        raise ValidationError("invalid_async_submit")
    if value["version"] != ASYNC_VALIDATION_PROTOCOL_VERSION or value["operation"] != "submit":
        raise ValidationError("invalid_async_submit")
    return parse_and_validate_job(value["validation"])


def parse_async_status_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"version", "operation", "jobId", "repository"}:
        raise ValidationError("invalid_async_status")
    repository = value.get("repository")
    if (
        value.get("version") != ASYNC_VALIDATION_PROTOCOL_VERSION
        or value.get("operation") != "status"
        or not isinstance(value.get("jobId"), str)
        or not UUID_RE.fullmatch(value["jobId"])
        or not isinstance(repository, dict)
        or set(repository) != {"commitSha"}
        or not isinstance(repository.get("commitSha"), str)
        or not COMMIT_RE.fullmatch(repository["commitSha"])
    ):
        raise ValidationError("invalid_async_status")
    return value


def validate_worker_result(value: Any, job_id: str, commit_sha: str) -> dict[str, Any]:
    """Validate a bounded final v1 result before durable async storage."""
    if not isinstance(value, dict):
        raise ValidationError("result_invalid")
    required = {"version", "jobId", "repository", "overallStatus", "install", "checks", "warnings", "partialReasons"}
    if frozenset(value) not in {frozenset(required), frozenset(required | {"artifact"})}:
        raise ValidationError("result_invalid")
    repository = value.get("repository")
    if (
        value.get("version") != 1
        or value.get("jobId") != job_id
        or not isinstance(repository, dict)
        or set(repository) != {"commitSha"}
        or not isinstance(repository.get("commitSha"), str)
        or repository["commitSha"].lower() != commit_sha.lower()
        or value.get("overallStatus") not in {"passed", "failed", "partial", "unable_to_validate"}
    ):
        raise ValidationError("result_invalid")
    install = value.get("install")
    if (
        not isinstance(install, dict)
        or set(install) != {"status", "summary"}
        or install.get("status") not in {"passed", "failed", "skipped"}
        or not _safe_text(install.get("summary"), 1000)
    ):
        raise ValidationError("result_invalid")
    checks = value.get("checks")
    if not isinstance(checks, list) or len(checks) != len(CHECK_NAMES):
        raise ValidationError("result_invalid")
    seen: set[str] = set()
    for check in checks:
        if (
            not isinstance(check, dict)
            or set(check) != {"name", "status", "durationMs", "summary"}
            or check.get("name") not in CHECK_NAMES
            or check["name"] in seen
            or check.get("status") not in {"passed", "failed", "skipped", "timed_out"}
            or not isinstance(check.get("durationMs"), int)
            or isinstance(check.get("durationMs"), bool)
            or not 0 <= check["durationMs"] <= 300000
            or not _safe_text(check.get("summary"), 1000)
        ):
            raise ValidationError("result_invalid")
        seen.add(check["name"])
    if seen != set(CHECK_NAMES):
        raise ValidationError("result_invalid")
    warnings = value.get("warnings")
    partial_reasons = value.get("partialReasons")
    if not isinstance(warnings, list) or len(warnings) > 12 or not all(_safe_text(item, 1000) for item in warnings):
        raise ValidationError("result_invalid")
    allowed_partial_reasons = {"skipped_checks", "no_lockfile_fallback", "cleanup_unconfirmed", "validation_timeout"}
    if (
        not isinstance(partial_reasons, list)
        or len(partial_reasons) > len(allowed_partial_reasons)
        or not all(isinstance(item, str) and item in allowed_partial_reasons for item in partial_reasons)
    ):
        raise ValidationError("result_invalid")
    if "artifact" in value:
        _validate_npm_lockfile_artifact(value["artifact"])
    if len(canonical_json(value)) > MAX_RESPONSE_BYTES:
        raise ValidationError("result_invalid")
    return value


def _validate_npm_lockfile_artifact(value: Any) -> None:
    if not isinstance(value, dict) or set(value) != {"kind", "path", "encoding", "content", "byteLength", "sha256"}:
        raise ValidationError("result_invalid")
    if value.get("kind") != "npm_package_lock" or value.get("path") != "package-lock.json" or value.get("encoding") != "base64":
        raise ValidationError("result_invalid")
    content = value.get("content")
    byte_length = value.get("byteLength")
    digest = value.get("sha256")
    if (
        not isinstance(content, str)
        or not isinstance(byte_length, int)
        or isinstance(byte_length, bool)
        or not 0 < byte_length <= 2 * 1024 * 1024
        or not isinstance(digest, str)
        or not re.fullmatch(r"[a-f0-9]{64}", digest)
    ):
        raise ValidationError("result_invalid")
    try:
        decoded = base64.b64decode(content, validate=True)
    except (ValueError, TypeError) as error:
        raise ValidationError("result_invalid") from error
    if len(decoded) != byte_length or hashlib.sha256(decoded).hexdigest() != digest:
        raise ValidationError("result_invalid")


def result_for_error(job: Mapping[str, Any] | None, summary: str, warning: str) -> dict[str, Any]:
    job_id = job.get("jobId") if job else "00000000-0000-4000-8000-000000000000"
    sha = job.get("repository", {}).get("commitSha") if job and isinstance(job.get("repository"), dict) else "0" * 40
    return {"version": 1, "jobId": job_id, "repository": {"commitSha": sha}, "overallStatus": "unable_to_validate", "install": {"status": "skipped", "summary": summary}, "checks": [{"name": name, "status": "skipped", "durationMs": 0, "summary": "Not run."} for name in CHECK_NAMES], "warnings": [warning], "partialReasons": []}


def _safe_text(value: Any, maximum: int) -> bool:
    return isinstance(value, str) and bool(value) and len(value) <= maximum
