"""Trusted, bounded cloud-only probe. Never run resource pressure probes on the host."""
import errno
import hashlib
import io
import json
import os
import resource
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.request import ProxyHandler, build_opener

from sandbox_entry import apply_limits, copy_output, drop_privileges


def main():
    identity = drop_privileges()
    if sys.platform != "linux" or os.geteuid() == 0 or os.getenv("BUGARCADE_SANDBOX") != "1":
        raise RuntimeError("Probe requires the prepared non-root Linux sandbox; host execution is forbidden.")
    checks = {}

    def record(name, passed, **evidence):
        checks[name] = {"status": "passed" if passed else "failed", **evidence}
        print(json.dumps({"check": name, "status": checks[name]["status"]}), file=sys.stderr, flush=True)

    record("unprivileged", os.geteuid() != 0 and os.getegid() != 0 and 0 not in os.getgroups(),
           **identity)
    record("uploaded_file_readability", Path("/tmp/project/readability-check.txt").read_text() == "bugarcade-upload-marker"
           and Path("/tmp/request.json").read_text() == "{}",
           note="Harmless files uploaded by the root SDK filesystem remain readable after dropping privileges.")
    forbidden = [name for name in ("BASETEN_API_KEY", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_IDENTITY_TOKEN",
                                  "MODAL_PROXY_TOKEN", "MODAL_PROXY_TOKEN_ID", "MODAL_PROXY_TOKEN_SECRET") if os.getenv(name)]
    record("credential_names_absent", not forbidden, presentNames=forbidden)
    expected = json.loads(Path("/tmp/build-expectations.json").read_text())
    mismatches = [name for name, value in expected.items() if name != "backend/Dockerfile.modal"
                  and (not Path(name).is_file() or hashlib.sha256(Path(name).read_bytes()).hexdigest() != value)]
    record("image_file_hashes", not mismatches, mismatchedFiles=mismatches, checkedFiles=len(expected) - 1)
    node = subprocess.run(["node", "-e", "const fs=require('node:fs'); const {chromium}=require('playwright'); "
        "(async()=>{const browser=await chromium.launch({headless:true,channel:'chromium'}); "
        "try{console.log(JSON.stringify({node:process.versions.node,react:require('react/package.json').version,"
        "playwright:require('playwright/package.json').version,browser:browser.version(),"
        "browserExists:fs.existsSync(chromium.executablePath())}));}finally{await browser.close();}})()"],
        capture_output=True, timeout=10, check=False)
    versions = json.loads(node.stdout) if node.returncode == 0 and len(node.stdout) < 4096 else {}
    pinned = json.loads(Path("package.json").read_text())
    record("prebuilt_browser_dependencies", node.returncode == 0 and versions.get("react") == pinned["dependencies"]["react"]
           and versions.get("playwright") == pinned["devDependencies"]["@playwright/test"] and versions.get("browserExists") is True,
           versions={**versions, "python": sys.version.split()[0]})
    for name in ("cpu.max", "memory.max", "memory.events", "pids.max"):
        path = Path("/sys/fs/cgroup") / name
        checks[name] = {"status": "observed" if path.is_file() else "not-exposed", "value": path.read_text().strip() if path.is_file() else None,
                        "note": "Informational guest visibility only. Trusted backend separately verifies provider resource metadata and bounded memory pressure."}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"bugarcade-loopback")

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with build_opener(ProxyHandler({})).open(f"http://127.0.0.1:{server.server_port}", timeout=2) as response:
            record("loopback", response.read(64) == b"bugarcade-loopback")
    finally:
        server.shutdown()
        thread.join(timeout=2)
        server.server_close()
    try:
        with socket.create_connection(("1.1.1.1", 443), timeout=1):
            record("external_egress", False, note="Unexpected external TCP connection; no payload sent.")
    except OSError as exc:
        definitive = exc.errno in {errno.EPERM, errno.EACCES, errno.ENETUNREACH, errno.EHOSTUNREACH}
        checks["external_egress"] = {"status": "passed" if definitive else "inconclusive", "errno": exc.errno,
                                     "note": "Timeout/refusal alone is not proof of network policy enforcement."}

    limits = apply_limits()
    record("helper_parallelism", 1 <= len(limits["cpuAffinity"]) <= 4, **limits)
    record("rlimit_configuration", resource.getrlimit(resource.RLIMIT_NPROC) == (256, 256)
           and resource.getrlimit(resource.RLIMIT_FSIZE) == (8 * 1024 * 1024, 8 * 1024 * 1024)
           and resource.getrlimit(resource.RLIMIT_CPU) == (40, 40))
    emitted = 0

    def count_output(chunk):
        nonlocal emitted
        emitted += len(chunk)

    record("worker_output_guard", not copy_output(io.BytesIO(b"x" * (1024 * 1024 + 1)), count_output) and emitted <= 1024 * 1024,
           bytesEmitted=emitted, note="Exercises the exact trusted entrypoint guard with generated data, inside the sandbox.")
    children = []
    denied = False
    # Exercise the same per-UID kernel mechanism at a low soft limit; do not fork
    # the entire production ceiling just to pressure the provider's guest runtime.
    resource.setrlimit(resource.RLIMIT_NPROC, (16, 256))
    try:
        for _ in range(17):
            try:
                pid = os.fork()
            except OSError as exc:
                denied = exc.errno == errno.EAGAIN
                break
            if pid == 0:
                time.sleep(10)
                os._exit(0)
            children.append(pid)
    finally:
        for pid in children:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for pid in children:
            os.waitpid(pid, 0)
        resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))
    record("process_limit_enforced", denied and len(children) <= 16, childrenCreated=len(children),
           productionRlimit=list(resource.getrlimit(resource.RLIMIT_NPROC)), trialSoftLimit=16,
           note="Low-soft-limit mechanism trial returns EAGAIN; production hard256 read back separately. Full256-task saturation is not claimed.")
    cpu_probe = subprocess.run([sys.executable, "-I", "-c",
        "import resource; resource.setrlimit(resource.RLIMIT_CPU,(1,1)); exec('while True: pass')"],
        timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    record("cpu_rlimit_enforced", cpu_probe.returncode == -signal.SIGKILL, returncode=cpu_probe.returncode,
           note="One-second child CPU limit; production entrypoint sets 40 seconds.")
    file_probe = subprocess.run([sys.executable, "-I", "-c",
        "import errno; f=open('/tmp/limit-probe','wb');\ntry:\n f.write(b'x'*(8*1024*1024+1)); f.flush()\nexcept OSError as e:\n raise SystemExit(0 if e.errno==errno.EFBIG else 2)\nraise SystemExit(3)"],
        timeout=5, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
    record("file_output_limit_enforced", file_probe.returncode == 0 and Path("/tmp/limit-probe").stat().st_size <= 8 * 1024 * 1024)
    print(json.dumps({"kind": "real-cloud-boundary-probe", "checks": checks,
                      "remaining": ["provider CPU/memory configuration readback", "dedicated bounded OOM trial", "TTL/readiness/cancellation termination readbacks"]}))
    return 0 if all(check["status"] in {"passed", "observed", "not-exposed"} for check in checks.values()) else 2


if __name__ == "__main__":
    raise SystemExit(main())
