"""Bounded sampled frames are investigation evidence, not proof of a reproduction."""
import asyncio
import json
import os
import resource
import signal
import sys
from pathlib import Path


class RecordingError(ValueError):
    pass


def _media_limits():
    resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    resource.setrlimit(resource.RLIMIT_FSIZE, (2 * 1024 * 1024, 2 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    if sys.platform.startswith("linux"):
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NPROC, (32, 32))


async def _run(*args: str, limit: int = 128 * 1024) -> bytes:
    environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C"}
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE,
                                                  stderr=asyncio.subprocess.PIPE, env=environment,
                                                  start_new_session=True, preexec_fn=_media_limits)

    async def bounded(stream):
        output = bytearray()
        while chunk := await stream.read(8192):
            output.extend(chunk)
            if len(output) > limit:
                raise RecordingError("Recording parser output exceeded its limit.")
        return bytes(output)

    try:
        async with asyncio.timeout(15):
            stdout, _ = await asyncio.gather(bounded(process.stdout), bounded(process.stderr))
            await process.wait()
            if process.returncode:
                raise RecordingError("Recording could not be decoded as MP4/WebM.")
            return stdout
    except TimeoutError as exc:
        raise RecordingError("Recording decoding timed out.") from exc
    finally:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if process.returncode is None:
            await process.wait()


async def extract_frames(path: Path, output: Path) -> dict:
    magic = path.read_bytes()[:16]
    if not (magic.startswith(b"\x1aE\xdf\xa3") or magic[4:8] == b"ftyp"):
        raise RecordingError("Recording content must be MP4 or WebM, not just renamed.")
    output.mkdir(parents=True, exist_ok=True)
    raw = await _run(sys.executable, "-I", str(Path(__file__).with_name("media_worker.py")),
                     str(path.resolve()), str(output.resolve()))
    try:
        metadata = json.loads(raw)
        if len(metadata["frames"]) != 4 or not 0 < metadata["durationSeconds"] <= 30:
            raise ValueError("Invalid media worker result")
        for frame in metadata["frames"]:
            target = Path(frame["path"])
            if (not target.resolve().is_relative_to(output.resolve()) or not target.is_file()
                    or target.stat().st_size > 1024 * 1024):
                raise ValueError("Invalid sampled frame")
    except (ValueError, KeyError, TypeError) as exc:
        raise RecordingError("Recording metadata/frames did not meet the bounded recording contract.") from exc
    return {**metadata, "interpretationLimit": "Four timestamped samples can miss fast interactions. Browser traces and assertions decide reproduction."}
