"""Trusted setup helper baked into the validation image, never supplied by a job."""

from __future__ import annotations

import json
import os
import stat
import sys
import zipfile
from pathlib import Path

MAX_EXTRACTED_BYTES = 100 * 1024 * 1024
DEPENDENCY_SECTIONS = {
    "dependency": "dependencies",
    "devDependency": "devDependencies",
    "peerDependency": "peerDependencies",
    "optionalDependency": "optionalDependencies",
}


class LockfileBindingError(ValueError):
    """A root package-lock.json did not match package.json before mutation."""


def safe_path(path: str) -> bool:
    return bool(path) and "\\" not in path and "\x00" not in path and not path.startswith("/") and all(part not in {"", ".", ".."} for part in path.split("/"))


def prepare(archive_path: Path, job_path: Path) -> None:
    job = json.loads(job_path.read_text("utf-8"))
    target = Path("/work/repo")
    target.mkdir(parents=True, exist_ok=True)
    extracted = 0
    with zipfile.ZipFile(archive_path) as archive:
        roots: set[str] = set()
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            if entry.flag_bits & 0x1 or stat.S_ISLNK(entry.external_attr >> 16) or not safe_path(entry.filename):
                raise ValueError("unsafe archive")
            pieces = entry.filename.split("/")
            if len(pieces) < 2:
                raise ValueError("archive has no wrapper directory")
            roots.add(pieces[0])
            extracted += entry.file_size
            if extracted > MAX_EXTRACTED_BYTES:
                raise ValueError("archive too large")
        if len(roots) != 1:
            raise ValueError("archive has multiple roots")
        root = next(iter(roots))
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            relative = entry.filename[len(root) + 1 :]
            if not safe_path(relative):
                raise ValueError("unsafe archive path")
            destination = target / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, destination.open("xb") as output:
                while chunk := source.read(64 * 1024):
                    output.write(chunk)
    if job["proposedFix"]["packageJsonChange"]["required"]:
        verify_original_npm_lockfile_binding(target)
    apply_changes(target, job)


def verify_original_npm_lockfile_binding(root: Path) -> None:
    """Verify the root npm lock belongs to this checkout before any edit.

    A missing lockfile is handled by the outer worker's package-manager
    detection. This guard only applies when an npm lockfile is present.
    """
    lockfile_path = root / "package-lock.json"
    if not lockfile_path.is_file():
        return
    try:
        package = json.loads((root / "package.json").read_text("utf-8"))
        lockfile = json.loads(lockfile_path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LockfileBindingError("invalid npm lockfile") from error
    lock_root = npm_lockfile_root(lockfile)
    if (
        not isinstance(package, dict)
        or not isinstance(lock_root, dict)
        or package.get("name") != lock_root.get("name")
        or package.get("version") != lock_root.get("version")
    ):
        raise LockfileBindingError("npm lockfile root mismatch")


def npm_lockfile_root(lockfile: object) -> dict | None:
    """Read root metadata from npm lockfile v1, v2, or v3 without guessing."""
    if not isinstance(lockfile, dict):
        return None
    packages = lockfile.get("packages")
    if isinstance(packages, dict) and isinstance(packages.get(""), dict):
        return packages[""]
    if "name" in lockfile and "version" in lockfile:
        return {"name": lockfile["name"], "version": lockfile["version"]}
    return None


def apply_changes(root: Path, job: dict) -> None:
    fix = job["proposedFix"]
    change = fix["packageJsonChange"]
    if change["required"]:
        package_json = root / "package.json"
        package = json.loads(package_json.read_text("utf-8"))
        section_name = DEPENDENCY_SECTIONS.get(job["dependencyType"])
        section = package.get(section_name) if section_name else None
        if not isinstance(section, dict) or section.get(change["dependency"]) != change["from"]:
            raise ValueError("package dependency binding failed")
        section[change["dependency"]] = change["to"]
        package_json.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", "utf-8")
    for edit in fix["files"]:
        path = edit["path"]
        if not safe_path(path) or path == "package.json":
            raise ValueError("unsafe patch path")
        destination = root / path
        content = destination.read_text("utf-8")
        original = edit["originalSnippet"]
        if not original or content.count(original) != 1:
            raise ValueError("source binding failed")
        destination.write_text(content.replace(original, edit["proposedSnippet"], 1), "utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit(2)
    try:
        prepare(Path(sys.argv[1]), Path(sys.argv[2]))
    except LockfileBindingError:
        # This fixed exit code is intentionally the only information passed to
        # the outer worker. It becomes the safe lockfile_update_failed result.
        raise SystemExit(3)
