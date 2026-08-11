import json
import base64
import subprocess
import time
import unittest
import zipfile
from io import BytesIO
from pathlib import Path

from worker.core import POLICY, ValidationError, inspect_github_zip, parse_and_validate_job, request_auth_failure_reason, sign, verify_signature, verify_timestamp


def job():
    return {"version": 1, "jobId": "4f15241e-8c5d-4a4a-8d8d-963402b51d4a", "repository": {"owner": "octo-org", "name": "example", "commitSha": "a" * 40}, "dependencyType": "dependency", "proposedFix": {"title": "Update", "summary": "Update package", "confidence": 90, "files": [], "packageJsonChange": {"required": True, "dependency": "example", "from": "1.0.0", "to": "1.1.0"}, "validationSteps": ["test"], "warnings": []}, "policy": POLICY}


class CoreTests(unittest.TestCase):
    def test_signature_is_exact_body_bound(self):
        payload = b'{"jobId":"example"}'
        signature = sign("shared secret", payload)
        self.assertTrue(verify_signature("shared secret", payload, signature))
        self.assertFalse(verify_signature("shared secret", payload + b" ", signature))

    def test_timestamp_rejects_stale_requests(self):
        now = time.time()
        self.assertTrue(verify_timestamp(str(int(now * 1000)), now=now))
        self.assertFalse(verify_timestamp(str(int((now - 301) * 1000)), now=now))

    def test_auth_failure_reasons_are_safe_and_specific(self):
        secret = "shared secret"
        body = b'{"jobId":"example"}'
        now = str(int(time.time() * 1000))
        signature = sign(secret, body)
        self.assertEqual(request_auth_failure_reason(secret, body, None, now), "missing_headers")
        self.assertEqual(request_auth_failure_reason(secret, body, signature, None), "missing_headers")
        self.assertEqual(request_auth_failure_reason(secret, body, signature, "not-a-timestamp"), "timestamp_invalid")
        self.assertEqual(request_auth_failure_reason(secret, body, signature, str(int((time.time() - 301) * 1000))), "timestamp_invalid")
        self.assertEqual(request_auth_failure_reason(secret, body, sign("other secret", body), now), "signature_mismatch")
        self.assertIsNone(request_auth_failure_reason(secret, body, signature, now))

    def test_typescript_contract_signature_is_accepted_by_python(self):
        root = Path(__file__).resolve().parents[2]
        secret = "cross-language fixture secret; not a production credential"
        payload = b'{"message":"caf\xc3\xa9","version":1}'
        script = """
import { signWorkerMessageSignature } from './lib/validation/worker-contract.ts';
const [secret, encodedPayload] = process.argv.slice(1);
console.log(signWorkerMessageSignature(secret, Buffer.from(encodedPayload, 'base64').toString('utf8')));
"""
        signature = subprocess.run(
            ["node", "--experimental-strip-types", "--input-type=module", "--eval", script, secret, base64.b64encode(payload).decode("ascii")],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        self.assertTrue(verify_signature(secret, payload, signature))

    def test_job_requires_exact_policy_and_safe_paths(self):
        parsed = parse_and_validate_job(job())
        self.assertEqual(parsed["repository"]["commitSha"], "a" * 40)
        bad = job()
        bad["policy"] = {"version": 1}
        with self.assertRaises(ValidationError):
            parse_and_validate_job(bad)
        traversal = job()
        traversal["proposedFix"]["files"] = [{"path": "../x", "reason": "r", "originalSnippet": "a", "proposedSnippet": "b"}]
        with self.assertRaises(ValidationError):
            parse_and_validate_job(traversal)

    def test_archive_rejects_symlinks_and_accepts_single_root(self):
        payload = BytesIO()
        with zipfile.ZipFile(payload, "w") as archive:
            archive.writestr("owner-repo-sha/package.json", "{}")
        self.assertEqual(inspect_github_zip(payload.getvalue()).root, "owner-repo-sha")
        unsafe = BytesIO()
        with zipfile.ZipFile(unsafe, "w") as archive:
            entry = zipfile.ZipInfo("owner-repo-sha/link")
            entry.external_attr = 0o120777 << 16
            archive.writestr(entry, "target")
        with self.assertRaises(ValidationError):
            inspect_github_zip(unsafe.getvalue())


if __name__ == "__main__":
    unittest.main()
