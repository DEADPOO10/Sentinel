import json
import hashlib
import os
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from worker.core import CHECK_NAMES, MAX_COMMAND_OUTPUT_BYTES, POLICY, ValidationError, canonical_json, sign, verify_signature
from worker.modal_app import CHECK_TIMEOUT_SECONDS, CLEANUP_RESERVE_SECONDS, MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES, MAX_RESULT_SUMMARY_CHARS, SANDBOX_AGENT_REMOTE_PATH, SANDBOX_USER_PREFIX, TOTAL_VALIDATION_DURATION_SECONDS, TRUNCATED_OUTPUT_NOTICE, VALIDATION_EXECUTION_BUDGET_SECONDS, cleanup_sandbox, command_summary, command_timeout_seconds, create_api, create_npm_package_lock_artifact, execute_job, install_argv, normalize_command_output, npm_lockfile_sync_argv, read_bounded_output, run_validation_checks, trusted_sandbox_agent_path


def valid_job():
    return {
        "version": 1,
        "jobId": "4f15241e-8c5d-4a4a-8d8d-963402b51d4a",
        "repository": {"owner": "octo-org", "name": "example", "commitSha": "a" * 40},
        "dependencyType": "dependency",
        "proposedFix": {
            "title": "Update example",
            "summary": "Update the dependency.",
            "confidence": 90,
            "files": [],
            "packageJsonChange": {"required": True, "dependency": "example", "from": "1.0.0", "to": "1.1.0"},
            "validationSteps": ["Run the repository test suite."],
            "warnings": [],
        },
        "policy": POLICY,
    }


class AioOnlyCall:
    """A Modal-shaped call which fails if the blocking API is used."""

    def __init__(self, *, return_value=None, side_effect=None):
        self.aio = AsyncMock(return_value=return_value, side_effect=side_effect)

    def __call__(self, *args, **kwargs):
        raise AssertionError("A blocking Modal interface was used in an async path")


class FakeStdout:
    def __init__(self, lines=()):
        self._lines = list(lines)

    def __aiter__(self):
        async def stream():
            for line in self._lines:
                yield line

        return stream()


class FakeProcess:
    def __init__(self, *, exit_code=0, output=""):
        self.stdout = FakeStdout([output] if output else [])
        self.wait = AioOnlyCall(return_value=exit_code)


class TimedOutProcess(FakeProcess):
    def __init__(self, *, output=""):
        super().__init__(output=output)
        self.wait = AioOnlyCall(side_effect=TimeoutError())


class FakeFileInfo:
    def __init__(self, path, size, *, regular=True):
        self.path = path
        self.size = size
        self._regular = regular

    def is_file(self):
        return self._regular


class FakeSandbox:
    def __init__(
        self,
        *,
        archive_upload_error=None,
        job_upload_error=None,
        agent_upload_error=None,
        lockfile_sync_exit=0,
        install_exit=0,
        lockfile_dependency_version="8.1.0",
        lockfile_root_name="example",
    ):
        scripts = {name: "node -e \"process.exit(0)\"" for name in CHECK_NAMES}
        package = {
            "name": "example",
            "version": "1.0.0",
            "dependencies": {"example": "1.1.0"},
            "scripts": scripts,
        }
        lockfile = {
            "name": lockfile_root_name,
            "version": "1.0.0",
            "lockfileVersion": 3,
            "packages": {
                "": {"name": lockfile_root_name, "version": "1.0.0", "dependencies": {"example": "1.1.0"}},
                "node_modules/example": {"version": lockfile_dependency_version},
            },
        }
        lockfile_bytes = json.dumps(lockfile).encode("utf-8")
        self.filesystem = SimpleNamespace(
            write_bytes=AioOnlyCall(side_effect=[archive_upload_error, job_upload_error]),
            copy_from_local=AioOnlyCall(side_effect=agent_upload_error),
            list_files=AioOnlyCall(return_value=[FakeFileInfo("/work/repo/package-lock.json", len(lockfile_bytes))]),
            read_bytes=AioOnlyCall(return_value=lockfile_bytes),
            read_text=AioOnlyCall(
                side_effect=[
                    json.dumps(package),
                    json.dumps(lockfile),
                    json.dumps(package),
                    json.dumps(lockfile),
                    json.dumps(package),
                    *[json.dumps(package) for _ in CHECK_NAMES],
                ]
            ),
        )
        self.exec = AioOnlyCall(
            side_effect=[
                FakeProcess(output="prepared"),
                FakeProcess(exit_code=lockfile_sync_exit, output="lockfile synchronized"),
                FakeProcess(exit_code=install_exit, output="installed"),
                *[FakeProcess(output=name) for name in CHECK_NAMES],
            ]
        )
        self._experimental_set_outbound_network_policy = AioOnlyCall()
        self.terminate = AioOnlyCall()
        self.detach = AioOnlyCall()


class ModalAppTests(unittest.TestCase):
    def test_unsigned_body_reaches_signature_authentication(self):
        """An HTTP request must not be mistaken for a required query parameter."""
        with patch.dict(
            os.environ,
            {"SENTINEL_VALIDATION_WORKER_SHARED_SECRET": "x" * 32},
            clear=False,
        ):
            response = TestClient(create_api()).post(
                "/v1/validations",
                content=b"{}",
                headers={"content-type": "application/json"},
            )

        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["warnings"], ["invalid_request_authentication"])

    def test_authentication_logs_safe_failure_categories(self):
        secret = "x" * 32
        body = b"{}"
        timestamp = str(int(time.time() * 1000))
        cases = [
            ({}, "missing_headers"),
            ({"x-sentinel-request-signature": sign(secret, body), "x-sentinel-request-timestamp": "invalid"}, "timestamp_invalid"),
            ({"x-sentinel-request-signature": sign("y" * 32, body), "x-sentinel-request-timestamp": timestamp}, "signature_mismatch"),
        ]
        with patch.dict(os.environ, {"SENTINEL_VALIDATION_WORKER_SHARED_SECRET": secret}, clear=False):
            client = TestClient(create_api())
            for headers, reason in cases:
                with self.assertLogs("sentinel.validation_worker", level="WARNING") as logs:
                    response = client.post("/v1/validations", content=body, headers={"content-type": "application/json", **headers})
                self.assertEqual(response.status_code, 401)
                self.assertEqual(logs.output, [f"WARNING:sentinel.validation_worker:validation request authentication rejected: reason={reason}"])

    def test_authenticated_async_failure_returns_a_signed_safe_stage_reason(self):
        secret = "x" * 32
        body = canonical_json(valid_job())
        headers = {
            "content-type": "application/json",
            "x-sentinel-request-signature": sign(secret, body),
            "x-sentinel-request-timestamp": str(int(time.time() * 1000)),
        }
        with patch.dict(os.environ, {"SENTINEL_VALIDATION_WORKER_SHARED_SECRET": secret}, clear=False), patch(
            "worker.modal_app.execute_job", new=AsyncMock(side_effect=ValidationError("sandbox_create_failed"))
        ):
            response = TestClient(create_api()).post("/v1/validations", content=body, headers=headers)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["overallStatus"], "unable_to_validate")
        self.assertEqual(response.json()["warnings"], ["sandbox_create_failed"])
        signature = response.headers["x-sentinel-worker-signature"]
        self.assertTrue(verify_signature(secret, response.content, signature))
        self.assertFalse(verify_signature(secret, response.content + b" ", signature))


class ModalAsyncExecutionTests(unittest.IsolatedAsyncioTestCase):
    def test_trusted_agent_path_requires_the_baked_outer_worker_file(self):
        from worker import modal_app

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "sandbox_agent.py"
            source.write_text("print('trusted')\n", "utf-8")
            with patch("worker.modal_app.TRUSTED_SANDBOX_AGENT_PATH", source):
                self.assertEqual(trusted_sandbox_agent_path(), source)

            with patch("worker.modal_app.TRUSTED_SANDBOX_AGENT_PATH", source.with_name("missing.py")):
                with self.assertRaisesRegex(FileNotFoundError, "trusted_agent_source_missing"):
                    trusted_sandbox_agent_path()

    async def test_create_sandbox_uses_the_async_modal_interface(self):
        from worker import modal_app

        fake_sandbox = object()
        create = AioOnlyCall(return_value=fake_sandbox)
        with patch("worker.modal_app.modal.Sandbox.create", new=create):
            result = await modal_app.create_sandbox(valid_job())

        self.assertIs(result, fake_sandbox)
        create.aio.assert_awaited_once()
        call = create.aio.await_args
        self.assertEqual(call.args[: len(SANDBOX_USER_PREFIX)], SANDBOX_USER_PREFIX)
        self.assertEqual(call.args[len(SANDBOX_USER_PREFIX) :], ("/usr/bin/sleep", "300"))
        self.assertEqual(call.kwargs["workdir"], "/work")
        self.assertEqual(call.kwargs["cpu"], (1.0, 1.0))
        self.assertEqual(call.kwargs["memory"], (2048, 2048))
        self.assertEqual(call.kwargs["timeout"], 300)
        self.assertEqual(call.kwargs["idle_timeout"], 300)
        self.assertEqual(call.kwargs["secrets"], [])
        self.assertEqual(call.kwargs["outbound_domain_allowlist"], ["registry.npmjs.org", "registry.yarnpkg.com"])
        self.assertEqual(call.kwargs["outbound_cidr_allowlist"], [])
        self.assertNotIn("env", call.kwargs)

    async def test_create_failure_logs_only_sanitized_sdk_metadata(self):
        from worker import modal_app

        class FakeModalError(Exception):
            _grpc_status = SimpleNamespace(name="INVALID_ARGUMENT")

        unsafe_values = (
            "do-not-log-token",
            "do-not-log-secret",
            "https://private.invalid/resource",
            "/private/customer/repository/file.js",
        )
        error = FakeModalError(
            f"token={unsafe_values[0]} SECRET_VALUE={unsafe_values[1]} "
            f"url={unsafe_values[2]} local file {unsafe_values[3]} does not exist"
        )
        create = AioOnlyCall(side_effect=error)
        with patch("worker.modal_app.modal.Sandbox.create", new=create), self.assertLogs(
            "sentinel.validation_worker", level="WARNING"
        ) as logs:
            with self.assertRaisesRegex(ValidationError, "sandbox_create_failed"):
                await modal_app.create_sandbox(valid_job())

        line = logs.output[0]
        self.assertIn("[sentinel:validation-worker] sandbox_create_failed", line)
        self.assertIn('"errorType":"FakeModalError"', line)
        self.assertIn('"modalStatus":"INVALID_ARGUMENT"', line)
        self.assertIn("<redacted>", line)
        self.assertIn("<url>", line)
        self.assertIn("<path>", line)
        for unsafe_value in unsafe_values:
            self.assertNotIn(unsafe_value, line)

    async def test_execute_job_uses_async_sandbox_apis_end_to_end(self):
        sandbox = FakeSandbox()
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ):
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "passed")
        self.assertIn("package_lock_synchronized_in_sandbox", result["warnings"])
        self.assertEqual(result["artifact"]["path"], "package-lock.json")
        self.assertEqual(result["artifact"]["byteLength"], len(sandbox.filesystem.read_bytes.aio.return_value))
        self.assertEqual(
            __import__("base64").b64decode(result["artifact"]["content"]),
            sandbox.filesystem.read_bytes.aio.return_value,
        )
        self.assertIn("regenerated only inside the isolated validation sandbox", result["install"]["summary"])
        self.assertEqual(result["repository"]["commitSha"], "a" * 40)
        self.assertEqual(sandbox.filesystem.write_bytes.aio.await_count, 2)
        sandbox.filesystem.copy_from_local.aio.assert_awaited_once_with(
            Path("/opt/sentinel/worker/sandbox_agent.py"), SANDBOX_AGENT_REMOTE_PATH
        )
        self.assertEqual(sandbox.exec.aio.await_count, 3 + len(CHECK_NAMES))
        calls = sandbox.exec.aio.await_args_list
        self.assertEqual(calls[1].args[len(SANDBOX_USER_PREFIX) :], tuple(npm_lockfile_sync_argv()))
        self.assertEqual(calls[2].args[len(SANDBOX_USER_PREFIX) :], tuple(install_argv("npm")))
        self.assertEqual(npm_lockfile_sync_argv(), ["npm", "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"])
        self.assertEqual(install_argv("npm"), ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"])
        for call in sandbox.exec.aio.await_args_list:
            self.assertEqual(call.args[: len(SANDBOX_USER_PREFIX)], SANDBOX_USER_PREFIX)
        self.assertEqual(sandbox.filesystem.list_files.aio.await_count, 2)
        self.assertTrue(all(call.args == ("/work/repo",) for call in sandbox.filesystem.list_files.aio.await_args_list))
        sandbox._experimental_set_outbound_network_policy.aio.assert_awaited_once_with(
            outbound_domain_allowlist=[], outbound_cidr_allowlist=[]
        )
        sandbox.terminate.aio.assert_awaited_once_with(wait=True)
        sandbox.detach.aio.assert_awaited_once()

    async def test_stale_npm_lockfile_is_synchronized_before_clean_install(self):
        sandbox = FakeSandbox(lockfile_dependency_version="8.1.0")
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ):
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "passed")
        commands = [
            call.args[len(SANDBOX_USER_PREFIX) :]
            for call in sandbox.exec.aio.await_args_list
        ]
        self.assertEqual(commands[1], tuple(npm_lockfile_sync_argv()))
        self.assertEqual(commands[2], tuple(install_argv("npm")))

    async def test_npm_lockfile_sync_failure_is_safe_and_does_not_install_or_run_scripts(self):
        sandbox = FakeSandbox(lockfile_sync_exit=1)
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ):
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "failed")
        self.assertEqual(result["warnings"], ["lockfile_update_failed"])
        self.assertNotIn("artifact", result)
        self.assertEqual(sandbox.exec.aio.await_count, 2)
        sandbox._experimental_set_outbound_network_policy.aio.assert_not_awaited()
        sandbox.terminate.aio.assert_awaited_once_with(wait=True)
        sandbox.detach.aio.assert_awaited_once()

    async def test_npm_ci_failure_after_lockfile_sync_keeps_install_failure_category(self):
        sandbox = FakeSandbox(install_exit=1)
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ):
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "failed")
        self.assertEqual(result["warnings"], ["dependency_install_failed"])
        self.assertNotIn("artifact", result)
        self.assertEqual(sandbox.exec.aio.await_count, 3)
        sandbox._experimental_set_outbound_network_policy.aio.assert_not_awaited()

    async def test_non_regular_lockfile_is_not_returned_but_validation_continues(self):
        sandbox = FakeSandbox()
        sandbox.filesystem.list_files = AioOnlyCall(
            side_effect=[
                [FakeFileInfo("/work/repo/package-lock.json", 100)],
                [FakeFileInfo("/work/repo/package-lock.json", 100, regular=False)],
            ]
        )
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ), self.assertLogs("sentinel.validation_worker", level="WARNING") as logs:
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "passed")
        self.assertNotIn("artifact", result)
        self.assertIn("validated_lockfile_artifact_unavailable", result["warnings"])
        self.assertIn("reason=artifact_not_regular_file", logs.output[0])

    async def test_non_npm_repository_never_returns_a_package_lock_artifact(self):
        sandbox = FakeSandbox()
        package = {
            "name": "example",
            "version": "1.0.0",
            "dependencies": {"example": "1.1.0"},
            "scripts": {name: "node -e \"process.exit(0)\"" for name in CHECK_NAMES},
        }
        sandbox.filesystem.list_files = AioOnlyCall(return_value=[FakeFileInfo("/work/repo/yarn.lock", 100)])
        sandbox.filesystem.read_text = AioOnlyCall(return_value=json.dumps(package))
        sandbox.exec = AioOnlyCall(side_effect=[
            FakeProcess(output="prepared"),
            FakeProcess(output="installed"),
            *[FakeProcess(output=name) for name in CHECK_NAMES],
        ])
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ):
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "passed")
        self.assertNotIn("artifact", result)
        self.assertEqual(sandbox.filesystem.read_bytes.aio.await_count, 0)

    async def test_unsafe_post_sync_edit_verification_never_reaches_artifact_collection(self):
        sandbox = FakeSandbox()
        binding_checks = AsyncMock(side_effect=[None, ValidationError("lockfile_update_failed")])
        artifact_collection = AsyncMock()
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ), patch("worker.modal_app.verify_npm_lockfile_binding", new=binding_checks), patch(
            "worker.modal_app.collect_npm_package_lock_artifact", new=artifact_collection
        ):
            with self.assertRaisesRegex(ValidationError, "lockfile_update_failed"):
                await execute_job(valid_job())

        artifact_collection.assert_not_awaited()
        sandbox.terminate.aio.assert_awaited_once_with(wait=True)
        sandbox.detach.aio.assert_awaited_once()

    def test_artifact_contains_exact_bounded_bytes_and_sha256(self):
        package = json.dumps({"name": "example", "version": "1.0.0", "dependencies": {"example": "1.1.0"}})
        raw = json.dumps({
            "name": "example",
            "version": "1.0.0",
            "lockfileVersion": 3,
            "packages": {"": {"name": "example", "version": "1.0.0", "dependencies": {"example": "1.1.0"}}},
        }, separators=(",", ":")).encode("utf-8")

        artifact = create_npm_package_lock_artifact(raw, package, valid_job())

        self.assertEqual(artifact["kind"], "npm_package_lock")
        self.assertEqual(artifact["path"], "package-lock.json")
        self.assertEqual(artifact["byteLength"], len(raw))
        self.assertEqual(artifact["sha256"], hashlib.sha256(raw).hexdigest())
        self.assertEqual(__import__("base64").b64decode(artifact["content"]), raw)

    def test_empty_and_oversized_artifacts_are_rejected_without_truncation(self):
        package = json.dumps({"name": "example", "version": "1.0.0", "dependencies": {"example": "1.1.0"}})
        with self.assertRaisesRegex(ValidationError, "artifact_empty"):
            create_npm_package_lock_artifact(b"", package, valid_job())
        with self.assertRaisesRegex(ValidationError, "artifact_oversized"):
            create_npm_package_lock_artifact(b"x" * (MAX_NPM_PACKAGE_LOCK_ARTIFACT_BYTES + 1), package, valid_job())

    async def test_egress_is_locked_only_after_resolution_and_before_repository_scripts(self):
        sandbox = FakeSandbox()
        events: list[str] = []

        async def record_command(_sandbox, argv, _timeout, *, name=None):
            if argv == npm_lockfile_sync_argv():
                events.append("lockfile_sync")
                return {"status": "passed", "summary": "synchronized"}
            if argv == install_argv("npm"):
                events.append("clean_install")
                return {"status": "passed", "summary": "installed"}
            events.append(f"script:{name}")
            return {"name": name, "status": "passed", "durationMs": 1, "summary": "passed"}

        async def record_lockdown(_sandbox):
            events.append("egress_locked")

        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ), patch("worker.modal_app.run_command", new=record_command), patch(
            "worker.modal_app.disable_sandbox_egress", new=record_lockdown
        ):
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "passed")
        self.assertEqual(events[:3], ["lockfile_sync", "clean_install", "egress_locked"])
        self.assertTrue(all(events.index("egress_locked") < index for index, value in enumerate(events) if value.startswith("script:")))

    async def test_timed_out_test_is_partial_and_later_build_continues(self):
        sandbox = FakeSandbox()
        executed: list[str] = []

        async def record_command(_sandbox, argv, _timeout, *, name=None):
            if name is None:
                return {"status": "passed", "summary": "installed"}
            executed.append(name)
            return {"name": name, "status": "timed_out" if name == "test" else "passed", "durationMs": 1, "summary": "Tests exceeded the isolated validation time budget." if name == "test" else "passed"}

        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ), patch("worker.modal_app.run_command", new=record_command):
            result = await execute_job(valid_job())

        self.assertEqual(executed, list(CHECK_NAMES))
        self.assertEqual(result["overallStatus"], "partial")
        self.assertIn("validation_timeout", result["partialReasons"])
        self.assertIn("validation_check_timed_out", result["warnings"])
        self.assertEqual(result["checks"][2]["status"], "timed_out")
        self.assertEqual(result["checks"][3]["status"], "passed")

    async def test_failed_check_remains_failed_even_after_an_earlier_timeout(self):
        sandbox = FakeSandbox()

        async def record_command(_sandbox, argv, _timeout, *, name=None):
            if name is None:
                return {"status": "passed", "summary": "installed"}
            status = "timed_out" if name == "test" else ("failed" if name == "build" else "passed")
            return {"name": name, "status": status, "durationMs": 1, "summary": "result"}

        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ), patch("worker.modal_app.run_command", new=record_command):
            result = await execute_job(valid_job())

        self.assertEqual(result["overallStatus"], "failed")
        self.assertIn("validation_check_failed", result["warnings"])
        self.assertNotIn("validation_timeout", result["partialReasons"])
        self.assertEqual(result["checks"][2]["status"], "timed_out")
        self.assertEqual(result["checks"][3]["status"], "failed")

    async def test_global_budget_skips_remaining_checks_without_running_scripts(self):
        sandbox = FakeSandbox()
        checks, timed_out, deadline_reached, failed, missing_script = await run_validation_checks(
            sandbox, "npm", time.monotonic() - 1
        )

        self.assertTrue(deadline_reached)
        self.assertFalse(timed_out)
        self.assertFalse(failed)
        self.assertFalse(missing_script)
        self.assertEqual([check["status"] for check in checks], ["skipped"] * len(CHECK_NAMES))
        self.assertEqual(sandbox.exec.aio.await_count, 0)

    async def test_lint_failure_stops_later_checks_as_a_definitive_failure(self):
        sandbox = FakeSandbox()
        executed: list[str] = []

        async def record_command(_sandbox, _argv, _timeout, *, name=None):
            executed.append(name or "setup")
            return {"name": name, "status": "failed" if name == "lint" else "passed", "durationMs": 1, "summary": "result"}

        with patch("worker.modal_app.has_package_script", new=AsyncMock(return_value=True)), patch(
            "worker.modal_app.run_command", new=record_command
        ):
            checks, _timed_out, _deadline_reached, failed, _missing_script = await run_validation_checks(
                sandbox, "npm", time.monotonic() + 1_000
            )

        self.assertEqual(executed, ["typecheck", "lint"])
        self.assertTrue(failed)
        self.assertEqual([check["status"] for check in checks], ["passed", "failed", "skipped", "skipped"])

    async def test_missing_typecheck_script_is_skipped_without_running_it(self):
        sandbox = FakeSandbox()
        executed: list[str] = []

        async def has_script(_sandbox, name):
            return name != "typecheck"

        async def record_command(_sandbox, _argv, _timeout, *, name=None):
            executed.append(name)
            return {"name": name, "status": "passed", "durationMs": 1, "summary": "passed"}

        with patch("worker.modal_app.has_package_script", new=has_script), patch(
            "worker.modal_app.run_command", new=record_command
        ):
            checks, _timed_out, _deadline_reached, _failed, missing_script = await run_validation_checks(
                sandbox, "npm", time.monotonic() + 1_000
            )

        self.assertTrue(missing_script)
        self.assertEqual(checks[0]["status"], "skipped")
        self.assertEqual(executed, ["lint", "test", "build"])

    async def test_test_failure_is_a_definitive_failure(self):
        sandbox = FakeSandbox()

        async def record_command(_sandbox, _argv, _timeout, *, name=None):
            return {"name": name, "status": "failed" if name == "test" else "passed", "durationMs": 1, "summary": "result"}

        with patch("worker.modal_app.has_package_script", new=AsyncMock(return_value=True)), patch(
            "worker.modal_app.run_command", new=record_command
        ):
            checks, timed_out, _deadline_reached, failed, _missing_script = await run_validation_checks(
                sandbox, "npm", time.monotonic() + 1_000
            )

        self.assertTrue(failed)
        self.assertFalse(timed_out)
        self.assertEqual([check["status"] for check in checks], ["passed", "passed", "failed", "skipped"])

    def test_command_timeouts_are_capped_and_leave_cleanup_reserve(self):
        self.assertEqual(TOTAL_VALIDATION_DURATION_SECONDS - VALIDATION_EXECUTION_BUDGET_SECONDS, CLEANUP_RESERVE_SECONDS)
        with patch("worker.modal_app.time.monotonic", return_value=100.0):
            self.assertEqual(command_timeout_seconds(220.0, CHECK_TIMEOUT_SECONDS["test"]), 120)
            self.assertEqual(command_timeout_seconds(101.0, CHECK_TIMEOUT_SECONDS["test"]), 1)
            self.assertEqual(command_timeout_seconds(100.0, CHECK_TIMEOUT_SECONDS["test"]), 0)

    async def test_trusted_agent_lockfile_binding_exit_becomes_safe_lockfile_failure(self):
        sandbox = FakeSandbox()
        sandbox.exec = AioOnlyCall(side_effect=[FakeProcess(exit_code=3, output="")])

        with self.assertRaisesRegex(ValidationError, "lockfile_update_failed"):
            from worker import modal_app

            await modal_app.prepare_sandbox_workspace(sandbox)

    async def test_upload_failure_has_a_safe_stage_and_still_attempts_cleanup(self):
        unsafe_error = RuntimeError(
            "token=do-not-log-token SECRET_VALUE=do-not-log-secret "
            "https://private.invalid/source /private/customer/agent.py"
        )
        sandbox = FakeSandbox(agent_upload_error=unsafe_error)
        with patch("worker.modal_app.fetch_verified_archive", return_value=b"checked archive"), patch(
            "worker.modal_app.inspect_github_zip"
        ), patch("worker.modal_app.create_sandbox", new=AsyncMock(return_value=sandbox)), patch(
            "worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")
        ), self.assertLogs(
            "sentinel.validation_worker", level="WARNING"
        ) as logs:
            with self.assertRaisesRegex(ValidationError, "sandbox_upload_failed"):
                await execute_job(valid_job())

        line = logs.output[0]
        self.assertIn("[sentinel:validation-worker] sandbox_upload_failed", line)
        self.assertIn('"destination":"trusted_agent"', line)
        self.assertIn('"errorType":"RuntimeError"', line)
        self.assertIn("<redacted>", line)
        self.assertIn("<url>", line)
        self.assertIn("<path>", line)
        for unsafe_value in ("do-not-log-token", "do-not-log-secret", "private.invalid", "/private/customer/agent.py"):
            self.assertNotIn(unsafe_value, line)
        sandbox.terminate.aio.assert_awaited_once_with(wait=True)
        sandbox.detach.aio.assert_awaited_once()

    async def test_agent_upload_permission_failure_is_safe(self):
        sandbox = FakeSandbox(agent_upload_error=PermissionError("permission denied"))
        with patch("worker.modal_app.trusted_sandbox_agent_path", return_value=Path("/opt/sentinel/worker/sandbox_agent.py")), self.assertLogs(
            "sentinel.validation_worker", level="WARNING"
        ) as logs:
            with self.assertRaisesRegex(ValidationError, "sandbox_upload_failed"):
                from worker import modal_app

                await modal_app.upload_sandbox_inputs(sandbox, b"archive", valid_job())

        self.assertIn('"destination":"trusted_agent"', logs.output[0])
        self.assertIn('"errorType":"PermissionError"', logs.output[0])
        sandbox.filesystem.copy_from_local.aio.assert_awaited_once()

    async def test_cleanup_detaches_even_when_termination_fails(self):
        sandbox = FakeSandbox()
        sandbox.terminate.aio.side_effect = RuntimeError("sensitive detail")
        with self.assertLogs("sentinel.validation_worker", level="WARNING") as logs:
            self.assertFalse(await cleanup_sandbox(sandbox))

        self.assertEqual(logs.output, ["WARNING:sentinel.validation_worker:[sentinel:validation-worker] sandbox_cleanup_failed"])
        sandbox.terminate.aio.assert_awaited_once_with(wait=True)
        sandbox.detach.aio.assert_awaited_once()

    async def test_verbose_output_is_drained_and_truncated_without_a_sandbox_kill(self):
        captured = await read_bounded_output(FakeProcess(output="x" * (MAX_COMMAND_OUTPUT_BYTES + 1)))

        self.assertTrue(captured.truncated)
        self.assertIn("... output truncated by Sentinel ...", captured.text)
        self.assertLessEqual(len(captured.text.encode("utf-8")), MAX_COMMAND_OUTPUT_BYTES)
        self.assertLessEqual(len(command_summary(captured, failure_or_timeout=False)), MAX_RESULT_SUMMARY_CHARS)

    async def test_output_under_the_limit_is_unchanged(self):
        original = "Mocha output\nall tests passed\n"
        captured = await read_bounded_output(FakeProcess(output=original))

        self.assertFalse(captured.truncated)
        self.assertEqual(captured.text, original.strip())
        self.assertEqual(command_summary(captured, failure_or_timeout=False), original.strip())

    async def test_huge_failing_output_retains_final_failure_in_summary(self):
        failure = "FAILURE: AssertionError: expected 200 to equal 201\n    at test/api.js:42:7\n2 failing"
        captured = await read_bounded_output(FakeProcess(output=("  ✓ passing test\n" * 3_000) + failure))
        summary = command_summary(captured, failure_or_timeout=True)

        self.assertTrue(captured.truncated)
        self.assertIn("... output truncated by Sentinel ...", captured.text)
        self.assertIn("AssertionError: expected 200 to equal 201", captured.tail)
        self.assertIn("AssertionError: expected 200 to equal 201", summary)
        self.assertIn(TRUNCATED_OUTPUT_NOTICE, summary)
        self.assertLessEqual(len(captured.text.encode("utf-8")), MAX_COMMAND_OUTPUT_BYTES)
        self.assertLessEqual(len(summary), MAX_RESULT_SUMMARY_CHARS)

    async def test_huge_timeout_output_retains_final_tail(self):
        failure = "Timeout diagnostic: tests were still running after the allotted time."
        sandbox = SimpleNamespace(exec=AioOnlyCall(return_value=TimedOutProcess(output=("passing\n" * 4_000) + failure)))
        from worker import modal_app

        result = await modal_app.run_command(sandbox, ["npm", "run", "test", "--if-present"], 120, name="test")

        self.assertEqual(result["status"], "timed_out")
        self.assertIn(failure, result["summary"])
        self.assertIn(TRUNCATED_OUTPUT_NOTICE, result["summary"])
        self.assertLessEqual(len(result["summary"]), MAX_RESULT_SUMMARY_CHARS)

    async def test_multibyte_output_remains_valid_and_bounded(self):
        failure = "FAILURE: अपेक्षित परिणाम नहीं मिला 🚨"
        captured = await read_bounded_output(FakeProcess(output=("✅ passing\n" * 4_000) + failure))
        summary = command_summary(captured, failure_or_timeout=True)

        self.assertIn(failure, summary)
        self.assertLessEqual(len(captured.text.encode("utf-8")), MAX_COMMAND_OUTPUT_BYTES)
        self.assertLessEqual(len(summary), MAX_RESULT_SUMMARY_CHARS)
        self.assertNotIn("\ufffd", summary)

    async def test_command_diagnostics_do_not_add_data_not_present_in_output(self):
        captured = await read_bounded_output(FakeProcess(output=("passing\n" * 4_000) + "FAILURE: expected false to be true"))
        summary = command_summary(captured, failure_or_timeout=True)

        self.assertNotIn("not-a-real-secret", captured.text)
        self.assertNotIn("not-a-real-secret", summary)

    async def test_timed_out_command_summary_is_bounded_and_ansi_clean(self):
        sandbox = SimpleNamespace(exec=AioOnlyCall(return_value=TimedOutProcess(output="\x1b[31mverbose output\x1b[0m")))
        from worker import modal_app

        result = await modal_app.run_command(sandbox, ["npm", "run", "test", "--if-present"], 120, name="test")

        self.assertEqual(result["status"], "timed_out")
        self.assertLessEqual(len(result["summary"]), MAX_RESULT_SUMMARY_CHARS)
        self.assertNotIn("\x1b", result["summary"])

    def test_command_output_removes_ansi_and_control_sequences(self):
        output = normalize_command_output("\x1b[1G\x1b[0K\x1b[31mnpm error\x1b[39m\r\nnext\x07\ufffd[1G")

        self.assertEqual(output, "npm error\nnext")


if __name__ == "__main__":
    unittest.main()
