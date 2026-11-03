"""Host-safe contracts only. Synthetic kernel samples are not VM/OOM evidence."""
import copy
import errno
import json
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from backend import cgroup_guard as guard

LEAF = "/bugarcade-workload-800-" + "a" * 32
PID = 801
EVENTS = "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\nsock_throttled 0\n"
KERNEL = (f"6,42,123456,-;oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=/,mems_allowed=0,"
          f"oom_memcg={LEAF},task_memcg={LEAF},task=python3,pid={PID},uid=1001\n").encode()


def example(mode="probe-memory"):
    before = guard.parse_events(EVENTS)
    after = {key: value + (1 if key in guard.EVENT_KEYS else 0) for key, value in before.items()}
    events = {"before": before, "after": after, "delta": guard.delta_events(before, after)}
    records = guard.parse_oom_records(KERNEL)
    kernel = {"complete": True, "oomRecords": records, "matchingRecords": records, "globalOomObserved": False}
    execution = {"returncode": -signal.SIGKILL, "timedOut": False, "manualKill": False,
                 "outputBounded": True, "allocationProgressMiB": list(range(32, 993, 32)), "controlReadyObserved": False}
    if mode != "probe-memory":
        events["after"] = dict(before)
        events["delta"] = guard.delta_events(before, before)
        kernel.update(oomRecords=[], matchingRecords=[])
        execution.update(allocationProgressMiB=[], controlReadyObserved=True)
    return execution, events, kernel


@pytest.mark.parametrize("args,expected", [(["worker"], ("worker", None)),
    (["regression", "buggy"], ("regression", "buggy")), (["regression", "fixed"], ("regression", "fixed")),
    (["probe-memory"], ("probe-memory", None)), (["probe-timeout"], ("probe-timeout", None)),
    (["probe-manual-kill"], ("probe-manual-kill", None))])
def test_only_fixed_modes_admitted(args, expected):
    assert guard.parse_mode(args) == expected


@pytest.mark.parametrize("args", [[], ["sh", "-c", "anything"], ["worker", "/tmp/other"],
    ["regression", "../../other"], ["regression", "buggy;echo secret"], ["probe-memory", "999999"],
    ["probe-timeout", "--timeout", "120"], ["regression", "fixed", "extra"]])
def test_command_and_parameter_injection_refused(args):
    with pytest.raises(guard.GuardError):
        guard.parse_mode(args)


def test_workload_commands_cannot_choose_arbitrary_tests_or_source():
    assert guard.workload_command("worker", None)[1:] == ["/opt/bugarcade/backend/sandbox_entry.py", "/tmp/request.json"]
    assert guard.workload_command("regression", "fixed")[1:] == ["/opt/bugarcade/backend/regression_entry.py", "fixed"]
    with pytest.raises(guard.GuardError):
        guard.workload_command("regression", "/tmp/arbitrary.test.mjs")
    with pytest.raises(guard.GuardError):
        guard.workload_command("probe-memory", None)


@pytest.mark.parametrize("text", ["oom_kill 1", EVENTS + "oom 1\n", EVENTS.replace("max 0", "max -1"),
    EVENTS.replace("oom 0", "oom NaN"), "x" * 4097])
def test_malformed_or_missing_kernel_counters_refused(text):
    with pytest.raises(guard.GuardError):
        guard.parse_events(text)


def test_counter_resets_or_removed_keys_refused():
    before = guard.parse_events(EVENTS)
    before["max"] = 1
    with pytest.raises(guard.GuardError):
        guard.delta_events(before, guard.parse_events(EVENTS))
    with pytest.raises(guard.GuardError):
        guard.delta_events(before, {"max": 1})


def test_real_kernel_record_shape_parses_exact_memcg_pid_uid():
    assert guard.parse_oom_records(KERNEL) == [{"constraint": "CONSTRAINT_MEMCG", "oomMemcg": LEAF,
                                               "taskMemcg": LEAF, "pid": PID, "uid": 1001}]
    assert guard.parse_oom_records(b"6,43,0,-;ordinary kernel diagnostic\n") == []


def test_kernel_log_ceiling_is_fail_closed():
    with pytest.raises(guard.GuardError):
        guard.parse_oom_records(b"x" * (guard.KERNEL_LIMIT + 1))


def test_synthetic_matched_memcg_sample_checks_contract_only():
    result = guard.classify_execution("probe-memory", *example(), LEAF, PID)
    assert result == {"accepted": True, "classification": "memory-limit-probe", "memoryLimitVerified": True}


@pytest.mark.parametrize("counter", ["max", "oom", "oom_kill", "oom_group_kill"])
def test_no_individual_oom_counter_can_be_missing(counter):
    execution, events, kernel = example()
    events["after"][counter] = 0
    events["delta"] = guard.delta_events(events["before"], events["after"])
    assert not guard.classify_execution("probe-memory", execution, events, kernel, LEAF, PID)["accepted"]


def test_generic137_and_oom_kill_alone_never_verify_memory():
    execution, events, kernel = example()
    execution["returncode"] = 137
    assert not guard.classify_execution("probe-memory", execution, events, kernel, LEAF, PID)["accepted"]
    execution["returncode"] = -9
    events["after"] = {**events["before"], "oom_kill": 1}
    events["delta"] = guard.delta_events(events["before"], events["after"])
    kernel.update(oomRecords=[], matchingRecords=[])
    assert not guard.classify_execution("probe-memory", execution, events, kernel, LEAF, PID)["accepted"]


@pytest.mark.parametrize("field,value", [("constraint", "CONSTRAINT_NONE"), ("oomMemcg", "/another"),
                                        ("taskMemcg", LEAF + "-lookalike"), ("pid", PID + 1)])
def test_wrong_kernel_attribution_refused(field, value):
    execution, events, kernel = example()
    kernel["oomRecords"][0][field] = value
    kernel["matchingRecords"] = []
    kernel["globalOomObserved"] = field == "constraint"
    assert not guard.classify_execution("probe-memory", execution, events, kernel, LEAF, PID)["accepted"]


def test_global_oom_or_incomplete_logs_override_plausible_local_counters():
    execution, events, kernel = example()
    kernel["oomRecords"].append({"constraint": "CONSTRAINT_NONE", "oomMemcg": None, "taskMemcg": "/", "pid": 4, "uid": 0})
    kernel["globalOomObserved"] = True
    assert not guard.classify_execution("probe-memory", execution, events, kernel, LEAF, PID)["accepted"]
    execution, events, kernel = example()
    kernel["complete"] = False
    assert not guard.classify_execution("probe-memory", execution, events, kernel, LEAF, PID)["accepted"]


@pytest.mark.parametrize("progress", [[], [32, 64, 96], list(range(32, 993, 64)), list(range(32, 1185, 32))])
def test_allocation_witness_must_be_bounded_contiguous_and_near_limit(progress):
    execution, events, kernel = example()
    execution["allocationProgressMiB"] = progress
    assert not guard.classify_execution("probe-memory", execution, events, kernel, LEAF, PID)["accepted"]


@pytest.mark.parametrize("mode,flag,classification", [("probe-manual-kill", "manualKill", "manual-kill-control"),
                                                      ("probe-timeout", "timedOut", "timeout-control")])
def test_explicit_control_requires_ready_kill_and_zero_local_oom(mode, flag, classification):
    execution, events, kernel = example(mode)
    execution[flag] = True
    assert guard.classify_execution(mode, execution, events, kernel, LEAF, PID) == {
        "accepted": True, "classification": classification, "memoryLimitVerified": False}
    execution["controlReadyObserved"] = False
    assert not guard.classify_execution(mode, execution, events, kernel, LEAF, PID)["accepted"]
    execution["controlReadyObserved"] = True
    events["after"]["max"] = 1
    events["delta"] = guard.delta_events(events["before"], events["after"])
    assert not guard.classify_execution(mode, execution, events, kernel, LEAF, PID)["accepted"]


@pytest.mark.parametrize("mode", ["worker", "regression"])
def test_workload_oom_never_counts_as_reproduction(mode):
    result = guard.classify_execution(mode, *example(), LEAF, PID)
    assert result == {"accepted": False, "classification": "memory-limit-exceeded", "memoryLimitVerified": False}


def test_timeout_output_failure_and_child_crash_are_infrastructure():
    for key, value, classification in [("timedOut", True, "deadline-exceeded"),
                                        ("outputBounded", False, "output-limit-exceeded"),
                                        ("returncode", 1, "workload-failed")]:
        execution, events, kernel = example("worker")
        execution["returncode"] = 0
        execution[key] = value
        result = guard.classify_execution("worker", execution, events, kernel, LEAF, PID)
        assert result["classification"] == classification
        assert result["accepted"] is False


@pytest.mark.parametrize("code", [0, 2])
def test_only_clean_worker_outcomes_keep_original_assertion_exit(code):
    execution, events, kernel = example("worker")
    execution["returncode"] = code
    assert guard.classify_execution("worker", execution, events, kernel, LEAF, PID)["accepted"]


def test_regression_entry_unexpected_exit2_is_not_browser_assertion_failure():
    execution, events, kernel = example("regression")
    execution["returncode"] = 2
    result = guard.classify_execution("regression", execution, events, kernel, LEAF, PID)
    assert result["accepted"] is False
    assert result["classification"] == "workload-failed"


@pytest.mark.parametrize("value", [{"variant": "buggy"}, {"variant": "fixed"}])
def test_worker_variant_is_read_from_bound_request_not_app_output(value, monkeypatch):
    monkeypatch.setattr(guard, "read_root_file", lambda path, maximum: json.dumps(value).encode())
    assert guard.request_variant() == value["variant"]


@pytest.mark.parametrize("value", [{}, {"variant": "../../fixed"}, {"variant": "fixed; anything"}, []])
def test_invalid_trusted_request_variant_refuses_before_child(value, monkeypatch):
    monkeypatch.setattr(guard, "read_root_file", lambda path, maximum: json.dumps(value).encode())
    with pytest.raises(guard.GuardError):
        guard.request_variant()


def child_admission():
    metadata = {"pid": PID, "identity": {"uid": 1001, "gid": 1001, "supplementaryGroups": [], "noNewPrivs": 1},
                "membership": f"0::{LEAF}", "permissionDenials": {key: True for key in guard.PERMISSIONS}}
    observed = {"uids": [1001] * 4, "gids": [1001] * 4, "groups": [], "noNewPrivs": 1, "capEff": "0", "capPrm": "0"}
    return metadata, observed


def test_child_admitted_only_after_kernel_identity_and_exact_leaf_match():
    metadata, observed = child_admission()
    guard.validate_child(metadata, observed, f"0::{LEAF}", Path("/sys/fs/cgroup" + LEAF), PID)
    for field, value in [("uids", [0, 1001, 0, 1001]), ("gids", [0] * 4), ("groups", [0]),
                         ("noNewPrivs", 0), ("capEff", "1"), ("capPrm", "1")]:
        changed = copy.deepcopy(observed)
        changed[field] = value
        with pytest.raises(guard.GuardError):
            guard.validate_child(metadata, changed, f"0::{LEAF}", Path("/sys/fs/cgroup" + LEAF), PID)
    with pytest.raises(guard.GuardError):
        guard.validate_child(metadata, observed, "0::/", Path("/sys/fs/cgroup" + LEAF), PID)


@pytest.mark.parametrize("permission", sorted(guard.PERMISSIONS))
def test_any_writable_control_or_kernel_log_blocks_child_admission(permission):
    metadata, observed = child_admission()
    metadata["permissionDenials"][permission] = False
    with pytest.raises(guard.GuardError):
        guard.validate_child(metadata, observed, f"0::{LEAF}", Path("/sys/fs/cgroup" + LEAF), PID)


def test_root_input_symlink_rejected_without_following(tmp_path):
    source = tmp_path / "source.json"
    source.write_text("{}")
    link = tmp_path / "link.json"
    link.symlink_to(source)
    with pytest.raises(OSError) as error:
        guard.root_file(link, 4096)
    assert error.value.errno == errno.ELOOP


def test_pressure_cli_refuses_the_host_before_any_guest_operation():
    result = subprocess.run([sys.executable, "backend/cgroup_guard.py", "probe-memory"],
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")}, capture_output=True, text=True, timeout=5)
    assert result.returncode == 3
    receipt = json.loads(result.stdout)
    assert receipt["status"] == "infrastructure-error"
    assert receipt["classification"] == "setup-failed"
    assert receipt["memoryLimitVerified"] is False


def full_receipt(mode="probe-memory", variant=None):
    """Synthetic contract data only; never a provider receipt or resource proof."""
    execution, events, kernel = example(mode)
    metadata, observed = child_admission()
    if mode == "probe-manual-kill":
        execution["manualKill"] = True
    elif mode == "probe-timeout":
        execution["timedOut"] = True
    elif mode not in guard.PROBE_MODES:
        execution["returncode"] = 2 if mode == "worker" and variant == "buggy" else 0
    execution.update(stdoutBytes=1000, stderrBytes=0, stdoutSha256="a" * 64, stderrSha256="b" * 64, elapsedMs=1000)
    inputs = {} if mode in guard.PROBE_MODES else {path: "e" * 64 for path in (
        "/tmp/project/manifest.json", "/tmp/project/buggy/App.tsx", "/tmp/project/fixed/App.tsx",
        "/tmp/request.json" if mode == "worker" else "/tmp/regression.test.mjs")}
    receipt = {"kind": guard.KIND, "guardSha256": "d" * 64, "mode": mode, "variant": variant,
        "settings": {"memoryLimitBytes": guard.MEMORY_BYTES, "swapMaxBytes": 0, "oomGroup": 1,
                     "maximumAllocationMiB": guard.ALLOCATION_MIB_MAX, "deadlineSeconds": 2 if mode == "probe-timeout" else 40,
                     "outputLimitBytes": guard.OUTPUT_LIMIT, "minimumHeadroomMiB": guard.HEADROOM_MIB},
        "supervisor": {"uid": 0, "pid": 800, "cgroupBefore": "0::/", "cgroupAfter": "0::/", "outsideLeaf": True},
        "leaf": {"path": "/sys/fs/cgroup" + LEAF, "kernelPath": LEAF, "ownerUid": 0,
                 "readback": {"memory.max": str(guard.MEMORY_BYTES), "memory.swap.max": "0", "memory.oom.group": "1"}, "childPid": PID},
        "child": {**metadata, "observedStatus": observed}, "events": events,
        "kernel": {**kernel, "source": "/dev/kmsg", "byteLimit": guard.KERNEL_LIMIT, "bytesRead": 200},
        "execution": execution, "guestMemoryKiB": {"MemTotal": 2097152, "MemAvailable": 1900000}, "inputs": inputs,
        "cleanup": {"leafKilled": True, "populatedZero": True, "leafRemoved": True, "memoryControllerRestored": True,
                    "remainingPids": [], "subtreeBefore": ["cpu", "memory"], "subtreeAfter": ["cpu", "memory"]},
        "status": "probe-verified" if mode in guard.PROBE_MODES else "completed"}
    receipt.update(guard.classify_execution(mode, execution, events, kernel, LEAF, PID))
    receipt.pop("accepted")
    return receipt


@pytest.mark.parametrize("mode,variant", [("probe-memory", None), ("probe-manual-kill", None), ("probe-timeout", None),
                                         ("worker", "buggy"), ("worker", "fixed"), ("regression", "buggy"), ("regression", "fixed")])
def test_shared_validator_recomputes_valid_synthetic_contracts(mode, variant):
    sample = full_receipt(mode, variant)
    verdict = guard.validate_receipt(sample, mode=mode, expected_inputs=sample["inputs"],
                                     expected_guard_sha="d" * 64, expected_variant=variant)
    assert verdict["accepted"] is True
    assert verdict["memoryLimitVerified"] is (mode == "probe-memory")


@pytest.mark.parametrize("path,value", [
    (("kind",), "app-authored-result"), (("guardSha256",), "f" * 64), (("mode",), "worker"), (("variant",), "buggy"),
    (("settings", "memoryLimitBytes"), 2 * guard.MEMORY_BYTES), (("settings", "swapMaxBytes"), False),
    (("supervisor", "uid"), False), (("supervisor", "pid"), 801), (("supervisor", "outsideLeaf"), False),
    (("supervisor", "cgroupBefore"), ["0::/"]), (("supervisor", "cgroupAfter"), "0::" + LEAF),
    (("leaf", "ownerUid"), 1001), (("leaf", "childPid"), True), (("leaf", "readback", "memory.max"), "max"),
    (("child", "identity", "uid"), 0), (("child", "identity", "noNewPrivs"), True),
    (("child", "observedStatus", "capEff"), "1"), (("child", "membership"), "0::/"),
    (("child", "permissionDenials", "kernelWrite"), False), (("child", "permissionDenials", "receiptRead"), False),
    (("guestMemoryKiB", "MemAvailable"), 1400 * 1024), (("guestMemoryKiB", "MemTotal"), True),
    (("cleanup", "populatedZero"), False), (("cleanup", "remainingPids"), [PID]),
    (("cleanup", "subtreeAfter"), []), (("cleanup", "errorType"), "OSError"),
    (("kernel", "complete"), False), (("kernel", "globalOomObserved"), True),
    (("execution", "returncode"), 137), (("execution", "stdoutBytes"), True),
    (("execution", "outputBounded"), False), (("execution", "stdoutSha256"), "not-a-hash"),
    (("execution", "elapsedMs"), float("nan")), (("execution", "elapsedMs"), 45001),
    (("execution", "allocationProgressMiB"), [32.0]), (("events", "delta", "oom_kill"), 0),
    (("memoryLimitVerified",), False), (("status",), "completed"), (("errorType",), "GuardError"),
    (("cancellationObserved",), True)])
def test_shared_validator_rejects_trusted_receipt_contradictions(path, value):
    sample = full_receipt()
    parent = sample
    for key in path[:-1]:
        parent = parent[key]
    parent[path[-1]] = value
    with pytest.raises(guard.GuardError):
        guard.validate_receipt(sample, mode="probe-memory", expected_inputs={}, expected_guard_sha="d" * 64)


def test_shared_validator_binds_expected_source_and_request_hashes():
    sample = full_receipt("worker", "buggy")
    expected = dict(sample["inputs"])
    expected["/tmp/request.json"] = "f" * 64
    with pytest.raises(guard.GuardError):
        guard.validate_receipt(sample, mode="worker", expected_inputs=expected,
                               expected_guard_sha="d" * 64, expected_variant="buggy")
    with pytest.raises(guard.GuardError):
        guard.validate_receipt(sample, mode="worker", expected_inputs=sample["inputs"],
                               expected_guard_sha="d" * 64, expected_variant="fixed")


def test_shared_validator_checks_matching_kernel_victim_uid():
    sample = full_receipt()
    sample["kernel"]["oomRecords"][0]["uid"] = 999
    sample["kernel"]["matchingRecords"] = sample["kernel"]["oomRecords"]
    with pytest.raises(guard.GuardError):
        guard.validate_receipt(sample, mode="probe-memory", expected_inputs={}, expected_guard_sha="d" * 64)


def test_shared_validator_checks_aggregate_output_not_only_each_channel():
    sample = full_receipt("worker", "fixed")
    sample["execution"].update(stdoutBytes=guard.OUTPUT_LIMIT, stderrBytes=1)
    with pytest.raises(guard.GuardError):
        guard.validate_receipt(sample, mode="worker", expected_inputs=sample["inputs"],
                               expected_guard_sha="d" * 64, expected_variant="fixed")


@pytest.mark.parametrize("sample", [None, [], {}, {"kind": guard.KIND, "mode": "worker"}])
def test_shared_validator_malformed_receipt_is_never_evidence(sample):
    with pytest.raises(guard.GuardError):
        guard.validate_receipt(sample, mode="probe-memory", expected_inputs={}, expected_guard_sha="d" * 64)
