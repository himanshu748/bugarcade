"""Synthetic provider contracts only. No network, cloud resources or uploaded-code execution."""
import asyncio
import copy
import hashlib
import io
import json
import shutil
import sys
import zipfile
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.adapter import make_starter, validate_archive
from backend.config import ROOT, Settings
from backend.packaging import render_regression
from backend.regression_entry import main as entry_main
from backend.schemas import invariant_hash
from scripts import live_validation
from scripts import validate_regression as stage


def outcome(manifest, actions, variant):
    passed = variant == "fixed"
    return {"variant": variant, "testReturncode": 0 if passed else 1, "timedOut": False, "outputBounded": True,
            "tapSha256": hashlib.sha256(b"synthetic TAP output; no browser executed").hexdigest(),
            "result": {"status": "passed" if passed else "failed", "error": None, "variant": variant,
                "challengeId": manifest.id, "schedule": [row.model_dump() for row in manifest.schedule],
                "actions": [{"action": action, "status": "executed"} for action in actions],
                "assertion": {**manifest.assertion.model_dump(), "hash": invariant_hash(manifest),
                    "completion": manifest.completion.model_dump(), "pass": passed,
                    "actual": manifest.assertion.expected if passed else "Ship the rough cut"}}}


@pytest.fixture
def prepared(tmp_path, monkeypatch):
    job_id = "a" * 32
    root = tmp_path / "repo"
    folder = root / "evidence/jobs" / job_id
    folder.mkdir(parents=True)
    out = tmp_path / "prepared"
    out.mkdir()
    (out / "run-manifest.json").write_text("synthetic manifest; no provider execution")
    raw = make_starter(ROOT)
    (out / "starter.zip").write_bytes(raw)
    manifest, files, hashes = validate_archive(raw)
    actions = [row.model_dump() for row in manifest.actions]
    frozen = invariant_hash(manifest)
    guard_path = root / "backend/cgroup_guard.py"
    guard_path.parent.mkdir(parents=True)
    shutil.copy2(ROOT / "backend/cgroup_guard.py", guard_path)
    plan = {"input": {"project": "starter.zip", "sourceHashes": hashes, "invariantHash": frozen},
            "build": {"files": {"backend/cgroup_guard.py": hashlib.sha256(guard_path.read_bytes()).hexdigest()}}}
    summary = {"verified": True, "mode": "live", "runner": "modal-sandbox", "cohort": "submitted-example",
        "challengeId": manifest.id, "sourceHashes": hashes, "assertion": manifest.assertion.model_dump(),
        "completion": manifest.completion.model_dump(), "invariantHash": frozen,
        "schedule": [row.model_dump() for row in manifest.schedule], "actions": actions, "initialActions": actions,
        "provenance": [{"origin": "live-model", "outcome": "proposed", "providerCallAttempted": True,
                        "invariantHash": frozen, "proposedActions": actions}],
        "runs": [{"phase": "validation", "variant": variant, "result": outcome(manifest, actions, variant)["result"]}
                 for variant in ["buggy", "fixed"] * 3]}
    test = render_regression(manifest, hashes, frozen, actions, Path("/tmp/project")).encode()
    (folder / "source.zip").write_bytes(raw)
    (folder / "regression.test.mjs").write_bytes(test)
    (folder / "summary.json").write_text(json.dumps(summary))
    monkeypatch.setattr(stage, "ROOT", root)
    monkeypatch.setattr(stage, "OUT", out)
    monkeypatch.setattr(stage, "verify_prepared", lambda: plan)
    settings = Settings(root=root, data_dir=tmp_path / "data", live_enabled=True, budget_approved=True,
        approved_budget_usd=1, api_key="synthetic-not-a-credential", modal_credentials_present=True,
        modal_image_id="im-synthetic", modal_app="synthetic-app", input_usd_per_million=1.25,
        output_usd_per_million=4.25, sandbox_usd_per_hour=0.50)
    def approval(*, model_access=True):
        assert model_access is False
        return plan, settings
    monkeypatch.setattr(stage, "require_approval", approval)
    monkeypatch.setenv("BUGARCADE_APPROVED_JOB_ID", job_id)
    monkeypatch.setenv("BUGARCADE_APPROVED_REGRESSION_SHA256", hashlib.sha256(test).hexdigest())
    for name, status in [("image-build-receipt.json", "built-not-boundary-verified"),
                         ("boundary-receipt.json", "passed-awaiting-human-evidence-review")]:
        (tmp_path / name).write_text(json.dumps({"status": status, "imageId": settings.modal_image_id,
             "app": settings.modal_app, "manifestSha256": stage.sha(out / "run-manifest.json")}))
    return SimpleNamespace(job_id=job_id, root=root, folder=folder, out=out, manifest=manifest,
                           files=files, actions=actions, summary=summary, test=test, settings=settings, plan=plan)


def test_dry_review_never_imports_provider(prepared, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "modal", None)
    monkeypatch.setattr(sys, "argv", ["validate_regression.py", "--job-id", prepared.job_id])
    stage.main()
    result = json.loads(capsys.readouterr().out)
    assert result["status"] == "dry-run-only" and result["sandboxesCreated"] == 0
    assert result["regressionSha256"] == hashlib.sha256(prepared.test).hexdigest()
    assert not (prepared.out.parent / "regression-receipt.json").exists()


@pytest.mark.parametrize("change", ["recorded", "weakened", "source", "infrastructure", "provenance", "template", "symlink", "path"])
def test_review_rejects_unbound_or_untrusted_artifacts(prepared, change):
    data = copy.deepcopy(prepared.summary)
    if change == "recorded":
        data["mode"] = "recorded"
    elif change == "weakened":
        data["assertion"]["expected"] = ""
    elif change == "source":
        data["sourceHashes"]["buggy/App.tsx"] = "0" * 64
    elif change == "infrastructure":
        data["runs"][0]["result"]["status"] = "error"
    elif change == "provenance":
        data["provenance"][0]["origin"] = "authored-seed-plan"
    elif change == "template":
        (prepared.folder / "regression.test.mjs").write_text("throw new Error('untrusted test');")
    elif change == "symlink":
        (prepared.folder / "source.zip").rename(prepared.folder / "original.zip")
        (prepared.folder / "source.zip").symlink_to(prepared.folder / "original.zip")
    (prepared.folder / "summary.json").write_text(json.dumps(data))
    with pytest.raises(ValueError):
        stage.inspect_job("../outside" if change == "path" else prepared.job_id)


@pytest.mark.parametrize("change", ["exit", "timeout", "output", "hash", "actual", "actions", "schedule", "missing", "variant"])
def test_verifier_rejects_false_success(prepared, change):
    report = outcome(prepared.manifest, prepared.actions, "buggy")
    if change == "exit":
        report["testReturncode"] = 0
    elif change == "timeout":
        report["timedOut"] = True
    elif change == "output":
        report["outputBounded"] = False
    elif change == "hash":
        report["result"]["assertion"]["hash"] = "0" * 64
    elif change == "actual":
        report["result"]["assertion"]["actual"] = prepared.manifest.assertion.expected
    elif change == "actions":
        report["result"]["actions"] = []
    elif change == "schedule":
        report["result"]["schedule"] = []
    elif change == "missing":
        report["result"] = None
    elif change == "variant":
        report["result"]["variant"] = "fixed"
    with pytest.raises(ValueError):
        stage.validate_outcome(report, prepared.manifest, prepared.actions, "buggy")


class AsyncMethod:
    def __init__(self, method):
        self.aio = method


def guard_envelope(prepared, box, raw, variant, fault):
    """Complete synthetic kernel contract; this does not demonstrate VM enforcement."""
    leaf = "/bugarcade-workload-800-" + "a" * 32
    counters = {key: 0 for key in ("low", "high", "max", "oom", "oom_kill", "oom_group_kill", "sock_throttled")}
    inputs = {path: hashlib.sha256(text.encode()).hexdigest() for path, text in box.texts.items()}
    receipt = {
        "kind": "bugarcade-cgroup-guard-v1", "mode": "regression", "variant": variant,
        "status": "completed", "classification": "workload-completed", "memoryLimitVerified": False,
        "guardSha256": hashlib.sha256((prepared.root / "backend/cgroup_guard.py").read_bytes()).hexdigest(),
        "settings": {"memoryLimitBytes": 1024 * 1024 * 1024, "swapMaxBytes": 0, "oomGroup": 1,
                     "maximumAllocationMiB": 1152, "deadlineSeconds": 40, "outputLimitBytes": 1024 * 1024,
                     "minimumHeadroomMiB": 384},
        "inputs": inputs, "guestMemoryKiB": {"MemTotal": 2097152, "MemAvailable": 1835008},
        "supervisor": {"uid": 0, "pid": 800, "outsideLeaf": True, "cgroupBefore": "0::/", "cgroupAfter": "0::/"},
        "leaf": {"path": "/sys/fs/cgroup" + leaf, "kernelPath": leaf, "ownerUid": 0, "childPid": 801,
                 "readback": {"memory.max": "1073741824", "memory.swap.max": "0", "memory.oom.group": "1"}},
        "child": {"pid": 801, "membership": "0::" + leaf,
                  "identity": {"uid": 1001, "gid": 1001, "supplementaryGroups": [], "noNewPrivs": 1},
                  "observedStatus": {"uids": [1001] * 4, "gids": [1001] * 4, "groups": [], "noNewPrivs": 1,
                                     "capEff": "0000000000000000", "capPrm": "0000000000000000"},
                  "permissionDenials": {name: True for name in ("limitWrite", "escapeWrite", "subgroupCreate", "receiptRead", "kernelWrite")}},
        "events": {"before": counters.copy(), "after": counters.copy(), "delta": counters.copy()},
        "kernel": {"source": "/dev/kmsg", "complete": True, "byteLimit": 128 * 1024, "bytesRead": 0,
                   "oomRecords": [], "matchingRecords": [], "globalOomObserved": False},
        "execution": {"returncode": 0, "timedOut": False, "manualKill": False, "outputBounded": True,
                      "elapsedMs": 1200,
                      "stdoutSha256": hashlib.sha256(raw.encode()).hexdigest(), "stdoutBytes": len(raw.encode()),
                      "stderrSha256": hashlib.sha256(b"").hexdigest(), "stderrBytes": 0,
                      "allocationProgressMiB": [], "controlReadyObserved": False},
        "cleanup": {"leafKilled": True, "populatedZero": True, "leafRemoved": True,
                    "memoryControllerRestored": True, "remainingPids": [], "subtreeBefore": ["memory"], "subtreeAfter": ["memory"]},
    }
    if fault == "guard-inputs":
        receipt["inputs"]["/tmp/regression.test.mjs"] = "0" * 64
    elif fault == "guard-hash":
        receipt["guardSha256"] = "0" * 64
    elif fault == "guard-variant":
        receipt["variant"] = "fixed" if variant == "buggy" else "buggy"
    elif fault == "guard-stdout":
        receipt["execution"]["stdoutSha256"] = "0" * 64
    elif fault == "guard-exit":
        receipt["execution"]["returncode"] = 2
    elif fault == "guard-oom":
        receipt["events"]["after"]["oom_kill"] = 1
        receipt["events"]["delta"]["oom_kill"] = 1
    elif fault == "guard-cleanup":
        receipt["cleanup"]["leafRemoved"] = False
    elif fault == "guard-child-root":
        receipt["child"]["identity"]["uid"] = 0
    elif fault == "guard-child-caps":
        receipt["child"]["observedStatus"]["capEff"] = "0000000000000001"
    elif fault == "guard-escape":
        receipt["child"]["permissionDenials"]["escapeWrite"] = False
    elif fault == "guard-status":
        receipt["status"] = "infrastructure-error"
    value = {"uid": 0, "mode": "0600", "directoryUid": 0, "directoryMode": "0700", "receipt": receipt,
             "sha256": hashlib.sha256((json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()).hexdigest()}
    if fault == "guard-owner":
        value["uid"] = 1001
    elif fault == "guard-mode":
        value["mode"] = "0644"
    elif fault == "guard-directory":
        value["directoryMode"] = "0777"
    elif fault == "guard-file-hash":
        value["sha256"] = "0" * 64
    return value


def fake_provider(prepared, monkeypatch, fault=None):
    sandboxes, creations = [], []
    entered = asyncio.Event()

    async def lookup(*args, **kwargs):
        if fault == "lookup":
            raise RuntimeError("Synthetic lookup failure")
        assert kwargs == {"create_if_missing": False}
        return object()

    async def create(*args, **kwargs):
        creations.append(kwargs)
        texts = {}
        box = SimpleNamespace(object_id=f"sb-synthetic-{len(sandboxes)}", terminated=False, texts=texts)

        async def write(text, path):
            texts[path] = text

        async def read(path):
            assert path == "/tmp/regression-tap.txt"
            return b"synthetic TAP output; no browser executed"

        async def execute(*command, **options):
            if command == ("python3", "-c", stage.GUARD_INSPECTION):
                result = guard_envelope(prepared, box, box.raw, box.variant, fault)

                async def stdout():
                    return "x" * (128 * 1024 + 1) if fault == "guard-large" else json.dumps(result)

                async def wait():
                    return 1 if fault == "guard-missing" else 0

                return SimpleNamespace(stdout=SimpleNamespace(read=AsyncMethod(stdout)), wait=AsyncMethod(wait),
                                       returncode=1 if fault == "guard-missing" else 0)
            entered.set()
            if fault == "startup":
                raise RuntimeError("Synthetic startup failure")
            if fault == "timeout":
                raise TimeoutError("Synthetic timeout")
            if fault == "cancel":
                await asyncio.Event().wait()
            assert command[:3] == ("python3", "backend/cgroup_guard.py", "regression")
            report = outcome(prepared.manifest, prepared.actions, command[3])
            if fault == "verdict":
                report["result"]["status"] = "error"
            box.raw, box.variant = json.dumps(report), command[3]
            async def stdout():
                return box.raw
            async def wait():
                return 0
            return SimpleNamespace(stdout=SimpleNamespace(read=AsyncMethod(stdout)), wait=AsyncMethod(wait), returncode=0)

        async def terminate(**options):
            assert options == {"wait": True}
            box.terminated = True
            if fault == "termination":
                raise RuntimeError("Synthetic termination uncertainty")

        async def poll():
            return 0 if box.terminated and fault != "poll" else None

        box.filesystem = SimpleNamespace(write_text=AsyncMethod(write), read_bytes=AsyncMethod(read))
        box.exec, box.terminate, box.poll = AsyncMethod(execute), AsyncMethod(terminate), AsyncMethod(poll)
        sandboxes.append(box)
        return box

    module = SimpleNamespace(App=SimpleNamespace(lookup=AsyncMethod(lookup)),
        Image=SimpleNamespace(from_id=lambda value: value), Sandbox=SimpleNamespace(create=AsyncMethod(create)))
    monkeypatch.setitem(sys.modules, "modal", module)
    return sandboxes, creations, entered


def test_two_runs_use_exact_template_and_no_secrets_then_refuse_duplicate(prepared, monkeypatch):
    sandboxes, creations, _ = fake_provider(prepared, monkeypatch)
    asyncio.run(stage.execute(prepared.job_id))
    receipt = json.loads((prepared.out.parent / "regression-receipt.json").read_text())
    assert receipt["status"] == "passed-awaiting-human-evidence-review"
    assert [run["status"] for run in receipt["runs"]] == ["intended-failure", "passed"]
    assert all(run["terminationConfirmed"] for run in receipt["runs"])
    assert len(sandboxes) == 2 and all(box.terminated for box in sandboxes)
    for box, config in zip(sandboxes, creations, strict=True):
        assert box.texts["/tmp/regression.test.mjs"].encode() == prepared.test
        assert config["block_network"] and not config["secrets"] and not config["volumes"]
        assert config["include_oidc_identity_token"] is False and config["timeout"] == 45
        assert config["cpu"] == (1.0, 2.0) and config["memory"] == (2048, 2048)
        assert config["runtime"] == "vm" and config["env"]["BUGARCADE_CGROUP_GUARD"] == "1"
        assert set(config["env"]) == {"HOME", "NODE_ENV", "BUGARCADE_SANDBOX", "BUGARCADE_CGROUP_GUARD"}
    assert receipt["runtimeRequested"] == "vm"
    assert all(run["guard"]["mode"] == "regression" and run["guard"]["classification"] == "workload-completed"
               for run in receipt["runs"])
    with pytest.raises(FileExistsError):
        asyncio.run(stage.execute(prepared.job_id))
    assert len(sandboxes) == 2


@pytest.mark.parametrize("fault", ["lookup", "startup", "timeout", "verdict", "termination", "poll", "cancel"])
def test_failure_cleanup_stops_second_run_and_preserves_receipt(prepared, monkeypatch, fault):
    async def exercise():
        sandboxes, _, entered = fake_provider(prepared, monkeypatch, fault)
        task = asyncio.create_task(stage.execute(prepared.job_id))
        if fault == "cancel":
            await entered.wait()
            task.cancel()
        with pytest.raises((ValueError, RuntimeError, TimeoutError, asyncio.CancelledError)):
            await task
        assert len(sandboxes) <= 1 and all(box.terminated for box in sandboxes)
    asyncio.run(exercise())
    receipt = json.loads((prepared.out.parent / "regression-receipt.json").read_text())
    assert receipt["status"] == "failed-or-cancelled-no-auto-retry" and receipt["finishedAt"]


@pytest.mark.parametrize("fault", ["guard-missing", "guard-large", "guard-owner", "guard-mode", "guard-directory",
    "guard-file-hash", "guard-hash", "guard-inputs", "guard-variant", "guard-stdout", "guard-exit", "guard-oom",
    "guard-cleanup", "guard-child-root", "guard-child-caps", "guard-escape", "guard-status"])
def test_trusted_vm_receipt_contradictions_stop_before_second_test(prepared, monkeypatch, fault):
    sandboxes, _creations, _entered = fake_provider(prepared, monkeypatch, fault)
    with pytest.raises((ValueError, RuntimeError)):
        asyncio.run(stage.execute(prepared.job_id))
    assert len(sandboxes) == 1 and sandboxes[0].terminated
    receipt = json.loads((prepared.out.parent / "regression-receipt.json").read_text())
    assert receipt["status"] == "failed-or-cancelled-no-auto-retry"
    assert [run["status"] for run in receipt["runs"]] == ["started"]
    assert receipt["runs"][0]["terminationConfirmed"]


def test_sdk_pin_is_checked_before_provider_import_or_creation(prepared, monkeypatch):
    monkeypatch.setattr(stage, "version", lambda _name: "1.5.2")
    monkeypatch.setitem(sys.modules, "modal", None)
    with pytest.raises(ValueError, match="pinned Modal 1.6.3"):
        asyncio.run(stage.execute(prepared.job_id))
    receipt = json.loads((prepared.out.parent / "regression-receipt.json").read_text())
    assert receipt["status"] == "failed-or-cancelled-no-auto-retry" and receipt["runs"] == []


def test_compute_only_regression_needs_no_inference_key_and_cannot_create_model_client(prepared, monkeypatch):
    from backend import planner

    settings = replace(prepared.settings, api_key="", modal_proxy_token="", model_provider="modal",
                       model="synthetic-reviewed-endpoint.us-west.modal.direct")
    assert settings.model_api_key == "" and settings.model_reasons
    assert settings.compute_reasons == []
    prepared.plan.update(model={"provider": settings.model_provider, "endpoint": settings.model_endpoint, "model": settings.model},
                         budget={"smallestPracticalAllowance": 0.30})
    monkeypatch.setattr(live_validation, "Settings", lambda: settings)
    monkeypatch.setattr(live_validation, "verify_prepared", lambda: prepared.plan)
    monkeypatch.setattr(live_validation, "OUT", prepared.out)
    monkeypatch.setenv("BUGARCADE_APPROVED_MANIFEST_SHA256", stage.sha(prepared.out / "run-manifest.json"))
    monkeypatch.setattr(stage, "require_approval", live_validation.require_approval)

    def forbidden_model(*_args, **_kwargs):
        pytest.fail("A compute-only regression must not construct a model or inference HTTP client")

    monkeypatch.setattr(planner, "Planner", forbidden_model)
    monkeypatch.setattr(planner.httpx, "AsyncClient", forbidden_model)
    with pytest.raises(ValueError, match="inference stages also require model access"):
        live_validation.require_approval()
    sandboxes, _creations, _entered = fake_provider(prepared, monkeypatch)
    asyncio.run(stage.execute(prepared.job_id))
    receipt = json.loads((prepared.out.parent / "regression-receipt.json").read_text())
    assert receipt["status"] == "passed-awaiting-human-evidence-review"
    assert len(sandboxes) == 2 and all(box.terminated for box in sandboxes)
    assert [run["status"] for run in receipt["runs"]] == ["intended-failure", "passed"]


def test_supervisor_inputs_bind_exact_fixed_paths_and_exported_test(prepared):
    context = stage.inspect_job(prepared.job_id)
    inputs = stage.expected_regression_inputs(context)
    assert set(inputs) == {"/tmp/project/manifest.json", "/tmp/project/buggy/App.tsx", "/tmp/project/fixed/App.tsx", "/tmp/regression.test.mjs"}
    assert inputs["/tmp/regression.test.mjs"] == hashlib.sha256(prepared.test).hexdigest()
    assert inputs["/tmp/project/manifest.json"] == hashlib.sha256(prepared.files["manifest.json"].encode()).hexdigest()


@pytest.mark.parametrize("fault", ["job", "hash", "boundary", "image", "guard-source"])
def test_approval_identity_fails_before_provider_import(prepared, monkeypatch, fault):
    monkeypatch.setitem(sys.modules, "modal", None)
    if fault == "job":
        monkeypatch.delenv("BUGARCADE_APPROVED_JOB_ID")
    elif fault == "hash":
        monkeypatch.setenv("BUGARCADE_APPROVED_REGRESSION_SHA256", "0" * 64)
    elif fault == "guard-source":
        prepared.plan["build"]["files"]["backend/cgroup_guard.py"] = "0" * 64
    else:
        path = prepared.out.parent / "boundary-receipt.json"
        value = json.loads(path.read_text())
        value["status" if fault == "boundary" else "imageId"] = "wrong"
        path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="No cloud action"):
        asyncio.run(stage.execute(prepared.job_id))
    assert not (prepared.out.parent / "regression-receipt.json").exists()


def test_entry_refuses_host_before_resource_limits_or_process(monkeypatch):
    monkeypatch.delenv("BUGARCADE_SANDBOX", raising=False)
    with pytest.raises(RuntimeError, match="authorized Linux sandbox"):
        entry_main()


def test_receipt_write_failure_after_creation_still_terminates(prepared, monkeypatch):
    sandboxes, _, _ = fake_provider(prepared, monkeypatch)
    real_write = stage.write_json
    failed = False

    def fail_after_creation(path, receipt):
        nonlocal failed
        if not failed and receipt["runs"] and receipt["runs"][0].get("sandboxId"):
            failed = True
            raise OSError(28, "Synthetic full disk")
        real_write(path, receipt)

    monkeypatch.setattr(stage, "write_json", fail_after_creation)
    with pytest.raises(OSError, match="Synthetic full disk"):
        asyncio.run(stage.execute(prepared.job_id))
    assert len(sandboxes) == 1 and sandboxes[0].terminated
    receipt = json.loads((prepared.out.parent / "regression-receipt.json").read_text())
    assert receipt["status"] == "failed-or-cancelled-no-auto-retry"
    assert receipt["runs"][0]["terminationConfirmed"]


def test_test_template_is_data_bounded(prepared):
    test = render_regression(prepared.manifest, prepared.summary["sourceHashes"], invariant_hash(prepared.manifest),
                             prepared.actions, Path("/tmp/project"))
    assert test.encode() == prepared.test
    assert 'BUGARCADE_SANDBOX' in test and 'no seed fallback' in test
    assert 'worker/cli.mjs' in test
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, 'w') as archive:
        for name, content in prepared.files.items():
            archive.writestr(name, content)
    assert validate_archive(raw.getvalue())[0] == prepared.manifest


@pytest.mark.parametrize("change", ["seed", "schedule"])
def test_same_invariant_and_apps_cannot_substitute_another_prepared_schedule(prepared, change):
    # A valid self-consistent artifact for another schedule/seed must still fail input binding.
    modified = copy.deepcopy(prepared.manifest)
    if change == "seed":
        modified.seed += 1
    else:
        modified.schedule[0].response = {"saved": "different scheduled response"}
    assert invariant_hash(modified) == invariant_hash(prepared.manifest)
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as archive:
        for name, content in prepared.files.items():
            archive.writestr(name, modified.model_dump_json() if name == "manifest.json" else content)
    (prepared.folder / "source.zip").write_bytes(raw.getvalue())
    with pytest.raises(ValueError, match="including schedule and seed"):
        stage.inspect_job(prepared.job_id)
