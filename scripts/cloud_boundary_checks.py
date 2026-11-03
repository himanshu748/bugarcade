"""Dry-run by default. Real probes are private, billable, and require future explicit approval."""
import argparse
import asyncio
import json
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.runner import ModalRunner, RunnerError  # noqa: E402
from scripts.live_validation import OUT, require_approval, sha, verify_prepared, write_json  # noqa: E402


def decode_probe(raw, stderr, returncode, record):
    record.update(probeReturncode=returncode, probeStderr=stderr[:16384], outputBounded=len(raw.encode()) <= 64 * 1024)
    if not record["outputBounded"]:
        raise ValueError("Probe output exceeded its ceiling.")
    try:
        boundary = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise ValueError("Boundary probe returned no valid result; inspect the recorded stderr. No boundary pass claimed.") from error
    record["boundary"] = boundary
    if returncode != 0 or not isinstance(boundary, dict) or boundary.get("kind") != "real-cloud-boundary-probe":
        raise ValueError("Boundary failed or inconclusive; do not send app source/model requests.")
    return boundary


async def _native_readback(app_id, sandbox_id):
    """Official installed SDK protocol; exact owned app/ID, no account mutation."""
    from modal.client import _Client
    from modal_proto import api_pb2
    client = await _Client.from_env()
    response = await asyncio.wait_for(client.stub.SandboxList(
        api_pb2.SandboxListRequest(app_id=app_id, include_finished=True)), 10)
    rows = [row for row in response.sandboxes if row.id == sandbox_id]
    if len(rows) != 1:
        raise ValueError("Owned sandbox resource readback unavailable; no resource pass claimed.")
    row = rows[0]
    resource = row.resource_info
    result = row.task_info.result
    return {"sandboxId": row.id, "appId": row.app_id, "imageId": row.image_id,
            "cpuMilliRequest": resource.milli_cpu.value, "cpuMilliMax": resource.milli_cpu_max,
            "memoryMiBRequest": resource.memory_mb.value, "memoryMiBMax": resource.memory_mb_max,
            "timeoutSeconds": row.timeout_secs, "resultStatus": api_pb2.GenericResult.GenericStatus.Name(result.status),
            "exitcode": result.exitcode, "exception": result.exception[:4096]}


async def provider_readback(app_id, sandbox_id):
    # The public SDK bridge and native gRPC client own different event loops.
    # Keep read-only native metadata work in a separate trusted backend process.
    environment = {key: value for key, value in os.environ.items() if key in {
        "PATH", "HOME", "LANG", "MODAL_SERVER_URL", "MODAL_PROFILE", "MODAL_ENVIRONMENT",
        "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"}}
    code = ("import asyncio,json,sys; from scripts.cloud_boundary_checks import _native_readback; "
            "print(json.dumps(asyncio.run(_native_readback(sys.argv[1],sys.argv[2]))))")
    process = await asyncio.create_subprocess_exec(sys.executable, "-c", code, app_id, sandbox_id,
        cwd=Path(__file__).resolve().parents[1], env=environment,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        stdout, _stderr = await asyncio.wait_for(process.communicate(), 20)
        if process.returncode != 0 or len(stdout) > 64 * 1024:
            raise ValueError("Owned sandbox resource readback unavailable; no resource pass claimed.")
        return json.loads(stdout)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()


def verify_resources(row, app_id, image_id, ttl):
    if (row["appId"] != app_id or row["imageId"] != image_id or row["cpuMilliRequest"] != 1000
            or row["cpuMilliMax"] != 2000 or row["memoryMiBRequest"] != 1024
            or row["memoryMiBMax"] != 2048 or row["timeoutSeconds"] != ttl):
        raise ValueError("Provider resource settings do not match the reviewed limits.")


def verify_memory_outcome(row, raw):
    # A generic SIGKILL, provider TTL or host-pressure eviction cannot prove hard-limit OOM.
    status = row["resultStatus"]
    reason = row["exception"].lower()
    progress = [json.loads(line) for line in raw.splitlines() if line.strip()]
    allocated = max((value.get("allocatedMiB", 0) for value in progress), default=0)
    oom_reason = "out of memory" in reason or "oom" in reason
    if (status != "GENERIC_STATUS_FAILURE" or not oom_reason or allocated < 1024
            or allocated >= 2560 or any(value.get("completed") for value in progress)):
        raise ValueError("Hard memory enforcement inconclusive; no generic kill/eviction/timeout counts as OOM proof.")
    return {"status": "passed", "allocatedMiBBeforeProviderOOM": allocated, "providerResult": row}


async def checks(*, memory_pressure=True):
    plan, settings = require_approval(model_access=False)
    if settings.compute_reasons:
        raise ValueError("No cloud action: " + " ".join(settings.compute_reasons))
    build_receipt = json.loads((OUT.parent / "image-build-receipt.json").read_text())
    if (build_receipt.get("status") != "built-not-boundary-verified"
            or build_receipt.get("manifestSha256") != sha(OUT / "run-manifest.json")
            or build_receipt.get("imageId") != settings.modal_image_id or build_receipt.get("app") != settings.modal_app):
        raise ValueError("No cloud action: configured image/app must match the approved build receipt.")
    import modal
    receipt_path = OUT.parent / "boundary-receipt.json"
    receipt = {"status": "started", "manifestSha256": sha(OUT / "run-manifest.json"),
               "imageId": settings.modal_image_id, "app": settings.modal_app,
               "startedAt": datetime.now(UTC).isoformat(), "actualCostUsd": None, "probes": [],
               "memoryPressureRequested": memory_pressure, "scope": "full-boundary" if memory_pressure else "known-source-controls-only-E06-inconclusive"}
    with receipt_path.open("x") as output:
        json.dump(receipt, output)
    cleanup = ModalRunner(settings)

    async def create(ttl):
        return await cleanup._create(modal.Sandbox.create.aio, "python3", "-c", "import time; time.sleep(180)",
            app=app, image=image, timeout=ttl, cpu=(1.0, 2.0), memory=(1024, 2048), block_network=True,
            secrets=[], volumes={}, network_file_systems={}, include_oidc_identity_token=False,
            workdir="/opt/bugarcade", env={"HOME": "/tmp/home", "NODE_ENV": "test", "BUGARCADE_SANDBOX": "1"})

    async def finish(sandbox, record):
        try:
            try:
                already_terminal = await asyncio.wait_for(sandbox.poll.aio(), 5) is not None
            except Exception:
                already_terminal = False  # Still attempt termination if the readback failed.
            if not already_terminal:
                try:
                    await asyncio.wait_for(asyncio.shield(sandbox.terminate.aio(wait=True)), 10)
                except modal.exception.SandboxTimeoutError:
                    pass  # A TTL expiration is already terminal; confirm with bounded poll.
            record["terminatedReturncode"] = await asyncio.wait_for(sandbox.poll.aio(), 5)
            record["terminationConfirmed"] = record["terminatedReturncode"] is not None
            if not record["terminationConfirmed"]:
                record["status"] = "failed-termination-unconfirmed"
                raise ValueError("Sandbox termination was not confirmed; stop all subsequent stages.")
        finally:
            write_json(receipt_path, receipt)

    try:
        async with asyncio.timeout(240):
            app = await modal.App.lookup.aio(settings.modal_app, create_if_missing=False)
            image = modal.Image.from_id(settings.modal_image_id)
            sandbox = await create(60)
            record = {"kind": "boundaries", "sandboxId": sandbox.object_id, "status": "pending"}
            receipt["probes"].append(record)
            try:
                await sandbox.filesystem.write_text.aio(json.dumps(plan["build"]["files"]), "/tmp/build-expectations.json")
                await sandbox.filesystem.write_text.aio("bugarcade-upload-marker", "/tmp/project/readability-check.txt")
                await sandbox.filesystem.write_text.aio("{}", "/tmp/request.json")
                process = await sandbox.exec.aio("python3", "backend/boundary_probe.py", timeout=30)
                raw, stderr, _ = await asyncio.gather(process.stdout.read.aio(), process.stderr.read.aio(), process.wait.aio())
                decode_probe(raw, stderr, process.returncode, record)
                record["providerResources"] = await provider_readback(app.app_id, sandbox.object_id)
                verify_resources(record["providerResources"], app.app_id, settings.modal_image_id, 60)
                record["status"] = "passed"
            finally:
                await finish(sandbox, record)

            if memory_pressure:
                # Separate expendable sandbox. Bound allocation to 2.5 GiB, TTL 30 s, no submitted code.
                memory_code = ("import sys,json; sys.path.insert(0,'backend'); from sandbox_entry import drop_privileges; "
                    "drop_privileges(); blocks=[]\nfor _ in range(40):\n blocks.append(bytearray(64*1024*1024))\n "
                    "print(json.dumps({'allocatedMiB':len(blocks)*64}),flush=True)\nprint(json.dumps({'completed':True}),flush=True)")
                sandbox = await cleanup._create(modal.Sandbox.create.aio, "python3", "-u", "-c", memory_code,
                    app=app, image=image, timeout=30, cpu=(1.0, 2.0), memory=(1024, 2048), block_network=True,
                    secrets=[], volumes={}, network_file_systems={}, include_oidc_identity_token=False,
                    workdir="/opt/bugarcade", env={"HOME": "/tmp/home", "BUGARCADE_SANDBOX": "1"})
                record = {"kind": "dedicated-memory-enforcement", "sandboxId": sandbox.object_id, "status": "pending"}
                receipt["probes"].append(record)
                try:
                    try:
                        await asyncio.wait_for(sandbox.wait.aio(raise_on_termination=False), 40)
                    except modal.exception.SandboxTimeoutError:
                        pass  # Recorded and rejected by the specific provider-result check below.
                    raw = await asyncio.wait_for(sandbox.stdout.read.aio(), 5)
                    record["allocationProgress"] = raw[:8192]
                    row = await provider_readback(app.app_id, sandbox.object_id)
                    record["providerResources"] = row
                    verify_resources(row, app.app_id, settings.modal_image_id, 30)
                    record.update(verify_memory_outcome(row, raw))
                finally:
                    await finish(sandbox, record)

            for fault in ("readiness-failure", "cancellation"):
                captured = []
                ready = asyncio.Event()

                async def create_fault(*args, _captured=captured, _fault=fault, _ready=ready, **kwargs):
                    real = await modal.Sandbox.create.aio(*args, **kwargs)
                    _captured.append(real)

                    async def exec_fault(*_args, **_kwargs):
                        command = "raise SystemExit(1)" if _fault == "readiness-failure" else "import time; time.sleep(15)"
                        result = await real.exec.aio("python3", "-c", command, timeout=20)
                        _ready.set()
                        return result

                    return SimpleNamespace(exec=SimpleNamespace(aio=exec_fault), filesystem=real.filesystem, terminate=real.terminate)

                provider = SimpleNamespace(App=modal.App, Image=modal.Image, Sandbox=SimpleNamespace(create=SimpleNamespace(aio=create_fault)))
                runner = ModalRunner(settings, provider)
                task = asyncio.create_task(runner.run("lost-note", "buggy", [], OUT.parent / f"unused-{fault}"))
                record = {"kind": fault, "status": "pending"}
                receipt["probes"].append(record)
                try:
                    if fault == "cancellation":
                        await asyncio.wait_for(ready.wait(), 30)
                        task.cancel()
                    try:
                        await task
                        raise ValueError("Expected production runner fault did not occur.")
                    except asyncio.CancelledError:
                        if fault != "cancellation":
                            raise
                    except RunnerError as exc:
                        if fault != "readiness-failure" or "readiness" not in str(exc):
                            raise
                    record["sandboxId"] = captured[0].object_id
                    record["terminatedReturncode"] = await captured[0].poll.aio()
                    record["terminationConfirmed"] = record["terminatedReturncode"] is not None
                    record["status"] = "passed" if record["terminationConfirmed"] else "failed"
                finally:
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)
                    for real in captured:
                        await finish(real, record)
                if record["status"] != "passed":
                    raise ValueError("Production runner cleanup not confirmed.")

            sandbox = await create(10)
            record = {"kind": "provider-ttl", "sandboxId": sandbox.object_id, "configuredSeconds": 10, "status": "pending"}
            receipt["probes"].append(record)
            try:
                started = time.monotonic()
                try:
                    await asyncio.wait_for(sandbox.wait.aio(raise_on_termination=False), 25)
                except modal.exception.SandboxTimeoutError:
                    pass  # Expected provider TTL, confirmed by poll's timeout-specific exit code below.
                code = await sandbox.poll.aio()
                elapsed = time.monotonic() - started
                record.update(terminatedReturncode=code, terminationConfirmed=code is not None,
                              observedWaitSeconds=elapsed, status="passed" if code == 124 else "failed")
            finally:
                await finish(sandbox, record)
            if record["status"] != "passed":
                raise ValueError("Actual sandbox TTL was not observed.")
        receipt["status"] = "passed-awaiting-human-evidence-review" if memory_pressure else "known-source-controls-verified-E06-inconclusive"
    except BaseException:
        receipt["status"] = "failed-or-cancelled-no-auto-retry"
        raise
    finally:
        receipt["finishedAt"] = datetime.now(UTC).isoformat()
        write_json(receipt_path, receipt)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.execute:
        asyncio.run(checks())
    else:
        verify_prepared()
        print(json.dumps({"status": "dry-run-only", "cloudWrites": 0, "sandboxesCreated": 0,
                          "planned": ["boundary and memory pressure", "real runner readiness failure", "real runner cancellation", "provider TTL"]}))
