"""Trusted setup helper baked into the validation image, never supplied by a job."""

from __future__ import annotations

import json
import os
import stat
import sys
import zipfile
from pathlib import Path

MAX_EXTRACTED_BYTES = 100 * 1024 * 1024


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
    apply_changes(target, job)


def apply_changes(root: Path, job: dict) -> None:
    fix = job["proposedFix"]
    change = fix["packageJsonChange"]
    if change["required"]:
        package_json = root / "package.json"
        package = json.loads(package_json.read_text("utf-8"))
        section = package.get(job["dependencyType"] + "s")
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
    prepare(Path(sys.argv[1]), Path(sys.argv[2]))
