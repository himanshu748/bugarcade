"""Synthetic video tests exercise actual pinned PyAV decoding, not model/provider behavior."""
import asyncio
from pathlib import Path

import av
import pytest

from backend.recording import RecordingError, extract_frames


def make_video(path: Path, duration=1):
    codec = "mpeg4" if path.suffix == ".mp4" else "libvpx-vp9"
    with av.open(str(path), "w") as output:
        stream = output.add_stream(codec, rate=10)
        stream.width, stream.height, stream.pix_fmt = 64, 48, "yuv420p"
        for index in range(duration * 10):
            frame = av.VideoFrame(64, 48, "rgb24")
            frame.planes[0].update(bytes([index % 255]) * frame.planes[0].buffer_size)
            frame.pts = index
            for packet in stream.encode(frame):
                output.mux(packet)
        for packet in stream.encode():
            output.mux(packet)


@pytest.mark.parametrize("suffix", [".mp4", ".webm"])
def test_real_decoder_outputs_four_timestamped_samples(tmp_path, suffix):
    source = tmp_path / ("synthetic" + suffix)
    make_video(source)
    result = asyncio.run(extract_frames(source, tmp_path / "frames"))
    assert result["durationSeconds"] == pytest.approx(1, abs=0.15)
    assert len(result["frames"]) == 4
    stamps = [frame["timestampMs"] for frame in result["frames"]]
    assert stamps == sorted(stamps) and stamps[-1] > stamps[0]
    for frame in result["frames"]:
        assert Path(frame["path"]).read_bytes().startswith(b"\x89PNG")
    assert result["decoder"] == "PyAV 19.0.2"


def test_recording_duration_and_fake_signature_rejected(tmp_path):
    source = tmp_path / "long.mp4"
    make_video(source, 31)
    with pytest.raises(RecordingError):
        asyncio.run(extract_frames(source, tmp_path / "frames"))
    source.write_bytes(b"renamed file")
    with pytest.raises(RecordingError, match="content"):
        asyncio.run(extract_frames(source, tmp_path / "frames"))
