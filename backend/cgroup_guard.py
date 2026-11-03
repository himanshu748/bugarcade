"""Trusted VM supervisor. Root observes a bounded, unprivileged workload leaf.

Fixed CLI: worker | regression buggy|fixed | probe-memory |
probe-manual-kill | probe-timeout. Never execute this resource probe on a host.
"""
import errno
import hashlib
import json
import math
import os
import re
import select
import selectors
import signal
import stat
import subprocess
import sys
import time
import uuid
from pathlib import Path

KIND = "bugarcade-cgroup-guard-v1"
MEMORY_BYTES = 1024 * 1024 * 1024
ALLOCATION_MIB_MAX = 1152
OUTPUT_LIMIT = 1024 * 1024
KERNEL_LIMIT = 128 * 1024
HEADROOM_MIB = 384
RECEIPT_DIR = Path("/tmp/bugarcade-guard")
RECEIPT = RECEIPT_DIR / "receipt.json"
CGROUP_ROOT = Path("/sys/fs/cgroup")
GUARD_PATH = "/opt/bugarcade/backend/cgroup_guard.py"
PROBE_MODES = {"probe-memory", "probe-manual-kill", "probe-timeout"}
EVENT_KEYS = {"max", "oom", "oom_kill", "oom_group_kill"}
PERMISSIONS = {"limitWrite", "escapeWrite", "subgroupCreate", "receiptRead", "kernelWrite"}


class GuardError(ValueError):
    pass


def parse_mode(args):
    if args == ["worker"]:
        return "worker", None
    if len(args) == 2 and args[0] == "regression" and args[1] in {"buggy", "fixed"}:
        return "regression", args[1]
    if len(args) == 1 and args[0] in PROBE_MODES:
        return args[0], None
    raise GuardError("Only the fixed worker, regression variant and resource-control probe vocabulary is admitted.")


def workload_command(mode, variant):
    if mode == "worker" and variant is None:
        return [sys.executable, "/opt/bugarcade/backend/sandbox_entry.py", "/tmp/request.json"]
    if mode == "regression" and variant in {"buggy", "fixed"}:
        return [sys.executable, "/opt/bugarcade/backend/regression_entry.py", variant]
    raise GuardError("No arbitrary workload command or path is supported.")


def parse_events(text):
    values = {}
    if len(text) > 4096:
        raise GuardError("Memory-event output exceeded its bound.")
    for line in text.splitlines():
        parts = line.split()
        if (len(parts) != 2 or not re.fullmatch(r"[a-z_]{1,40}", parts[0])
                or not re.fullmatch(r"[0-9]{1,19}", parts[1]) or parts[0] in values):
            raise GuardError("Malformed local kernel memory events.")
        values[parts[0]] = int(parts[1])
    if not EVENT_KEYS <= values.keys():
        raise GuardError("Local kernel OOM counters are unavailable.")
    return values


def delta_events(before, after):
    if not EVENT_KEYS <= before.keys() or not EVENT_KEYS <= after.keys():
        raise GuardError("Required local kernel counters are missing.")
    result = {}
    for key in before:
        if (key not in after or type(before[key]) is not int or type(after[key]) is not int
                or before[key] < 0 or after[key] < before[key]):
            raise GuardError("Kernel memory counters are missing or decreased.")
        result[key] = after[key] - before[key]
    return result


def parse_oom_records(raw):
    if not isinstance(raw, bytes) or len(raw) > KERNEL_LIMIT:
        raise GuardError("Kernel record input exceeded its bound.")
    records = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        message = line.split(";", 1)[-1]
        if "oom-kill:" not in message:
            continue
        message = message.split("oom-kill:", 1)[1].lstrip()
        def field(name, source=message):
            match = re.search(rf"(?:^|[,\s]){name}=([^,\s]+)", source)
            return match.group(1) if match else None
        pid, uid = field("pid"), field("uid")
        records.append({"constraint": field("constraint"), "oomMemcg": field("oom_memcg"),
                        "taskMemcg": field("task_memcg"), "pid": int(pid) if pid and pid.isdecimal() else None,
                        "uid": int(uid) if uid and uid.isdecimal() else None})
    return records


def classify_execution(mode, execution, events, kernel, leaf_kernel_path, child_pid):
    """Pure outcome contract. Generic kills and oom_kill-alone never verify a limit."""
    def rejected(name):
        return {"accepted": False, "classification": name, "memoryLimitVerified": False}
    if mode not in PROBE_MODES | {"worker", "regression"}:
        raise GuardError("Unsupported mode in outcome classification.")
    try:
        if (type(execution["returncode"]) is not int
                or any(type(execution[key]) is not bool for key in ("timedOut", "manualKill", "outputBounded", "controlReadyObserved"))):
            raise GuardError("Execution status fields must have strict types.")
        delta = delta_events(events["before"], events["after"])
        if events["delta"] != delta or kernel["complete"] is not True:
            return rejected("ambiguous-oom")
        records = kernel["oomRecords"]
        matching = [row for row in records if row["constraint"] == "CONSTRAINT_MEMCG"
                    and row["oomMemcg"] == leaf_kernel_path and row["taskMemcg"] == leaf_kernel_path
                    and row["pid"] == child_pid]
        global_oom = any(row["constraint"] != "CONSTRAINT_MEMCG" for row in records)
        if kernel["matchingRecords"] != matching or kernel["globalOomObserved"] != global_oom:
            return rejected("ambiguous-oom")
        if execution["outputBounded"] is not True:
            return rejected("output-limit-exceeded")
        oom_seen = any(delta[key] > 0 for key in ("oom", "oom_kill", "oom_group_kill")) or bool(records)
        if mode == "probe-memory":
            progress = execution["allocationProgressMiB"]
            expected_progress = list(range(32, max(progress, default=0) + 1, 32))
            verified = (execution["returncode"] == -signal.SIGKILL and execution["timedOut"] is False
                        and execution["manualKill"] is False and bool(matching) and len(matching) == len(records)
                        and not global_oom and all(delta[key] > 0 for key in EVENT_KEYS)
                        and progress == expected_progress and 896 <= max(progress, default=0) <= ALLOCATION_MIB_MAX)
            return {"accepted": verified, "classification": "memory-limit-probe" if verified else "ambiguous-oom",
                    "memoryLimitVerified": verified}
        if oom_seen:
            return rejected("memory-limit-exceeded" if matching and not global_oom else "ambiguous-oom")
        if mode in {"probe-manual-kill", "probe-timeout"}:
            zero = all(delta[key] == 0 for key in EVENT_KEYS)
            manual = mode == "probe-manual-kill" and execution["manualKill"] is True and execution["timedOut"] is False
            timeout = mode == "probe-timeout" and execution["timedOut"] is True and execution["manualKill"] is False
            verified = zero and execution["controlReadyObserved"] is True and execution["returncode"] == -signal.SIGKILL and (manual or timeout)
            return {"accepted": verified, "classification": ("manual-kill-control" if manual else "timeout-control") if verified else "ambiguous-oom",
                    "memoryLimitVerified": False}
        if execution["timedOut"]:
            return rejected("deadline-exceeded")
        permitted_codes = {0, 2} if mode == "worker" else {0}
        if execution["manualKill"] or execution["returncode"] not in permitted_codes:
            return rejected("workload-failed")
        return {"accepted": True, "classification": "workload-completed", "memoryLimitVerified": False}
    except (KeyError, TypeError, ValueError) as error:
        if isinstance(error, GuardError):
            raise
        raise GuardError("Malformed execution attribution.") from error


def validate_receipt(receipt, *, mode, expected_inputs, expected_guard_sha, expected_variant=None):
    """Reject app-authored observations; recompute the trusted guard's pure classifier."""
    try:
        if (mode not in PROBE_MODES | {"worker", "regression"}
                or not isinstance(expected_guard_sha, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_guard_sha)
                or (mode in PROBE_MODES and expected_variant is not None)
                or (mode not in PROBE_MODES and expected_variant not in {"buggy", "fixed"})):
            raise GuardError("Expected mode, variant or guard-source binding is invalid.")
        if (not isinstance(receipt, dict) or receipt["kind"] != "bugarcade-cgroup-guard-v1"
                or receipt["guardSha256"] != expected_guard_sha or receipt["mode"] != mode or receipt["variant"] != expected_variant):
            raise GuardError("Guard source, mode or variant binding differs.")
        if receipt.get("errorType") is not None or receipt.get("cancellationObserved", False) is not False:
            raise GuardError("An errored or interrupted execution cannot supply accepted boundary evidence.")
        settings = receipt["settings"]
        expected_settings = {"memoryLimitBytes": MEMORY_BYTES, "swapMaxBytes": 0, "oomGroup": 1,
                             "maximumAllocationMiB": 1152, "deadlineSeconds": 2 if mode == "probe-timeout" else 40,
                             "outputLimitBytes": 1048576, "minimumHeadroomMiB": 384}
        if settings != expected_settings or any(type(value) is not int for value in settings.values()):
            raise GuardError("Trusted leaf settings differ from the reviewed production cap.")
        supervisor, leaf, child = receipt["supervisor"], receipt["leaf"], receipt["child"]
        if (type(supervisor["uid"]) is not int or supervisor["uid"] != 0 or supervisor["outsideLeaf"] is not True
                or not isinstance(supervisor["cgroupBefore"], str) or not re.fullmatch(r"0::/[^\n]*", supervisor["cgroupBefore"])
                or supervisor["cgroupBefore"] != supervisor["cgroupAfter"]
                or type(supervisor["pid"]) is not int or supervisor["pid"] <= 0
                or type(leaf["ownerUid"]) is not int or leaf["ownerUid"] != 0
                or not re.fullmatch(r"/sys/fs/cgroup/bugarcade-workload-[0-9]+-[a-f0-9]{32}", leaf["path"])
                or not leaf["path"].startswith(f"/sys/fs/cgroup/bugarcade-workload-{supervisor['pid']}-")
                or leaf["kernelPath"] != leaf["path"].removeprefix("/sys/fs/cgroup")
                or leaf["kernelPath"] in supervisor["cgroupBefore"]
                or leaf["readback"] != {"memory.max": str(MEMORY_BYTES), "memory.swap.max": "0", "memory.oom.group": "1"}
                or type(child["pid"]) is not int or child["pid"] <= 0 or child["pid"] == supervisor["pid"]
                or type(leaf["childPid"]) is not int or leaf["childPid"] != child["pid"]):
            raise GuardError("Root observer/leaf readback lacks exact trusted containment.")
        identity, observed = child["identity"], child["observedStatus"]
        uid, gid = identity["uid"], identity["gid"]
        if (type(uid) is not int or type(gid) is not int or uid <= 0 or gid <= 0
                or identity["supplementaryGroups"] != [] or type(identity["noNewPrivs"]) is not int or identity["noNewPrivs"] != 1
                or observed["uids"] != [uid] * 4 or observed["gids"] != [gid] * 4
                or any(type(value) is not int for value in observed["uids"] + observed["gids"])
                or observed["groups"] != [] or type(observed["noNewPrivs"]) is not int or observed["noNewPrivs"] != 1
                or not all(re.fullmatch(r"[a-fA-F0-9]{1,16}", observed[key]) for key in ("capEff", "capPrm"))
                or int(observed["capEff"], 16) != 0 or int(observed["capPrm"], 16) != 0
                or child["membership"].strip() != "0::" + leaf["kernelPath"]
                or set(child["permissionDenials"]) != {"limitWrite", "escapeWrite", "subgroupCreate", "receiptRead", "kernelWrite"}
                or any(value is not True for value in child["permissionDenials"].values())):
            raise GuardError("Worker retained root/capabilities, could forge proof or could escape its leaf.")
        cleanup, execution, events, kernel = receipt["cleanup"], receipt["execution"], receipt["events"], receipt["kernel"]
        memory = receipt["guestMemoryKiB"]
        minimum_kib = MEMORY_BYTES // 1024 + HEADROOM_MIB * 1024
        if (not isinstance(memory, dict) or any(type(memory[key]) is not int or memory[key] < minimum_kib
                                               for key in ("MemTotal", "MemAvailable"))):
            raise GuardError("Guest memory readback lacks the required supervisor headroom.")
        if (any(cleanup[key] is not True for key in ("leafKilled", "populatedZero", "leafRemoved", "memoryControllerRestored"))
                or cleanup["remainingPids"] != [] or cleanup["subtreeBefore"] != cleanup["subtreeAfter"]
                or not isinstance(cleanup["subtreeBefore"], list)
                or any(not isinstance(value, str) or not re.fullmatch(r"[a-z_]{1,40}", value) for value in cleanup["subtreeBefore"])
                or cleanup.get("errorType") is not None or cleanup.get("restoreErrorType") is not None
                or kernel["source"] != "/dev/kmsg" or kernel["complete"] is not True or kernel["byteLimit"] != 131072
                or type(kernel["bytesRead"]) is not int or not 0 <= kernel["bytesRead"] <= 131072
                or kernel["globalOomObserved"] is not False or execution["outputBounded"] is not True
                or type(execution["returncode"]) is not int or type(execution["stdoutBytes"]) is not int or not 0 <= execution["stdoutBytes"] <= 1048576
                or type(execution["stderrBytes"]) is not int or not 0 <= execution["stderrBytes"] <= 1048576
                or execution["stdoutBytes"] + execution["stderrBytes"] > OUTPUT_LIMIT
                or not all(re.fullmatch(r"[a-f0-9]{64}", execution[key]) for key in ("stdoutSha256", "stderrSha256"))
                or type(execution["elapsedMs"]) not in {int, float} or not math.isfinite(execution["elapsedMs"])
                or not 0 <= execution["elapsedMs"] <= (settings["deadlineSeconds"] + 5) * 1000):
            raise GuardError("Guard output, kernel monitoring or cleanup is incomplete.")
        if (not isinstance(execution["allocationProgressMiB"], list)
                or any(type(value) is not int or not 0 < value <= ALLOCATION_MIB_MAX
                       for value in execution["allocationProgressMiB"])):
            raise GuardError("Allocation witness must contain bounded integer observations.")
        inputs = receipt["inputs"]
        expected_input_names = {"/tmp/project/manifest.json", "/tmp/project/buggy/App.tsx", "/tmp/project/fixed/App.tsx",
                                "/tmp/request.json" if mode == "worker" else "/tmp/regression.test.mjs"}
        if mode in PROBE_MODES:
            if inputs != {} or expected_inputs != {}:
                raise GuardError("Fixed pressure/control probes must not execute submitted inputs.")
        elif (not isinstance(inputs, dict) or set(inputs) != expected_input_names
              or any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value) for value in inputs.values())
              or not isinstance(expected_inputs, dict) or inputs != expected_inputs):
            raise GuardError("Worker/regression input bindings are incomplete.")
        if (not isinstance(kernel["oomRecords"], list) or not isinstance(kernel["matchingRecords"], list)
                or len(kernel["oomRecords"]) > 128):
            raise GuardError("Kernel OOM attribution is not a bounded record list.")
        for row in kernel["oomRecords"]:
            if (not isinstance(row, dict) or set(row) != {"constraint", "oomMemcg", "taskMemcg", "pid", "uid"}
                    or type(row["pid"]) is not int or row["pid"] <= 0 or type(row["uid"]) is not int or row["uid"] < 0):
                raise GuardError("Kernel OOM identity has malformed types.")
        if any(row["uid"] != uid for row in kernel["matchingRecords"]):
            raise GuardError("Kernel victim UID contradicts the admitted workload identity.")
        for key in ("max", "oom", "oom_kill", "oom_group_kill"):
            before, after, delta = (events[part][key] for part in ("before", "after", "delta"))
            if any(type(value) is not int or value < 0 for value in (before, after, delta)) or after - before != delta:
                raise GuardError("Memory-event deltas contradict their observed counters.")
        recomputed = classify_execution(mode, execution, events, kernel, leaf["kernelPath"], child["pid"])
        expected = {"probe-memory": "memory-limit-probe", "probe-manual-kill": "manual-kill-control",
                    "probe-timeout": "timeout-control", "worker": "workload-completed", "regression": "workload-completed"}[mode]
        if (recomputed.get("accepted") is not True or receipt["classification"] != recomputed["classification"]
                or receipt["classification"] != expected or receipt["memoryLimitVerified"] is not recomputed["memoryLimitVerified"]
                or receipt["memoryLimitVerified"] is not (mode == "probe-memory")
                or receipt["status"] != ("probe-verified" if mode in PROBE_MODES else "completed")):
            raise GuardError("Pure guard classification does not support the intended outcome.")
        return recomputed
    except (KeyError, TypeError, AttributeError, ValueError) as error:
        if isinstance(error, GuardError):
            raise
        raise GuardError("Guard receipt is malformed, incomplete or contradictory.") from error


def require_environment():
    if (sys.platform != "linux" or os.geteuid() != 0 or Path.cwd() != Path("/opt/bugarcade")
            or os.getenv("BUGARCADE_SANDBOX") != "1" or os.getenv("BUGARCADE_CGROUP_GUARD") != "1"):
        raise GuardError("Trusted root VM environment required; host resource execution refused.")


def read_root_file(path, maximum):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or not 0 < info.st_size <= maximum:
            raise GuardError("Input must be bounded, root-owned and not group/world-writable.")
        data = os.read(descriptor, maximum + 1)
        if len(data) != info.st_size or len(data) > maximum:
            raise GuardError("Input changed during bounded read.")
        return data
    finally:
        os.close(descriptor)


def root_file(path, maximum):
    return hashlib.sha256(read_root_file(path, maximum)).hexdigest()


def request_variant():
    value = json.loads(read_root_file(Path("/tmp/request.json"), 256 * 1024))
    if not isinstance(value, dict) or value.get("variant") not in {"buggy", "fixed"}:
        raise GuardError("Trusted request has no supported variant.")
    return value["variant"]


def bind_inputs(mode):
    if mode in PROBE_MODES:
        return {}
    project = Path("/tmp/project")
    for path in [project, project / "buggy", project / "fixed"]:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise GuardError("Project directories must remain root-owned, non-symlink and not writable by the workload.")
    paths = [project / "manifest.json", project / "buggy/App.tsx", project / "fixed/App.tsx"]
    paths.append(Path("/tmp/request.json") if mode == "worker" else Path("/tmp/regression.test.mjs"))
    return {str(path): root_file(path, 256 * 1024) for path in paths}


def write_receipt(value):
    raw = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
    if len(raw) > 128 * 1024:
        raise GuardError("Root receipt exceeded its bound.")
    temporary = RECEIPT_DIR / "receipt.tmp"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(RECEIPT)
    finally:
        if temporary.exists():
            temporary.unlink()


def read_status(pid):
    rows = {}
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        if ":" in line:
            key, value = line.split(":", 1)
            rows[key] = value.strip()
    return {"uids": [int(value) for value in rows["Uid"].split()],
            "gids": [int(value) for value in rows["Gid"].split()],
            "groups": [int(value) for value in rows["Groups"].split()], "noNewPrivs": int(rows["NoNewPrivs"]),
            "capEff": rows["CapEff"], "capPrm": rows["CapPrm"]}


def validate_child(metadata, observed, membership, leaf, pid):
    try:
        identity = metadata["identity"]
        if (metadata["pid"] != pid or identity["uid"] == 0 or identity["gid"] == 0
                or 0 in identity["supplementaryGroups"] or identity["noNewPrivs"] != 1
                or observed["uids"] != [identity["uid"]] * 4 or observed["gids"] != [identity["gid"]] * 4
                or observed["groups"] != identity["supplementaryGroups"] or 0 in observed["groups"] or observed["noNewPrivs"] != 1
                or int(observed["capEff"], 16) != 0 or int(observed["capPrm"], 16) != 0
                or membership != f"0::/{leaf.name}" or metadata["membership"] != membership
                or set(metadata["permissionDenials"]) != PERMISSIONS
                or not all(value is True for value in metadata["permissionDenials"].values())):
            raise GuardError("Child identity, membership or permission containment failed before execution.")
    except (KeyError, TypeError, ValueError) as error:
        if isinstance(error, GuardError):
            raise
        raise GuardError("Malformed child admission metadata.") from error


def contained_child(args):
    require_environment()
    if os.getenv("BUGARCADE_GUARD_CHILD") != "1" or len(args) not in {3, 4}:
        raise GuardError("Contained-child entry is private to the root supervisor.")
    mode, leaf_string, descriptor_string, *variant = args
    mode, chosen_variant = parse_mode([mode] + variant)
    leaf = Path(leaf_string)
    if not re.fullmatch(r"/sys/fs/cgroup/bugarcade-workload-[0-9]+-[a-f0-9]{32}", str(leaf)):
        raise GuardError("Invalid private workload leaf.")
    descriptor = int(descriptor_string)
    if sys.stdin.buffer.read(1) != b"G" or Path("/proc/self/cgroup").read_text().strip() != f"0::/{leaf.name}":
        raise GuardError("Child was not moved into its workload leaf before execution.")
    from sandbox_entry import apply_limits, drop_privileges
    identity = drop_privileges()

    def denied(operation):
        try:
            operation()
        except OSError as error:
            return error.errno in {errno.EPERM, errno.EACCES}
        return False

    def open_kernel_for_write():
        descriptor = os.open("/dev/kmsg", os.O_WRONLY | os.O_NONBLOCK)
        os.close(descriptor)

    metadata = {"pid": os.getpid(), "identity": identity,
                "membership": Path("/proc/self/cgroup").read_text().strip(), "permissionDenials": {
                    "limitWrite": denied(lambda: (leaf / "memory.max").write_text(str(MEMORY_BYTES))),
                    "escapeWrite": denied(lambda: (CGROUP_ROOT / "cgroup.procs").write_text(str(os.getpid()))),
                    "subgroupCreate": denied(lambda: (leaf / "escape").mkdir()),
                    "receiptRead": denied(lambda: RECEIPT.read_bytes()),
                    "kernelWrite": denied(open_kernel_for_write)}}
    os.write(descriptor, (json.dumps(metadata) + "\n").encode())
    os.close(descriptor)
    if sys.stdin.buffer.read(1) != b"X":
        raise GuardError("Root supervisor did not admit the contained child.")
    if mode not in PROBE_MODES:
        command = workload_command(mode, chosen_variant)
        os.execve(command[0], command, dict(os.environ))
    apply_limits()
    if mode == "probe-memory":
        blocks = []
        for index in range(ALLOCATION_MIB_MAX // 32):
            block = bytearray(32 * 1024 * 1024)
            for offset in range(0, len(block), 4096):
                block[offset] = 1
            blocks.append(block)
            print(json.dumps({"allocatedMiB": (index + 1) * 32}), flush=True)
        print(json.dumps({"completed": True}), flush=True)
        return 3
    print(json.dumps({"control": "ready"}), flush=True)
    while True:
        signal.pause()


def read_metadata(descriptor, seconds=3):
    deadline, raw = time.monotonic() + seconds, b""
    while b"\n" not in raw:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([descriptor], [], [], max(0, remaining))[0]:
            raise GuardError("Contained-child admission exceeded its deadline.")
        chunk = os.read(descriptor, 4096)
        if not chunk:
            raise GuardError("Contained child closed its admission channel.")
        raw += chunk
        if len(raw) > 8192:
            raise GuardError("Contained-child metadata exceeded its ceiling.")
    return json.loads(raw)


def drain_kernel(descriptor):
    raw, complete = b"", True
    while True:
        try:
            chunk = os.read(descriptor, 8192)
            if not chunk:
                break
            raw += chunk
            if len(raw) > KERNEL_LIMIT:
                raw, complete = raw[:KERNEL_LIMIT], False
                break
        except BlockingIOError:
            break
        except OSError:
            complete = False
            break
    return raw, complete


def kill_leaf(leaf):
    (leaf / "cgroup.kill").write_text("1")
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        current = (leaf / "cgroup.events").read_text()
        if "populated 0" in current.splitlines():
            return []
        # Kernel state synchronization; no fixed reproduction sleep.
        select.select([], [], [], 0.02)
    return [int(pid) for pid in (leaf / "cgroup.procs").read_text().split()]


def collect_output(process, leaf, mode, deadline):
    output = {"stdout": bytearray(), "stderr": bytearray()}
    timed_out = manual = exceeded = control_ready = False
    with selectors.DefaultSelector() as selector:
        for name, stream in [("stdout", process.stdout), ("stderr", process.stderr)]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while True:
            if time.monotonic() >= deadline and process.poll() is None:
                timed_out = True
                kill_leaf(leaf)
            for key, _mask in selector.select(timeout=0 if process.poll() is not None else 0.05):
                chunk = os.read(key.fd, 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if sum(len(value) for value in output.values()) + len(chunk) > OUTPUT_LIMIT:
                    exceeded = True
                    kill_leaf(leaf)
                    break
                output[key.data].extend(chunk)
            if mode in {"probe-manual-kill", "probe-timeout"} and b'{"control": "ready"}\n' in output["stdout"]:
                control_ready = True
            if mode == "probe-manual-kill" and control_ready and process.poll() is None and not manual:
                manual = True
                kill_leaf(leaf)
            if exceeded or (process.poll() is not None and not selector.select(timeout=0)):
                break
        process.wait(timeout=3)
    return {"returncode": process.returncode, "timedOut": timed_out, "manualKill": manual,
            "outputBounded": not exceeded, "stdoutBytes": len(output["stdout"]), "stderrBytes": len(output["stderr"]),
            "stdoutSha256": hashlib.sha256(output["stdout"]).hexdigest(), "stderrSha256": hashlib.sha256(output["stderr"]).hexdigest(),
            "allocationProgressMiB": [], "controlReadyObserved": control_ready}, bytes(output["stdout"])


def supervise(mode, variant):
    require_environment()
    os.umask(0o077)
    RECEIPT_DIR.mkdir(mode=0o700)
    started = time.monotonic()
    deadline_seconds = 2 if mode == "probe-timeout" else 40
    receipt = {"kind": KIND, "guardSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "mode": mode, "variant": variant, "status": "infrastructure-error", "classification": "setup-failed",
               "memoryLimitVerified": False, "settings": {"memoryLimitBytes": MEMORY_BYTES, "swapMaxBytes": 0,
                   "oomGroup": 1, "maximumAllocationMiB": ALLOCATION_MIB_MAX, "deadlineSeconds": deadline_seconds,
                   "outputLimitBytes": OUTPUT_LIMIT, "minimumHeadroomMiB": HEADROOM_MIB},
               "supervisor": {"uid": os.geteuid(), "pid": os.getpid(), "cgroupBefore": Path("/proc/self/cgroup").read_text().strip()},
               "cleanup": {"leafKilled": False, "populatedZero": False, "leafRemoved": False,
                           "memoryControllerRestored": False, "remainingPids": []}}
    write_receipt(receipt)
    leaf = CGROUP_ROOT / f"bugarcade-workload-{os.getpid()}-{uuid.uuid4().hex}"
    child = kernel_fd = metadata_read = metadata_write = None
    enabled_here, subtree_before = False, None
    stdout = b""
    previous_handlers = {}

    def interrupted(_signum, _frame):
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, signal.SIG_IGN)
        receipt["cancellationObserved"] = True
        raise GuardError("Supervisor interrupted; cleanup required.")

    try:
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous_handlers[signum] = signal.signal(signum, interrupted)
        receipt["inputs"] = bind_inputs(mode)
        if mode == "worker":
            receipt["variant"] = request_variant()
        memory = {parts[0].rstrip(":"): int(parts[1]) for line in Path("/proc/meminfo").read_text().splitlines()
                  if len(parts := line.split()) >= 2 and parts[0] in {"MemTotal:", "MemAvailable:"}}
        receipt["guestMemoryKiB"] = memory
        if min(memory["MemTotal"], memory["MemAvailable"]) < MEMORY_BYTES // 1024 + HEADROOM_MIB * 1024:
            raise GuardError("VM has insufficient observer headroom beyond the workload leaf.")
        if not stat.S_ISCHR(Path("/dev/kmsg").stat().st_mode):
            raise GuardError("Trusted guest kernel record device is unavailable.")
        kernel_fd = os.open("/dev/kmsg", os.O_RDONLY | os.O_NONBLOCK)
        os.lseek(kernel_fd, 0, os.SEEK_END)
        mounted = any(" /sys/fs/cgroup " in row and " - cgroup2 " in row for row in Path("/proc/self/mountinfo").read_text().splitlines())
        if not mounted or "memory" not in (CGROUP_ROOT / "cgroup.controllers").read_text().split():
            raise GuardError("Kernel cgroup2 memory controller unavailable.")
        subtree_before = sorted((CGROUP_ROOT / "cgroup.subtree_control").read_text().split())
        if "memory" not in subtree_before:
            (CGROUP_ROOT / "cgroup.subtree_control").write_text("+memory")
            enabled_here = True
        leaf.mkdir(mode=0o755)
        for name, value in {"memory.max": str(MEMORY_BYTES), "memory.swap.max": "0", "memory.oom.group": "1"}.items():
            (leaf / name).write_text(value)
        readback = {name: (leaf / name).read_text().strip() for name in ("memory.max", "memory.swap.max", "memory.oom.group")}
        if readback != {"memory.max": str(MEMORY_BYTES), "memory.swap.max": "0", "memory.oom.group": "1"} or not (leaf / "cgroup.kill").exists():
            raise GuardError("Kernel memory limit readback/cleanup control unavailable.")
        receipt["leaf"] = {"path": str(leaf), "kernelPath": f"/{leaf.name}", "ownerUid": leaf.stat().st_uid, "readback": readback}
        receipt["events"] = {"before": parse_events((leaf / "memory.events.local").read_text())}
        metadata_read, metadata_write = os.pipe()
        command = [sys.executable, GUARD_PATH, "--contained-child", mode, str(leaf), str(metadata_write)] + ([variant] if variant else [])
        child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=(metadata_write,), close_fds=True, cwd="/opt/bugarcade",
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/tmp/home", "BUGARCADE_SANDBOX": "1",
                 "BUGARCADE_CGROUP_GUARD": "1", "BUGARCADE_GUARD_CHILD": "1", "NODE_ENV": "test",
                 "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "GOMAXPROCS": "2", "UV_THREADPOOL_SIZE": "2"})
        os.close(metadata_write)
        metadata_write = None
        (leaf / "cgroup.procs").write_text(str(child.pid))
        receipt["leaf"]["childPid"] = child.pid
        child.stdin.write(b"G")
        child.stdin.flush()
        metadata = read_metadata(metadata_read)
        observed = read_status(child.pid)
        membership = Path(f"/proc/{child.pid}/cgroup").read_text().strip()
        validate_child(metadata, observed, membership, leaf, child.pid)
        if str(child.pid) not in (leaf / "cgroup.procs").read_text().split():
            raise GuardError("Child absent from kernel workload membership.")
        receipt["child"] = {**metadata, "observedStatus": observed}
        receipt["supervisor"]["outsideLeaf"] = f"/{leaf.name}" not in Path("/proc/self/cgroup").read_text()
        if receipt["supervisor"]["outsideLeaf"] is not True:
            raise GuardError("Supervisor must remain outside the workload memory leaf.")
        write_receipt(receipt)
        child.stdin.write(b"X")
        child.stdin.flush()
        child.stdin.close()
        execution_deadline = min(started + 40, time.monotonic() + 2) if mode == "probe-timeout" else started + deadline_seconds
        execution, stdout = collect_output(child, leaf, mode, execution_deadline)
        receipt["execution"] = execution
        if bind_inputs(mode) != receipt["inputs"]:
            raise GuardError("Bound root-owned inputs changed during execution.")
        if mode == "probe-memory":
            progress = []
            for line in stdout.splitlines():
                value = json.loads(line)
                if set(value) != {"allocatedMiB"} or type(value["allocatedMiB"]) is not int:
                    raise GuardError("Memory probe completed or emitted unexpected progress; no limit pass.")
                progress.append(value["allocatedMiB"])
            receipt["execution"]["allocationProgressMiB"] = progress
    except Exception as error:
        receipt["errorType"] = type(error).__name__
    finally:
        if leaf.exists():
            try:
                remaining = kill_leaf(leaf)
                receipt["cleanup"].update(leafKilled=True, populatedZero=not remaining, remainingPids=remaining)
                if child is not None:
                    child.wait(timeout=3)
                if "events" in receipt:
                    receipt["events"]["after"] = parse_events((leaf / "memory.events.local").read_text())
                    receipt["events"]["delta"] = delta_events(receipt["events"]["before"], receipt["events"]["after"])
                leaf.rmdir()
                receipt["cleanup"]["leafRemoved"] = not leaf.exists()
            except Exception as error:
                receipt["cleanup"]["errorType"] = type(error).__name__
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=3)
        for descriptor in (metadata_read, metadata_write):
            if descriptor is not None:
                os.close(descriptor)
        if kernel_fd is not None:
            raw, complete = drain_kernel(kernel_fd)
            os.close(kernel_fd)
            records = parse_oom_records(raw)
            path = receipt.get("leaf", {}).get("kernelPath")
            pid = receipt.get("leaf", {}).get("childPid")
            matching = [row for row in records if row["constraint"] == "CONSTRAINT_MEMCG" and row["oomMemcg"] == path
                        and row["taskMemcg"] == path and row["pid"] == pid]
            receipt["kernel"] = {"source": "/dev/kmsg", "complete": complete, "byteLimit": KERNEL_LIMIT,
                "bytesRead": len(raw), "oomRecords": records, "matchingRecords": matching,
                "globalOomObserved": any(row["constraint"] != "CONSTRAINT_MEMCG" for row in records)}
        try:
            if enabled_here:
                (CGROUP_ROOT / "cgroup.subtree_control").write_text("-memory")
            subtree_after = sorted((CGROUP_ROOT / "cgroup.subtree_control").read_text().split())
            receipt["cleanup"].update(subtreeBefore=subtree_before, subtreeAfter=subtree_after,
                memoryControllerRestored=subtree_before is not None and subtree_before == subtree_after)
        except OSError as error:
            receipt["cleanup"]["restoreErrorType"] = type(error).__name__
        receipt["supervisor"]["cgroupAfter"] = Path("/proc/self/cgroup").read_text().strip()
        if "execution" in receipt:
            receipt["execution"]["elapsedMs"] = round((time.monotonic() - started) * 1000, 3)
        required_cleanup = ["leafKilled", "populatedZero", "leafRemoved", "memoryControllerRestored"]
        if not all(receipt["cleanup"].get(key) is True for key in required_cleanup):
            receipt["classification"] = "cleanup-failed"
        elif "errorType" not in receipt:
            try:
                verdict = classify_execution(mode, receipt["execution"], receipt["events"], receipt["kernel"],
                                             receipt["leaf"]["kernelPath"], receipt["child"]["pid"])
                receipt.update(classification=verdict["classification"], memoryLimitVerified=verdict["memoryLimitVerified"])
                if verdict["accepted"]:
                    receipt["status"] = "probe-verified" if mode in PROBE_MODES else "completed"
            except (GuardError, KeyError) as error:
                receipt["errorType"] = type(error).__name__
        write_receipt(receipt)
        for signum, previous in previous_handlers.items():
            signal.signal(signum, previous)
    if receipt["status"] == "completed":
        sys.stdout.buffer.write(stdout)
        sys.stdout.buffer.flush()
        return receipt["execution"]["returncode"]
    print(json.dumps({"kind": KIND, "status": receipt["status"], "classification": receipt["classification"],
                      "memoryLimitVerified": receipt["memoryLimitVerified"], "receipt": str(RECEIPT)}), flush=True)
    return 0 if receipt["status"] == "probe-verified" else 3


def main(args=None):
    args = sys.argv[1:] if args is None else args
    try:
        if args and args[0] == "--contained-child":
            return contained_child(args[1:])
        return supervise(*parse_mode(args))
    except Exception as error:
        print(json.dumps({"kind": KIND, "status": "infrastructure-error", "classification": "setup-failed",
                          "errorType": type(error).__name__, "memoryLimitVerified": False}), flush=True)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
