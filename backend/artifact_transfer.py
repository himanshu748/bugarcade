"""Bounded evidence archive transport for the Modal browser runner.

The manifest is transport integrity metadata, never an assertion verdict.  The
cloud entrypoint has fixed paths and runs the existing privilege/limit bootstrap.
"""
import hashlib
import io
import json
import os
import re
import shutil
import stat
import struct
import sys
import tempfile
import zipfile
from pathlib import Path

MAX_FILES = 32
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_TOTAL_BYTES = 24 * 1024 * 1024
MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
KIND = "bugarcade-evidence-archive-v1"
NAME = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,119}\Z")
SHA256 = re.compile(r"[0-9a-f]{64}\Z")


class ArtifactError(ValueError):
    """Controlled transport failure; never a reproduced bug."""


def _safe_name(name):
    if not isinstance(name, str) or not NAME.fullmatch(name):
        raise ArtifactError("Evidence name is outside the supported flat filename vocabulary.")
    return name


def _hash(raw):
    return hashlib.sha256(raw).hexdigest()


def _regular_bytes(directory_fd, name, expected):
    # NONBLOCK prevents a substituted FIFO from blocking between lstat and open.
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or (before.st_dev, before.st_ino) != (expected.st_dev, expected.st_ino)
                or before.st_size != expected.st_size or before.st_size > MAX_FILE_BYTES):
            raise ArtifactError("Evidence file changed identity, is linked, or exceeds its limit.")
        raw = stream.read(MAX_FILE_BYTES + 1)
        after = os.fstat(stream.fileno())
        if (len(raw) != before.st_size or len(raw) > MAX_FILE_BYTES
                or (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                != (after.st_size, after.st_mtime_ns, after.st_ctime_ns)):
            raise ArtifactError("Evidence file changed while being captured.")
        return raw


def pack_directory(directory: Path | str, output: Path | str) -> dict:
    """Validate a flat evidence directory, then create one exclusive bounded ZIP.

    A real top-level ``video`` directory is ignored: Playwright's finalized
    ``recording.webm`` already lives at the root. No nested content is followed.
    Output must be a trusted caller-selected path and must not already exist.
    """
    directory, output = Path(directory), Path(output)
    directory_fd = None
    created = None
    try:
        directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        files = []
        payloads = {}
        total = 0
        entries_seen = 0
        with os.scandir(directory_fd) as entries:
            for entry in entries:
                entries_seen += 1
                if entries_seen > MAX_FILES + 1:
                    raise ArtifactError("Evidence directory exceeds its entry limit.")
                name = _safe_name(entry.name)
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode) and name == "video":
                    continue
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise ArtifactError("Evidence must contain unlinked regular files only.")
                if len(files) >= MAX_FILES or not 0 <= info.st_size <= MAX_FILE_BYTES:
                    raise ArtifactError("Evidence file count or size exceeds its limit.")
                total += info.st_size
                if total > MAX_TOTAL_BYTES:
                    raise ArtifactError("Evidence exceeds its total uncompressed size limit.")
                raw = _regular_bytes(directory_fd, name, info)
                files.append({"name": name, "bytes": len(raw), "sha256": _hash(raw)})
                payloads[name] = raw
        if not files:
            raise ArtifactError("Evidence directory has no files.")
        if len({row["name"].casefold() for row in files}) != len(files):
            raise ArtifactError("Evidence names collide on case-insensitive filesystems.")
        files.sort(key=lambda row: row["name"])
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as archive:
            for row in files:
                entry = zipfile.ZipInfo(row["name"])
                entry.create_system = 3
                entry.external_attr = (stat.S_IFREG | 0o600) << 16
                archive.writestr(entry, payloads[row["name"]], compress_type=zipfile.ZIP_DEFLATED,
                                 compresslevel=1)
        raw_archive = buffer.getvalue()
        if len(raw_archive) > MAX_ARCHIVE_BYTES:
            raise ArtifactError("Evidence archive exceeds its compressed wire limit.")
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        created = os.fstat(descriptor)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw_archive)
        return {"kind": KIND, "archiveBytes": len(raw_archive), "archiveSha256": _hash(raw_archive),
                "files": files}
    except ArtifactError:
        raise
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        raise ArtifactError("Evidence archive could not be safely captured.") from error
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
        # On failed writes, delete only the exact file this call created.
        if created is not None and sys.exc_info()[0] is not None:
            try:
                current = output.lstat()
                if (current.st_dev, current.st_ino) == (created.st_dev, created.st_ino):
                    output.unlink()
            except FileNotFoundError:
                pass


def _validate_manifest(manifest, raw):
    if (not isinstance(manifest, dict)
            or set(manifest) != {"kind", "archiveBytes", "archiveSha256", "files"}
            or manifest["kind"] != KIND or type(manifest["archiveBytes"]) is not int
            or manifest["archiveBytes"] != len(raw) or not isinstance(manifest["archiveSha256"], str)
            or not SHA256.fullmatch(manifest["archiveSha256"]) or _hash(raw) != manifest["archiveSha256"]):
        raise ArtifactError("Evidence archive identity does not match its manifest.")
    rows = manifest["files"]
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_FILES:
        raise ArtifactError("Evidence manifest file count exceeds its limit.")
    total = 0
    names = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {"name", "bytes", "sha256"}:
            raise ArtifactError("Evidence manifest file entry is invalid.")
        name = _safe_name(row["name"])
        if (name.casefold() in names or type(row["bytes"]) is not int
                or not 0 <= row["bytes"] <= MAX_FILE_BYTES or not isinstance(row["sha256"], str)
                or not SHA256.fullmatch(row["sha256"])):
            raise ArtifactError("Evidence manifest names, sizes or hashes are invalid.")
        names.add(name.casefold())
        total += row["bytes"]
        if total > MAX_TOTAL_BYTES:
            raise ArtifactError("Evidence manifest exceeds its total size limit.")
    return rows


def _preflight_zip_inventory(raw, count):
    """Bound central-directory parsing before ZipFile allocates member objects.

    Our small single-disk transport never needs ZIP64 or central-directory extras.
    A forged EOCD count cannot hide additional directory records from this check.
    """
    end = raw.rfind(b"PK\x05\x06", max(0, len(raw) - 65557))
    if end < 0 or end + 22 > len(raw):
        raise ArtifactError("Evidence ZIP end record is invalid.")
    _, disk, central_disk, disk_count, total_count, size, offset, comment = struct.unpack_from(
        "<4s4H2LH", raw, end)
    if (disk or central_disk or disk_count != total_count or total_count != count
            or not 1 <= total_count <= MAX_FILES or end + 22 + comment != len(raw)
            or offset + size != end):
        raise ArtifactError("Evidence ZIP central-directory limits are invalid.")
    position = offset
    for _ in range(total_count):
        if position + 46 > end or raw[position:position + 4] != b"PK\x01\x02":
            raise ArtifactError("Evidence ZIP central-directory entry is invalid.")
        name_bytes, extra_bytes, comment_bytes, start_disk = struct.unpack_from("<4H", raw, position + 28)
        if start_disk:
            raise ArtifactError("Multi-disk evidence ZIPs are unsupported.")
        position += 46 + name_bytes + extra_bytes + comment_bytes
        if position > end:
            raise ArtifactError("Evidence ZIP central-directory entry exceeds its boundary.")
    if position != end:
        raise ArtifactError("Evidence ZIP contains more entries than declared.")


def unpack_archive(raw: bytes, manifest: dict, dest: Path | str) -> list[str]:
    """Validate every member before atomically installing the complete directory.

    No extract/extractall is used. An existing empty destination is supported;
    an existing nonempty destination, symlink or file is preserved and rejected.
    """
    if not isinstance(raw, bytes) or not 1 <= len(raw) <= MAX_ARCHIVE_BYTES:
        raise ArtifactError("Evidence archive exceeds its compressed wire limit.")
    rows = _validate_manifest(manifest, raw)
    _preflight_zip_inventory(raw, len(rows))
    payloads = {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            members = archive.infolist()
            names = [info.filename for info in members]
            if (len(members) != len(rows) or len(set(names)) != len(names)
                    or set(names) != {row["name"] for row in rows}):
                raise ArtifactError("Evidence archive inventory differs from its manifest.")
            by_name = {row["name"]: row for row in rows}
            # Validate all metadata before decompressing any payload.
            for info in members:
                _safe_name(info.filename)
                expected = by_name[info.filename]
                mode = info.external_attr >> 16
                if (info.is_dir() or info.create_system != 3 or not stat.S_ISREG(mode)
                        or info.flag_bits & 1 or info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                        or info.file_size != expected["bytes"] or not 0 <= info.compress_size <= len(raw)):
                    raise ArtifactError("Evidence archive contains unsupported member metadata.")
            for info in members:
                expected = by_name[info.filename]
                with archive.open(info) as stream:
                    value = stream.read(expected["bytes"] + 1)
                if len(value) != expected["bytes"] or _hash(value) != expected["sha256"]:
                    raise ArtifactError("Evidence member size or hash differs from its manifest.")
                payloads[info.filename] = value
    except ArtifactError:
        raise
    except (OSError, ValueError, RuntimeError, NotImplementedError, zipfile.BadZipFile) as error:
        raise ArtifactError("Evidence ZIP could not be safely validated.") from error

    dest = Path(dest)
    staging = None
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.parent.is_symlink():
            raise ArtifactError("Evidence destination parent must not be a symlink.")
        try:
            current = dest.lstat()
        except FileNotFoundError:
            current = None
        if current is not None and (not stat.S_ISDIR(current.st_mode) or any(dest.iterdir())):
            raise ArtifactError("Evidence destination must be absent or an empty real directory.")
        staging = Path(tempfile.mkdtemp(prefix=".bugarcade-evidence-", dir=dest.parent))
        for name, value in payloads.items():
            descriptor = os.open(staging / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(value)
        os.replace(staging, dest)
        staging = None
    except ArtifactError:
        raise
    except OSError as error:
        raise ArtifactError("Validated evidence could not be installed atomically.") from error
    finally:
        if staging is not None:
            shutil.rmtree(staging)
    return sorted(payloads)


def main() -> int:
    if len(sys.argv) != 1:
        raise ArtifactError("Cloud evidence exporter accepts no path arguments.")
    if __package__:
        from .sandbox_entry import apply_limits, drop_privileges
    else:
        from sandbox_entry import apply_limits, drop_privileges
    drop_privileges()
    apply_limits()
    manifest = pack_directory("/tmp/evidence", "/tmp/evidence-export.zip")
    print(json.dumps(manifest, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
