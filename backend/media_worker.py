"""Isolated Python media process; caller supplies resource limits and a hard timeout."""
import json
import sys
from fractions import Fraction
from pathlib import Path

import av


def extract(path: Path, destination: Path) -> dict:
    raw = path.read_bytes()[:16]
    if raw.startswith(b"\x1aE\xdf\xa3"):
        media_format = "webm"
    elif raw[4:8] == b"ftyp":
        media_format = "mp4"
    else:
        raise ValueError("Unsupported recording signature")
    with av.open(str(path), format=media_format, options={"protocol_whitelist": "file,pipe"}, timeout=(3, 3)) as container:
        if len(container.streams.video) != 1:
            raise ValueError("Exactly one video stream is supported")
        stream = container.streams.video[0]
        stream.codec_context.thread_count = 1
        if not 0 < stream.width * stream.height <= 3840 * 2160:
            raise ValueError("Video dimensions exceed 3840×2160")
        duration = float(container.duration / av.time_base) if container.duration else float((stream.duration or 0) * stream.time_base)
        if not 0 < duration <= 30:
            raise ValueError("Recording must be at most 30 seconds")
        frames = []
        for index in range(4):
            target = max(0, duration - 0.2) * index / 3
            container.seek(int(target * av.time_base), backward=True, any_frame=False)
            selected = None
            for count, frame in enumerate(container.decode(video=0)):
                if count >= 4000:
                    raise ValueError("Decode frame ceiling reached")
                selected = frame
                if frame.time is not None and frame.time >= target:
                    break
            if selected is None or selected.time is None:
                raise ValueError("No timestamped video frame at sample point")
            timestamp = selected.time
            ratio = min(640 / selected.width, 360 / selected.height, 1)
            image = selected.reformat(width=max(1, round(selected.width * ratio)), height=max(1, round(selected.height * ratio)), format="rgb24")
            codec = av.CodecContext.create("png", "w")
            codec.width, codec.height, codec.pix_fmt = image.width, image.height, "rgb24"
            codec.time_base = Fraction(1, 1)
            codec.thread_count = 1
            image.pts = 0
            packets = codec.encode(image) + codec.encode(None)
            data = b"".join(bytes(packet) for packet in packets)
            if not data.startswith(b"\x89PNG") or len(data) > 1024 * 1024:
                raise ValueError("Invalid or oversized sampled PNG")
            target_path = destination / f"frame-{index:02}.png"
            target_path.write_bytes(data)
            frames.append({"timestampMs": round(timestamp * 1000), "path": str(target_path), "width": image.width, "height": image.height})
        return {"durationSeconds": duration, "frames": frames, "decoder": f"PyAV {av.__version__}",
                "frameTimestamps": "Actual decoded presentation timestamps; frames sampled at four positions."}


if __name__ == "__main__":
    try:
        print(json.dumps(extract(Path(sys.argv[1]), Path(sys.argv[2]))))
    except Exception:
        print("Recording must be a decodable MP4/WebM with one video stream, at most 30 seconds and 3840×2160.", file=sys.stderr)
        sys.exit(2)
