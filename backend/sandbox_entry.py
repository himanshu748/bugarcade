"""Trusted image entry point. Drop runtime privileges before reading submitted data."""
import ctypes
import json
import os
import resource
import subprocess
import sys


def drop_privileges() -> dict:
    # Modal ignores Dockerfile USER. This trusted bootstrap runs before any submitted code/data.
    if sys.platform != "linux" or os.getenv("BUGARCADE_SANDBOX") != "1" or os.getcwd() != "/opt/bugarcade":
        raise RuntimeError("Privilege bootstrap requires the prepared Linux sandbox; host execution is forbidden.")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS: children cannot gain setuid/file-capability privileges.
        raise RuntimeError("Could not enforce no-new-privileges; submitted execution refused.")
    if os.geteuid() == 0:
        import pwd
        account = pwd.getpwnam("pwuser")
        if account.pw_uid == 0 or account.pw_gid == 0:
            raise RuntimeError("Invalid unprivileged sandbox account.")
        os.setgroups([])
        os.setgid(account.pw_gid)
        os.setuid(account.pw_uid)
    no_new_privileges = libc.prctl(39, 0, 0, 0, 0)
    if os.geteuid() == 0 or os.getuid() == 0 or os.getegid() == 0 or 0 in os.getgroups() or no_new_privileges != 1:
        raise RuntimeError("Unprivileged/no-new-privileges enforcement failed; submitted execution refused.")
    return {"uid": os.geteuid(), "gid": os.getegid(), "supplementaryGroups": os.getgroups(), "noNewPrivs": no_new_privileges}


def apply_limits() -> dict:
    if os.geteuid() == 0:
        raise RuntimeError("Sandbox image must run as an unprivileged user for process limits to apply.")
    # Bound helper parallelism before Chromium/ffmpeg/esbuild start. Host CPU visibility
    # otherwise causes encoder/thread startup failure under an otherwise valid task cap.
    available = sorted(os.sched_getaffinity(0))
    if not available:
        raise RuntimeError("Sandbox CPU affinity is unavailable.")
    os.sched_setaffinity(0, set(available[:4]))
    affinity = sorted(os.sched_getaffinity(0))
    if not affinity or len(affinity) > 4:
        raise RuntimeError("Sandbox helper parallelism could not be bounded.")
    resource.setrlimit(resource.RLIMIT_NPROC, (256, 256))
    resource.setrlimit(resource.RLIMIT_NOFILE, (512, 512))
    resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (40, 40))
    return {"cpuAffinity": affinity, "processRlimit": 256}


def copy_output(stream, emit, limit: int = 1024 * 1024) -> bool:
    count = 0
    while chunk := stream.read(8192):
        count += len(chunk)
        if count > limit:
            return False
        emit(chunk)
    return True


def main() -> int:
    drop_privileges()
    apply_limits()
    request = json.loads(open(sys.argv[1]).read())
    process = subprocess.Popen(["node", "worker/cli.mjs"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL, env={"PATH": "/usr/local/bin:/usr/bin:/bin",
                               "HOME": "/tmp/home", "NODE_ENV": "test", "BUGARCADE_SANDBOX": "1",
                               "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "GOMAXPROCS": "2", "UV_THREADPOOL_SIZE": "2"}, cwd="/opt/bugarcade")
    try:
        process.stdin.write((json.dumps(request) + "\n").encode())
        process.stdin.close()
        if not copy_output(process.stdout, lambda chunk: os.write(1, chunk)):
            return 3
        return process.wait(timeout=40)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()


if __name__ == "__main__":
    sys.exit(main())
