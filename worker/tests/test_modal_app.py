import os
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from worker.core import sign
from worker.modal_app import create_api


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


if __name__ == "__main__":
    unittest.main()
