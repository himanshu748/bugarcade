"""Privilege transition contracts use system-call doubles, never change host credentials."""
import json
import sys
from types import SimpleNamespace

import pytest

from backend import sandbox_entry
from scripts.cloud_boundary_checks import decode_probe


@pytest.fixture
def kernel(monkeypatch):
    state = {"uid": 0, "gid": 0, "groups": [0], "calls": []}
    monkeypatch.setattr(sandbox_entry.sys, "platform", "linux")
    monkeypatch.setenv("BUGARCADE_SANDBOX", "1")
    monkeypatch.setattr(sandbox_entry.os, "getcwd", lambda: "/opt/bugarcade")
    monkeypatch.setattr(sandbox_entry.os, "geteuid", lambda: state["uid"])
    monkeypatch.setattr(sandbox_entry.os, "getuid", lambda: state["uid"])
    monkeypatch.setattr(sandbox_entry.os, "getegid", lambda: state["gid"])
    monkeypatch.setattr(sandbox_entry.os, "getgroups", lambda: state["groups"])

    def change(name, value):
        state["calls"].append((name, value))
        state[{"setgroups": "groups", "setgid": "gid", "setuid": "uid"}[name]] = value

    monkeypatch.setattr(sandbox_entry.os, "setgroups", lambda value: change("setgroups", value))
    monkeypatch.setattr(sandbox_entry.os, "setgid", lambda value: change("setgid", value))
    monkeypatch.setattr(sandbox_entry.os, "setuid", lambda value: change("setuid", value))
    monkeypatch.setitem(sys.modules, "pwd", SimpleNamespace(getpwnam=lambda name: SimpleNamespace(pw_uid=1000, pw_gid=1000)))
    monkeypatch.setattr(sandbox_entry.ctypes, "CDLL", lambda *args, **kwargs: SimpleNamespace(prctl=lambda operation, *_: 0 if operation == 38 else 1))
    return state


def test_bootstrap_clears_groups_then_drops_gid_and_uid(kernel):
    identity = sandbox_entry.drop_privileges()
    assert kernel["calls"] == [("setgroups", []), ("setgid", 1000), ("setuid", 1000)]
    assert kernel["uid"] == kernel["gid"] == 1000 and kernel["groups"] == []
    assert identity == {"uid": 1000, "gid": 1000, "supplementaryGroups": [], "noNewPrivs": 1}


@pytest.mark.parametrize("fault", ["host", "marker", "cwd", "prctl", "root-account", "uid-stuck", "root-group"])
def test_bootstrap_fails_closed_before_submitted_execution(monkeypatch, kernel, fault):
    if fault == "host":
        monkeypatch.setattr(sandbox_entry.sys, "platform", "darwin")
    elif fault == "marker":
        monkeypatch.delenv("BUGARCADE_SANDBOX")
    elif fault == "cwd":
        monkeypatch.setattr(sandbox_entry.os, "getcwd", lambda: "/tmp/host")
    elif fault == "prctl":
        monkeypatch.setattr(sandbox_entry.ctypes, "CDLL", lambda *args, **kwargs: SimpleNamespace(prctl=lambda *_: -1))
    elif fault == "root-account":
        monkeypatch.setitem(sys.modules, "pwd", SimpleNamespace(getpwnam=lambda name: SimpleNamespace(pw_uid=0, pw_gid=0)))
    elif fault == "uid-stuck":
        monkeypatch.setattr(sandbox_entry.os, "setuid", lambda value: None)
    else:
        kernel.update(uid=1000, gid=1000, groups=[0])
    monkeypatch.setattr(sandbox_entry.subprocess, "Popen", lambda *_args, **_kwargs: pytest.fail("Submitted process started after failed privilege bootstrap"))
    with pytest.raises(RuntimeError):
        sandbox_entry.main()


@pytest.mark.parametrize("raw,stderr,code", [("", "trusted probe traceback", 1), ("not json", "startup failed", 1),
    (json.dumps({"kind": "real-cloud-boundary-probe", "checks": {}}), "", 2)])
def test_probe_infrastructure_failure_keeps_stderr_and_never_claims_boundary_pass(raw, stderr, code):
    record = {}
    with pytest.raises(ValueError):
        decode_probe(raw, stderr, code, record)
    assert record["probeReturncode"] == code and record["probeStderr"] == stderr
    assert record.get("status") != "passed"


def test_helper_affinity_and_task_limits_are_applied_before_launch(monkeypatch):
    monkeypatch.setattr(sandbox_entry.os, "geteuid", lambda: 1001)
    affinity = set(range(64))
    def restrict(_pid, selected):
        nonlocal affinity
        affinity = selected
    monkeypatch.setattr(sandbox_entry.os, "sched_getaffinity", lambda _pid: affinity, raising=False)
    monkeypatch.setattr(sandbox_entry.os, "sched_setaffinity", restrict, raising=False)
    limits = {}
    monkeypatch.setattr(sandbox_entry.resource, "setrlimit", lambda name, value: limits.update({name: value}))
    result = sandbox_entry.apply_limits()
    assert result["cpuAffinity"] == [0, 1, 2, 3]
    assert limits[sandbox_entry.resource.RLIMIT_NPROC] == (256, 256)
    assert limits[sandbox_entry.resource.RLIMIT_CPU] == (40, 40)


@pytest.mark.parametrize("available", [set(), set(range(8))])
def test_unavailable_or_ineffective_affinity_fails_closed(monkeypatch, available):
    monkeypatch.setattr(sandbox_entry.os, "geteuid", lambda: 1001)
    monkeypatch.setattr(sandbox_entry.os, "sched_getaffinity", lambda _pid: available, raising=False)
    monkeypatch.setattr(sandbox_entry.os, "sched_setaffinity", lambda *_: None, raising=False)
    monkeypatch.setattr(sandbox_entry.resource, "setrlimit", lambda *_: pytest.fail("Limits reached after failed affinity"))
    with pytest.raises(RuntimeError):
        sandbox_entry.apply_limits()
