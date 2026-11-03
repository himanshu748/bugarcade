"""Validate all ZIP members before creating any project files; never invoke submitted build scripts."""
import hashlib
import io
import json
import re
import stat
import zipfile
from pathlib import Path, PurePosixPath

from backend.schemas import Manifest

MAX_EXPANDED = 400 * 1024
FILES = {"buggy/App.tsx", "fixed/App.tsx", "manifest.json", "README.md"}
REQUIRED = FILES - {"README.md"}


class InvalidProject(ValueError):
    pass


def validate_archive(raw: bytes) -> tuple[Manifest, dict[str, str], dict[str, str]]:
    if len(raw) > 256 * 1024:
        raise InvalidProject("Project ZIP must be at most 256 KiB.")
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            if not 3 <= len(members) <= 8:
                raise InvalidProject("ZIP must contain exactly the starter files, with optional directory entries.")
            total = 0
            names: set[str] = set()
            for member in members:
                name = member.filename
                path = PurePosixPath(name)
                mode = member.external_attr >> 16
                if ("\\" in name or path.is_absolute() or ".." in path.parts or "\x00" in name
                        or stat.S_ISLNK(mode) or member.flag_bits & 1):
                    raise InvalidProject("Unsafe ZIP path, symbolic link or encrypted member.")
                if member.is_dir():
                    if name not in {"buggy/", "fixed/"}:
                        raise InvalidProject("Unsupported ZIP directory.")
                    continue
                if name not in FILES or name in names:
                    raise InvalidProject("Unsupported or duplicate ZIP member. Only starter v1 files are allowed.")
                names.add(name)
                total += member.file_size
                if (member.file_size > 180 * 1024 or total > MAX_EXPANDED
                        or member.file_size > max(member.compress_size, 1) * 100):
                    raise InvalidProject("Expanded ZIP size or compression ratio exceeds the limit.")
            if not REQUIRED.issubset(names):
                raise InvalidProject("Required: buggy/App.tsx, fixed/App.tsx, manifest.json.")
            files = {name: archive.read(name).decode("utf-8") for name in names}
    except (zipfile.BadZipFile, UnicodeDecodeError, RuntimeError, NotImplementedError) as exc:
        raise InvalidProject("Project must be a valid UTF-8 starter ZIP.") from exc
    try:
        manifest = Manifest.model_validate_json(files["manifest.json"])
    except ValueError as exc:
        raise InvalidProject("manifest.json does not match starter v1. See /api/starter.") from exc
    for name in ("buggy/App.tsx", "fixed/App.tsx"):
        source = files[name]
        if len(source.encode()) > 65_536:
            raise InvalidProject(f"{name} exceeds the starter's 64 KiB source limit.")
        # Deliberately conservative compatibility gate, not the sandbox security boundary.
        if "export default" not in source:
            raise InvalidProject(f"{name} must default-export an App component.")
        if re.search(r"\b(?:require|import)\s*\(", source):
            raise InvalidProject("Dynamic imports and require are outside starter v1.")
        imports = re.findall(r"\b(?:from\s*|import\s*)['\"]([^'\"]+)['\"]", source)
        if any(value not in {"react", "react/jsx-runtime"} for value in imports):
            raise InvalidProject("Only react and react/jsx-runtime imports are supported.")
        if re.search(r"\b(?:process|Deno|Bun)\s*\.", source):
            raise InvalidProject("Server runtime globals are outside starter v1.")
    hashes = {name: hashlib.sha256(value.encode()).hexdigest() for name, value in files.items()}
    return manifest, files, hashes


def write_project(path: Path, files: dict[str, str]) -> None:
    path.mkdir(parents=True, exist_ok=False)
    for name, value in files.items():
        target = path / name  # all names have already passed exact allowlist
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)


def seed_manifest(data: dict) -> Manifest:
    # Metadata belongs to the gallery; only the execution fields enter a trusted run.
    fields = set(Manifest.model_fields)
    selected = {key: value for key, value in data.items() if key in fields}
    if "allowedTargets" not in selected:
        selected["allowedTargets"] = sorted({a["target"] for a in data.get("actions", []) + data.get("initialActions", []) if "target" in a}
                                            | {data["assertion"]["target"], data["completion"]["target"]})
    return Manifest.model_validate(selected)


def make_starter(root: Path) -> bytes:
    challenges = json.loads((root / "shared/challenges.json").read_text())
    raw = next(value for value in challenges if value["id"] == "lost-note")
    manifest = seed_manifest(raw)
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for variant in ("buggy", "fixed"):
            path = root / "fixtures" / "lost-note" / variant / "App.tsx"
            if not path.exists():
                path = root / "fixtures" / "lost-note" / f"{variant}.tsx"
            archive.writestr(f"{variant}/App.tsx", path.read_text())
        archive.writestr("manifest.json", manifest.model_dump_json(indent=2))
        archive.writestr("README.md", "Starter v1: default App({api}), only React imports, declared data-testid controls. Supply both buggy and fixed files. Do not include package.json or scripts. Recording is separate.\n")
    return output.getvalue()
