import json
import tempfile
import unittest
from pathlib import Path

from worker.sandbox_agent import LockfileBindingError, apply_changes, verify_original_npm_lockfile_binding


class SandboxAgentTests(unittest.TestCase):
    def test_npm_lockfile_must_match_the_original_root_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text(json.dumps({"name": "example", "version": "1.0.0"}), "utf-8")
            (root / "package-lock.json").write_text(
                json.dumps({"lockfileVersion": 3, "packages": {"": {"name": "other", "version": "1.0.0"}}}),
                "utf-8",
            )

            with self.assertRaises(LockfileBindingError):
                verify_original_npm_lockfile_binding(root)

    def test_matching_npm_lockfile_allows_authorized_package_change(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text(
                json.dumps({"name": "example", "version": "1.0.0", "dependencies": {"example": "8.0.0"}}),
                "utf-8",
            )
            (root / "package-lock.json").write_text(
                json.dumps({"lockfileVersion": 3, "packages": {"": {"name": "example", "version": "1.0.0"}, "node_modules/example": {"version": "8.1.0"}}}),
                "utf-8",
            )
            job = {
                "dependencyType": "dependency",
                "proposedFix": {"files": [], "packageJsonChange": {"required": True, "dependency": "example", "from": "8.0.0", "to": "10.0.0"}},
            }

            verify_original_npm_lockfile_binding(root)
            apply_changes(root, job)

            package = json.loads((root / "package.json").read_text("utf-8"))
            self.assertEqual(package["dependencies"]["example"], "10.0.0")

    def test_v1_npm_lockfile_is_accepted_when_its_root_metadata_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package.json").write_text(json.dumps({"name": "example", "version": "1.0.0"}), "utf-8")
            (root / "package-lock.json").write_text(
                json.dumps({"name": "example", "version": "1.0.0", "lockfileVersion": 1}),
                "utf-8",
            )

            verify_original_npm_lockfile_binding(root)
    def test_package_json_change_uses_the_verified_dependency_section(self):
        sections = {
            "dependency": "dependencies",
            "devDependency": "devDependencies",
            "peerDependency": "peerDependencies",
            "optionalDependency": "optionalDependencies",
        }
        for dependency_type, section_name in sections.items():
            with self.subTest(dependency_type=dependency_type), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "package.json").write_text(
                    json.dumps({section_name: {"example": "1.0.0", "unrelated": "2.0.0"}}), "utf-8"
                )
                job = {
                    "dependencyType": dependency_type,
                    "proposedFix": {
                        "files": [],
                        "packageJsonChange": {
                            "required": True,
                            "dependency": "example",
                            "from": "1.0.0",
                            "to": "1.1.0",
                        },
                    },
                }

                apply_changes(root, job)

                package = json.loads((root / "package.json").read_text("utf-8"))
                self.assertEqual(package[section_name]["example"], "1.1.0")
                self.assertEqual(package[section_name]["unrelated"], "2.0.0")


if __name__ == "__main__":
    unittest.main()
