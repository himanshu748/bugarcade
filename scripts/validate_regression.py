"""Review an exported regression locally; --execute requires separate future cloud approval."""
import argparse
import asyncio
import hashlib
import json
import os
import re
import sys
from datetime import UTC, datetime
from importlib.metadata import version
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pydantic import TypeAdapter  # noqa: E402

from backend.adapter import validate_archive  # noqa: E402
from backend.packaging import render_regression  # noqa: E402
from backend.runner import GUARD_INSPECTION, ModalRunner, checked_guard_result  # noqa: E402
from backend.schemas import Action, invariant_hash, validate_actions  # noqa: E402
from scripts.live_validation import (  # noqa: E402
    OUT,
    ROOT,
    require_approval,
    sha,
    verify_prepared,
    write_json,
)


def inspect_job(job_id):
    plan = verify_prepared()
    if not re.fullmatch(r"[a-f0-9]{32}", job_id):
        raise ValueError("A 32-character generated job ID is required.")
    folder = ROOT / "evidence/jobs" / job_id
    if folder.is_symlink() or not folder.resolve().is_relative_to((ROOT / "evidence/jobs").resolve()):
        raise ValueError("Job artifacts must remain inside the local job root.")

    def bounded(name, limit):
        path = folder / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
            raise ValueError("Missing, oversized or linked job artifact.")
        return path.read_bytes()

    summary = json.loads(bounded("summary.json", 2 * 1024 * 1024))
    test = bounded("regression.test.mjs", 64 * 1024)
    manifest, files, hashes = validate_archive(bounded("source.zip", 256 * 1024))
    prepared_manifest, _, _ = validate_archive((OUT / plan["input"]["project"]).read_bytes())
    if manifest.model_dump() != prepared_manifest.model_dump():
        raise ValueError("Starter manifest differs from the reviewed prepared input, including schedule and seed.")
    frozen = invariant_hash(manifest)
    actions = TypeAdapter(list[Action]).validate_python(summary.get("actions"))
    validate_actions(actions, manifest)
    schedule = [row.model_dump() for row in manifest.schedule]
    if (summary.get("verified") is not True or summary.get("mode") != "live" or summary.get("runner") != "modal-sandbox"
            or summary.get("cohort") != "submitted-example" or summary.get("invariantHash") != frozen
            or frozen != plan["input"]["invariantHash"] or summary.get("challengeId") != manifest.id
            or summary.get("schedule") != schedule or not 1 <= len(actions) <= 12
            or summary.get("assertion") != manifest.assertion.model_dump()
            or summary.get("completion") != manifest.completion.model_dump()):
        raise ValueError("Only the verified live job for the prepared starter may enter this stage.")
    for name in ("buggy/App.tsx", "fixed/App.tsx"):
        if hashes[name] != summary.get("sourceHashes", {}).get(name) or hashes[name] != plan["input"]["sourceHashes"][name]:
            raise ValueError("Source identity differs from the prepared/live job.")
    validation = [run for run in summary.get("runs", []) if run.get("phase") == "validation"]
    if [run.get("variant") for run in validation] != ["buggy", "fixed"] * 3:
        raise ValueError("Three consecutive buggy/fixed validation pairs are required.")
    for run in validation:
        validate_outcome({"variant": run["variant"], "timedOut": False, "outputBounded": True,
                          "testReturncode": 1 if run["variant"] == "buggy" else 0, "result": run["result"]},
                         manifest, summary["actions"], run["variant"])
    if not any(row.get("origin") == "live-model" and row.get("outcome") == "proposed"
               and row.get("providerCallAttempted") is True and row.get("invariantHash") == frozen
               and row.get("proposedActions") == summary.get("initialActions") for row in summary.get("provenance", [])):
        raise ValueError("An accepted live model proposal is required; recorded seed output is insufficient.")
    if test.decode() != render_regression(manifest, summary["sourceHashes"], frozen, summary["actions"], Path("/tmp/project")):
        raise ValueError("Generated test differs from the canonical frozen template; arbitrary test code is rejected.")
    return {"plan": plan, "summary": summary, "manifest": manifest, "files": files, "test": test,
            "testSha256": hashlib.sha256(test).hexdigest(), "jobId": job_id}


def validate_outcome(report, manifest, actions, variant):
    result = report.get("result")
    if (report.get("variant") != variant or report.get("timedOut") is not False or report.get("outputBounded") is not True
            or type(report.get("testReturncode")) is not int or report["testReturncode"] != (1 if variant == "buggy" else 0)
            or not isinstance(result, dict) or result.get("error") is not None):
        raise ValueError("Regression startup/timeout/output/test-exit failure is not intended assertion evidence.")
    assertion = result.get("assertion", {})
    rule = manifest.assertion
    actual = assertion.get("actual")
    valid = type(actual) is int and actual >= 0 if rule.operator == "count" else isinstance(actual, str)
    passed = (rule.expected in actual if rule.operator == "contains" else rule.expected == actual) if valid else None
    executed = [row.get("action") for row in result.get("actions", []) if row.get("status") == "executed"]
    if (not valid or result.get("status") != ("failed" if variant == "buggy" else "passed")
            or result.get("variant") != variant or result.get("challengeId") != manifest.id
            or any(assertion.get(key) != value for key, value in rule.model_dump().items())
            or assertion.get("hash") != invariant_hash(manifest) or assertion.get("completion") != manifest.completion.model_dump()
            or passed is not (variant == "fixed") or assertion.get("pass") is not passed
            or result.get("schedule") != [row.model_dump() for row in manifest.schedule] or executed != actions):
        raise ValueError("Regression outcome differs from the frozen invariant, observed value, actions or schedule.")


def expected_regression_inputs(context):
    inputs = {"/tmp/project/" + name: hashlib.sha256(context["files"][name].encode()).hexdigest()
              for name in ("buggy/App.tsx", "fixed/App.tsx", "manifest.json")}
    inputs["/tmp/regression.test.mjs"] = context["testSha256"]
    return inputs


async def execute(job_id):
    context = inspect_job(job_id)
    _plan, settings = require_approval(model_access=False)
    if (settings.compute_reasons or os.getenv("BUGARCADE_APPROVED_JOB_ID") != job_id
            or os.getenv("BUGARCADE_APPROVED_REGRESSION_SHA256") != context["testSha256"]):
        raise ValueError("No cloud action: review and approve the exact live job ID and regression hash first.")
    digest = sha(OUT / "run-manifest.json")
    build = json.loads((OUT.parent / "image-build-receipt.json").read_text())
    boundary = json.loads((OUT.parent / "boundary-receipt.json").read_text())
    if (build.get("status") != "built-not-boundary-verified" or boundary.get("status") != "passed-awaiting-human-evidence-review"
            or any(row.get("manifestSha256") != digest or row.get("app") != settings.modal_app
                   or row.get("imageId") != settings.modal_image_id for row in (build, boundary))):
        raise ValueError("No cloud action: matching successful image/boundary receipts are required.")
    guard_sha = sha(settings.root / "backend/cgroup_guard.py")
    if context["plan"].get("build", {}).get("files", {}).get("backend/cgroup_guard.py") != guard_sha:
        raise ValueError("No cloud action: the reviewed image must bind the current mandatory VM guard.")
    expected_inputs = expected_regression_inputs(context)
    receipt_path = OUT.parent / "regression-receipt.json"
    receipt = {"status": "started", "jobId": job_id, "manifestSha256": digest, "testSha256": context["testSha256"],
               "imageId": settings.modal_image_id, "app": settings.modal_app, "startedAt": datetime.now(UTC).isoformat(),
               "runtimeRequested": "vm", "guardSha256": guard_sha, "expectedInputs": expected_inputs,
               "requestedResources": {"cpu": [1.0, 2.0], "memoryMiB": [2048, 2048]},
               "actualCostUsd": None, "billing": "unknown until reconciled", "runs": []}
    with receipt_path.open("x") as output:
        json.dump(receipt, output)
    cleanup = ModalRunner(settings)
    try:
        if version("modal") != "1.6.3":
            raise ValueError("VM regression execution requires the pinned Modal 1.6.3 cloud extra.")
        import modal
        async with asyncio.timeout(125):
            app = await modal.App.lookup.aio(settings.modal_app, create_if_missing=False)
            image = modal.Image.from_id(settings.modal_image_id)
            for variant in ("buggy", "fixed"):
                sandbox = None
                record = {"variant": variant, "status": "started", "runtimeRequested": "vm", "terminationConfirmed": False}
                receipt["runs"].append(record)
                write_json(receipt_path, receipt)
                try:
                    async with asyncio.timeout(45):
                        async def create(*args, _record=record, **kwargs):
                            nonlocal sandbox
                            remote = await modal.Sandbox.create.aio(*args, **kwargs)
                            sandbox = remote  # Preserve ownership if cancellation races the create await.
                            _record["sandboxId"] = remote.object_id
                            return remote
                        sandbox = await cleanup._create(create, "python3", "-c", "import time; time.sleep(180)",
                            app=app, image=image, timeout=45, cpu=(1.0, 2.0), runtime="vm", memory=(2048, 2048), block_network=True,
                            secrets=[], volumes={}, network_file_systems={}, include_oidc_identity_token=False,
                            workdir="/opt/bugarcade", env={"HOME": "/tmp/home", "NODE_ENV": "test", "BUGARCADE_SANDBOX": "1", "BUGARCADE_CGROUP_GUARD": "1"})
                        # Ownership is assigned before a receipt write can fail (for example, ENOSPC).
                        write_json(receipt_path, receipt)
                        for name in ("buggy/App.tsx", "fixed/App.tsx", "manifest.json"):
                            await sandbox.filesystem.write_text.aio(context["files"][name], "/tmp/project/" + name)
                        await sandbox.filesystem.write_text.aio(context["test"].decode(), "/tmp/regression.test.mjs")
                        process = await sandbox.exec.aio("python3", "backend/cgroup_guard.py", "regression", variant, timeout=42)
                        raw = await process.stdout.read.aio()
                        if len(raw.encode()) > settings.max_output_bytes:
                            raise ValueError("Regression output ceiling exceeded.")
                        await process.wait.aio()
                        inspection = await sandbox.exec.aio("python3", "-c", GUARD_INSPECTION, timeout=5)
                        guard_raw = await inspection.stdout.read.aio()
                        await inspection.wait.aio()
                        if inspection.returncode != 0 or len(guard_raw.encode()) > 128 * 1024:
                            raise ValueError("Trusted VM regression resource receipt is unavailable.")
                        record["guardInspectionSha256"] = hashlib.sha256(guard_raw.encode()).hexdigest()
                        record.update(checked_guard_result(guard_raw, mode="regression", variant=variant,
                            inputs=expected_inputs, guard_sha=guard_sha, output=raw, returncode=process.returncode))
                        if process.returncode != 0:
                            raise ValueError("Guarded regression entry failed; no intended assertion verdict.")
                        report = json.loads(raw)
                        record["report"] = report
                        validate_outcome(report, context["manifest"], context["summary"]["actions"], variant)
                        tap = await sandbox.filesystem.read_bytes.aio("/tmp/regression-tap.txt")
                        if len(tap) > settings.max_output_bytes or hashlib.sha256(tap).hexdigest() != report.get("tapSha256"):
                            raise ValueError("Test output identity/size check failed.")
                        (OUT.parent / f"regression-{variant}.tap").write_bytes(tap)
                        record["status"] = "intended-failure" if variant == "buggy" else "passed"
                finally:
                    if sandbox is not None:
                        await asyncio.wait_for(asyncio.shield(sandbox.terminate.aio(wait=True)), 10)
                        record["terminatedReturncode"] = await asyncio.wait_for(sandbox.poll.aio(), 5)
                        record["terminationConfirmed"] = record["terminatedReturncode"] is not None
                    write_json(receipt_path, receipt)
                if not record["terminationConfirmed"]:
                    raise ValueError("Termination is unconfirmed; stop subsequent executions.")
        receipt["status"] = "passed-awaiting-human-evidence-review"
    except BaseException:
        receipt["status"] = "failed-or-cancelled-no-auto-retry"
        raise
    finally:
        receipt["finishedAt"] = datetime.now(UTC).isoformat()
        write_json(receipt_path, receipt)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job-id")
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.execute:
        if not args.job_id:
            parser.error("--execute requires a reviewed --job-id")
        asyncio.run(execute(args.job_id))
    else:
        plan = verify_prepared()
        job = inspect_job(args.job_id) if args.job_id else None
        print(json.dumps({"status": "dry-run-only", "cloudWrites": 0, "sandboxesCreated": 0,
                          "plannedSandboxes": 2, "manifestSha256": sha(OUT / "run-manifest.json"),
                          "jobId": args.job_id, "regressionSha256": job["testSha256"] if job else None,
                          "invariantHash": plan["input"]["invariantHash"]}))


if __name__ == "__main__":
    main()
