"""Trusted image entry point for the exact exported test; never run on the host."""
import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path

if __package__:
    from .sandbox_entry import apply_limits, copy_output, drop_privileges
else:
    from sandbox_entry import apply_limits, copy_output, drop_privileges


def main() -> int:
    if (sys.platform != "linux" or os.getenv("BUGARCADE_SANDBOX") != "1"
            or Path.cwd() != Path("/opt/bugarcade") or len(sys.argv) != 2
            or sys.argv[1] not in {"buggy", "fixed"}):
        raise RuntimeError("Regression entry requires the authorized Linux sandbox and a supported variant.")
    drop_privileges()
    apply_limits()
    output = bytearray()
    timed_out = threading.Event()
    process = subprocess.Popen(["node", "--test", "/tmp/regression.test.mjs"], stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, cwd="/opt/bugarcade", start_new_session=True,
        env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/home", "NODE_ENV": "test",
             "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "BUGARCADE_SANDBOX": "1",
             "GOMAXPROCS": "2", "UV_THREADPOOL_SIZE": "2",
             "BUGARCADE_PROJECT_DIR": "/tmp/project", "BUGARCADE_ROOT": "/opt/bugarcade", "VARIANT": sys.argv[1]})

    def kill():
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    def deadline():
        timed_out.set()
        kill()

    timer = threading.Timer(40, deadline)
    timer.start()
    bounded = False
    try:
        bounded = copy_output(process.stdout, output.extend)
        if not bounded:
            kill()
        process.wait(timeout=3)
    finally:
        timer.cancel()
        kill()
        process.wait(timeout=3)
    Path("/tmp/regression-tap.txt").write_bytes(output)
    results = list(Path("/tmp/evidence/runs").glob("*/result.json"))
    result = None
    if len(results) == 1 and not results[0].is_symlink() and results[0].stat().st_size <= 256 * 1024:
        result = json.loads(results[0].read_text())
    report = {"variant": sys.argv[1], "testReturncode": process.returncode,
              "timedOut": timed_out.is_set(), "outputBounded": bounded,
              "tapSha256": hashlib.sha256(output).hexdigest(), "result": result}
    print(json.dumps(report))
    return 0 if bounded and not timed_out.is_set() and result is not None else 3


if __name__ == "__main__":
    sys.exit(main())
