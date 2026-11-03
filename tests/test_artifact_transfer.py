"""Synthetic filesystem/ZIP security contracts; no provider calls or sandbox claims."""
import copy
import hashlib
import io
import os
import stat
import struct
import zipfile

import pytest

from backend import artifact_transfer as transport


@pytest.fixture
def capture(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "result.json").write_bytes(b'{"status":"failed"}')
    (source / "recording.webm").write_bytes(b"synthetic-test-bytes")
    (source / "console.json").write_bytes(b"[]")
    output = tmp_path / "evidence.zip"
    return source, output


def packed(capture):
    source, output = capture
    manifest = transport.pack_directory(source, output)
    return output.read_bytes(), manifest


def handmade(entries):
    buffer = io.BytesIO()
    rows = []
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, raw, mode in entries:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = mode << 16
            archive.writestr(info, raw)
            rows.append({"name": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    raw = buffer.getvalue()
    return raw, {"kind": transport.KIND, "archiveBytes": len(raw), "archiveSha256": hashlib.sha256(raw).hexdigest(), "files": rows}


def test_valid_roundtrip_ignores_only_real_video_directory(capture, tmp_path):
    source, output = capture
    (source / "video").mkdir()
    (source / "video" / "original.webm").write_bytes(b"nested-not-exported")
    raw, manifest = packed(capture)
    dest = tmp_path / "received"
    dest.mkdir()  # Runner currently creates an empty destination before transfer.
    names = transport.unpack_archive(raw, manifest, dest)
    assert names == ["console.json", "recording.webm", "result.json"]
    assert not (dest / "video").exists()
    for name in names:
        assert (dest / name).read_bytes() == (source / name).read_bytes()
        assert stat.S_IMODE((dest / name).stat().st_mode) == 0o600
    assert stat.S_IMODE(output.stat().st_mode) == 0o600


@pytest.mark.parametrize("kind", ["symlink-file", "symlink-video", "hardlink", "fifo", "directory"])
def test_pack_rejects_links_special_files_and_other_directories(capture, tmp_path, kind):
    source, output = capture
    outside = tmp_path / "outside"
    outside.write_bytes(b"must-not-be-exported")
    if kind == "symlink-file":
        (source / "escape.txt").symlink_to(outside)
    elif kind == "symlink-video":
        (source / "video").symlink_to(tmp_path, target_is_directory=True)
    elif kind == "hardlink":
        os.link(outside, source / "alias.txt")
    elif kind == "fifo":
        os.mkfifo(source / "pipe")
    else:
        (source / "nested").mkdir()
    with pytest.raises(transport.ArtifactError):
        transport.pack_directory(source, output)
    assert not output.exists()
    assert outside.read_bytes() == b"must-not-be-exported"


def test_pack_rejects_symlink_root(capture, tmp_path):
    source, output = capture
    link = tmp_path / "linked-root"
    link.symlink_to(source, target_is_directory=True)
    with pytest.raises(transport.ArtifactError):
        transport.pack_directory(link, output)
    assert not output.exists()


def test_pack_refuses_existing_output_without_overwriting(capture):
    source, output = capture
    output.write_bytes(b"keep")
    with pytest.raises(transport.ArtifactError):
        transport.pack_directory(source, output)
    assert output.read_bytes() == b"keep"


@pytest.mark.parametrize("limit,value", [("MAX_FILES", 2), ("MAX_FILE_BYTES", 4),
                                        ("MAX_TOTAL_BYTES", 5), ("MAX_ARCHIVE_BYTES", 32)])
def test_pack_enforces_count_and_size_ceilings(capture, monkeypatch, limit, value):
    source, output = capture
    monkeypatch.setattr(transport, limit, value)
    with pytest.raises(transport.ArtifactError):
        transport.pack_directory(source, output)
    assert not output.exists()


@pytest.mark.parametrize("name", ["../escape", "/absolute", "folder/file", "..", ".", "bad\\path", "bad:name", "é.txt"])
def test_unpack_rejects_unsafe_member_names(tmp_path, name):
    raw, manifest = handmade([(name, b"x", stat.S_IFREG | 0o600)])
    dest = tmp_path / "dest"
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, dest)
    assert not dest.exists()


def test_archive_hash_tamper_rejected_before_destination_change(capture, tmp_path):
    raw, manifest = packed(capture)
    dest = tmp_path / "dest"
    dest.mkdir()
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw[:-1] + bytes([raw[-1] ^ 1]), manifest, dest)
    assert list(dest.iterdir()) == []


def test_member_hash_tamper_rejected_without_partial_files(capture, tmp_path):
    raw, manifest = packed(capture)
    manifest["files"][-1]["sha256"] = "0" * 64
    dest = tmp_path / "dest"
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, dest)
    assert not dest.exists()


def test_crc_corruption_rejected_even_with_updated_archive_hash(tmp_path):
    raw, manifest = handmade([("result.json", b"hello", stat.S_IFREG | 0o600)])
    raw = raw.replace(b"hello", b"hEllo")
    manifest["archiveSha256"] = hashlib.sha256(raw).hexdigest()
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


def test_extra_member_inventory_rejected(capture, tmp_path):
    raw, manifest = packed(capture)
    manifest["files"].pop()
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


def test_duplicate_zip_member_rejected(tmp_path):
    with pytest.warns(UserWarning, match="Duplicate name"):
        raw, manifest = handmade([("same.txt", b"one", stat.S_IFREG | 0o600),
                                  ("same.txt", b"two", stat.S_IFREG | 0o600)])
    manifest["files"].pop()
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


def test_forged_small_eocd_count_cannot_hide_extra_records(tmp_path, monkeypatch):
    raw, manifest = handmade([("one.txt", b"one", stat.S_IFREG | 0o600),
                              ("two.txt", b"two", stat.S_IFREG | 0o600)])
    end = raw.rfind(b"PK\x05\x06")
    raw = raw[:end + 8] + struct.pack("<HH", 1, 1) + raw[end + 12:]
    manifest["files"].pop()
    manifest["archiveSha256"] = hashlib.sha256(raw).hexdigest()
    monkeypatch.setattr(transport.zipfile, "ZipFile", lambda *_: pytest.fail("Unbounded metadata parse reached"))
    with pytest.raises(transport.ArtifactError, match="more entries"):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


def test_excessive_eocd_count_rejected_before_zipfile_parse(capture, tmp_path, monkeypatch):
    raw, manifest = packed(capture)
    end = raw.rfind(b"PK\x05\x06")
    raw = raw[:end + 8] + struct.pack("<HH", 33, 33) + raw[end + 12:]
    manifest["archiveSha256"] = hashlib.sha256(raw).hexdigest()
    monkeypatch.setattr(transport.zipfile, "ZipFile", lambda *_: pytest.fail("Unbounded metadata parse reached"))
    with pytest.raises(transport.ArtifactError, match="central-directory limits"):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


@pytest.mark.parametrize("mode", [stat.S_IFLNK | 0o777, stat.S_IFDIR | 0o700, stat.S_IFIFO | 0o600])
def test_zip_symlink_directory_special_metadata_rejected(tmp_path, mode):
    raw, manifest = handmade([("payload", b"outside", mode)])
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


@pytest.mark.parametrize("mutation", ["count", "file-size", "total-size", "bool-size", "case-collision", "unknown-key"])
def test_manifest_untrusted_limits_and_schema(capture, tmp_path, monkeypatch, mutation):
    raw, manifest = packed(capture)
    if mutation == "count":
        monkeypatch.setattr(transport, "MAX_FILES", 2)
    elif mutation == "file-size":
        manifest["files"][0]["bytes"] = transport.MAX_FILE_BYTES + 1
    elif mutation == "total-size":
        monkeypatch.setattr(transport, "MAX_TOTAL_BYTES", 1)
    elif mutation == "bool-size":
        manifest["files"][0]["bytes"] = True
    elif mutation == "case-collision":
        manifest["files"].append({**manifest["files"][0], "name": manifest["files"][0]["name"].upper()})
    else:
        manifest["execute"] = "untrusted"
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


def test_wire_limit_applies_before_zip_open(capture, tmp_path, monkeypatch):
    raw, manifest = packed(capture)
    monkeypatch.setattr(transport, "MAX_ARCHIVE_BYTES", len(raw) - 1)
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, tmp_path / "dest")


def test_existing_nonempty_destination_is_preserved(capture, tmp_path):
    raw, manifest = packed(capture)
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "user-work").write_bytes(b"keep")
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, dest)
    assert sorted(p.name for p in dest.iterdir()) == ["user-work"]
    assert (dest / "user-work").read_bytes() == b"keep"


def test_destination_symlink_is_rejected(capture, tmp_path):
    raw, manifest = packed(capture)
    outside = tmp_path / "outside"
    outside.mkdir()
    dest = tmp_path / "linked"
    dest.symlink_to(outside, target_is_directory=True)
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, dest)
    assert dest.is_symlink() and list(outside.iterdir()) == []


def test_install_failure_does_not_leave_partial_destination(capture, tmp_path, monkeypatch):
    raw, manifest = packed(capture)
    dest = tmp_path / "dest"
    dest.mkdir()
    def fail_replace(*_):
        raise OSError("synthetic install failure")
    monkeypatch.setattr(transport.os, "replace", fail_replace)
    with pytest.raises(transport.ArtifactError):
        transport.unpack_archive(raw, manifest, dest)
    assert list(dest.iterdir()) == []
    assert not list(tmp_path.glob(".bugarcade-evidence-*"))


def test_manifest_copy_not_mutated_by_unpack(capture, tmp_path):
    raw, manifest = packed(capture)
    before = copy.deepcopy(manifest)
    transport.unpack_archive(raw, manifest, tmp_path / "dest")
    assert manifest == before
