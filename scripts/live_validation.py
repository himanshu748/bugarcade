"""Prepare locally by default. Provider writes require a separately approved manifest and budget."""
import argparse
import asyncio
import hashlib
import io
import json
import math
import os
import re
import shutil
import sys
import zipfile
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.adapter import make_starter, validate_archive  # noqa: E402
from backend.config import Settings  # noqa: E402
from backend.recording import extract_frames  # noqa: E402
from backend.schemas import invariant_hash  # noqa: E402


def output_dir():
    attempt = os.getenv("BUGARCADE_VALIDATION_ATTEMPT", "")
    if not attempt:
        return ROOT / "evidence/live-preflight/prepared"
    if not re.fullmatch(r"attempt-[0-9]{2}", attempt):
        raise ValueError("Validation attempt must use the form attempt-NN.")
    folder = ROOT / "evidence/live-authorized" / attempt
    if folder.is_symlink() or not folder.resolve().is_relative_to((ROOT / "evidence/live-authorized").resolve()):
        raise ValueError("Validation attempt must stay inside the evidence root.")
    return folder / "prepared"


OUT = output_dir()
BASE = "mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f"


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def build_files():
    exact = ["package.json", "package-lock.json", "backend/Dockerfile.modal", "backend/sandbox_entry.py", "backend/boundary_probe.py",
             "backend/regression_entry.py", "backend/cgroup_guard.py", "backend/artifact_transfer.py", "fixtures/app.css", "fixtures/harness.tsx", "fixtures/cartridge-transport.ts"]
    return sorted([ROOT / value for value in exact] + list((ROOT / "worker").glob("*.mjs"))
                  + list((ROOT / "fixtures").glob("*/*/App.tsx")) + list((ROOT / "shared").glob("*.json")))


def estimate():
    sandbox_hour = 0.50  # Rounded above the published 2-core/2-GiB rate; no credit discount assumed.
    job_seconds = Settings.job_timeout_seconds + Settings.run_timeout_seconds + 10
    job_cost_key = f"job_{int(job_seconds)}_seconds_at_max_sandbox_allocation"
    items = {
        "model_two_calls_24000_input_2048_output": 2 * (24000 * 1.25 + 2048 * 4.25) / 1_000_000,
        job_cost_key: job_seconds * sandbox_hour / 3600,
        "artifact_egress_52_runs_times_24_MiB": 52 * 24 / 1024 * 0.04,
        "image_build_assumption_600s_2_standard_cores_4_GiB": 600 * (2 * 0.0473 + 4 * 0.008) / 3600,
        "five_boundary_sandboxes_up_to_60s_each": 300 * sandbox_hour / 3600,
        "two_exported_regression_runs_45s_each": 90 * sandbox_hour / 3600,
        "additional_5_MiB_egress": 5 / 1024 * 0.04,
    }
    return {"currency": "USD", "lineItems": items, "subtotal": sum(items.values()),
            "subtotalWith25PercentContingency": sum(items.values()) * 1.25,
            "smallestPracticalAllowance": 0.35, "recommendedBufferedAllowance": 1.0,
            "approved": False, "approvedUsd": 0,
            "jobReservationOnly": items["model_two_calls_24000_input_2048_output"] + items[job_cost_key],
            "assumptions": ["Uncached Muse input at the documented Modal/Baseten rates. No grant/credit/cache discounts assumed.",
                "Build duration and builder resources are estimates, not enforceable invoice caps.",
                "Input/image tokens and cancellation charges may only be known after provider response.",
                "No automatic paid retries; failed or unknown-charge stages require review.",
                "Modal Shared Endpoint inference does not consume included plan compute credits; grant-specific coverage is unverified.",
                "Credits, remaining balance, tax, purchase minimums and grant-specific access are unknown."],
            "sources": ["https://www.baseten.co/pricing/", "https://modal.com/library/meta/muse-spark-open",
                        "https://modal.com/docs/guide/shared-endpoints", "https://modal.com/pricing", "https://modal.com/docs/guide/budgets"]}


async def prepare():
    settings = Settings()
    if settings.model_provider not in {"baseten", "modal"}:
        raise ValueError("Select a supported model provider before preparing a plan.")
    if any((OUT.parent / name).exists() for name in ("image-build-receipt.json", "boundary-receipt.json", "regression-receipt.json")):
        raise ValueError("A provider-stage receipt exists. Preserve it and reconcile billing before preparing a new attempt.")
    OUT.mkdir(parents=True, exist_ok=True)
    context = OUT / "build-context"
    if context.exists():
        shutil.rmtree(context)  # only our generated allowlisted context, never the repository
    context.mkdir()
    inventory = {}
    for source in build_files():
        if source.is_symlink():
            raise ValueError("Build context must not contain symlinks.")
        relative = source.relative_to(ROOT)
        target = context / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        inventory[str(relative)] = sha(target)
    # Stable archive timestamps make repeated preparation idempotent.
    raw = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(make_starter(ROOT))) as original, zipfile.ZipFile(raw, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(original.namelist()):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, original.read(name))
    project = OUT / "lost-note-starter.zip"
    project.write_bytes(raw.getvalue())
    manifest, _, hashes = validate_archive(project.read_bytes())
    recording = OUT / "recording.webm"
    shutil.copyfile(ROOT / "evidence/seeds/lost-note/buggy-1/recording.webm", recording)
    frames = await extract_frames(recording, OUT / "frames")
    frame_records = [{"file": Path(frame["path"]).relative_to(OUT).as_posix(), "timestampMs": frame["timestampMs"],
                      "sha256": sha(Path(frame["path"]))} for frame in frames["frames"]]
    plan = {"status": "prepared-not-authorized", "preparedAt": datetime.now(UTC).isoformat(),
            "cloudWritesPerformed": False, "modelRequestsPerformed": False,
            "attempt": os.getenv("BUGARCADE_VALIDATION_ATTEMPT", "original-preflight"),
            "input": {"project": project.name, "projectSha256": sha(project), "sourceHashes": hashes,
                      "recording": recording.name, "recordingSha256": sha(recording), "frames": frame_records,
                      "recordingOrigin": "Genuine local Playwright capture of the shipped lost-note seed; not a live provider recording.",
                      "durationSeconds": frames["durationSeconds"], "invariantHash": invariant_hash(manifest),
                      "evaluationScope": "Known seed through uploaded-starter interface; no held-out/generalization claim."},
            "controlPlane": {str(path.relative_to(ROOT)): sha(path) for path in sorted(list((ROOT / "backend").glob("*.py"))
                + [ROOT / "scripts/live_validation.py", ROOT / "scripts/cloud_boundary_checks.py", ROOT / "scripts/validate_regression.py"])},
            "build": {"context": "build-context", "files": inventory, "base": BASE, "addPython": "3.12",
                      "visibility": "Private Modal image and app only after authorization; no public deployment or registry push."},
            "model": {"provider": settings.model_provider, "endpoint": settings.model_endpoint, "model": settings.model,
                      "configurationReady": not settings.model_reasons,
                      "configurationMissing": settings.model_reasons,
                      "configurationSnapshot": "Availability at preparation only; full execution always requires current validated access and unchanged provider/model/API.",
                      "intendedModel": "Meta Muse Spark Open",
                      "configurableVia": "BUGARCADE_MODEL (BASETEN_MODEL is retained for Baseten)",
                      "identityLimit": "Modal endpoint hostname alone does not prove its underlying model; verify Muse identity before approval.",
                      "maxCalls": 2, "maxOutputTokens": 2048, "reservedInputTokensPerCall": 24000},
            "limits": {"actions": 12, "minimizationProbes": 20, "pipelineSandboxesMax": 50, "regressionSandboxes": 2,
                       "boundarySandboxes": 5, "concurrency": 1, "jobSeconds": settings.job_timeout_seconds, "sandboxSeconds": settings.run_timeout_seconds,
                       "cpuPhysicalCoresMax": 2, "memoryMiBMax": 2048, "processRlimit": 256,
                       "outputBytes": 1048576, "egress": "blocked except sandbox loopback"},
            "gates": {"D06": "Real model proposedActions must match executedActions and browser trace; three buggy failures/three fixed passes.",
                      "D09": "Real selected Meta-provider receipt with model/config, timestamps, usage/cost or explicitly unknown usage.",
                      "D10": "Real sandbox IDs, execution and termination readback, including failure/cancellation.",
                      "E04": "Immutable image/dependency/browser versions; working loopback and denied external egress.",
                      "E06": "Provider CPU/memory readback, bounded pressure checks, process/output limits and actual sandbox TTL; unclassified kills stay inconclusive."},
            "budget": estimate(), "stopOn": ["failed/inconclusive boundary check", "missing access", "invalid proposal", "budget uncertainty", "timeout"]}
    write_json(OUT / "run-manifest.json", plan)
    write_json(OUT.parent / "budget.json", estimate())
    print(json.dumps({"status": plan["status"], "manifest": str(OUT / "run-manifest.json"), "manifestSha256": sha(OUT / "run-manifest.json"),
                      "cloudWrites": 0, "modelRequests": 0}))


def verify_prepared():
    plan = json.loads((OUT / "run-manifest.json").read_text())
    for relative, expected in plan["controlPlane"].items():
        if sha(ROOT / relative) != expected:
            raise ValueError("Prepared control plane has changed. Re-prepare and review the new manifest.")
    context = OUT / "build-context"
    for relative, expected in plan["build"]["files"].items():
        if sha(context / relative) != expected or sha(ROOT / relative) != expected:
            raise ValueError("Prepared build/source has changed. Re-prepare and review the new manifest.")
    actual = {path.relative_to(context).as_posix() for path in context.rglob("*") if path.is_file()}
    if actual != set(plan["build"]["files"]):
        raise ValueError("Unexpected files in build context.")
    if sha(OUT / plan["input"]["project"]) != plan["input"]["projectSha256"] or sha(OUT / plan["input"]["recording"]) != plan["input"]["recordingSha256"]:
        raise ValueError("Prepared input changed.")
    for frame in plan["input"]["frames"]:
        if sha(OUT / frame["file"]) != frame["sha256"]:
            raise ValueError("Prepared frame changed.")
    return plan


def require_approval(*, model_access=True):
    plan = verify_prepared()
    settings = Settings()
    if (not settings.live_enabled or not settings.budget_approved or not math.isfinite(settings.approved_budget_usd)
            or settings.approved_budget_usd < plan["budget"]["smallestPracticalAllowance"]
            or not settings.modal_credentials_present
            or (model_access and (settings.model_reasons or not settings.model_api_key or not plan["model"]["model"]))
            or settings.model_provider != plan["model"].get("provider", "baseten")
            or settings.model_endpoint != plan["model"]["endpoint"]
            or settings.model != plan["model"]["model"]
            or (settings.input_usd_per_million, settings.output_usd_per_million, settings.sandbox_usd_per_hour) != (1.25, 4.25, 0.50)
            or os.getenv("BUGARCADE_APPROVED_MANIFEST_SHA256") != sha(OUT / "run-manifest.json")):
        raise ValueError("No cloud action: approved budget, existing SDK access and reviewed provider/model/API manifest are required; inference stages also require model access.")
    return plan, settings


async def build_image():
    plan, settings = require_approval(model_access=False)
    import modal
    receipt = OUT.parent / "image-build-receipt.json"
    audit = {"status": "started", "actualCostUsd": None, "startedAt": datetime.now(UTC).isoformat(),
             "manifestSha256": sha(OUT / "run-manifest.json"), "app": settings.modal_app,
             "billing": "unknown until reconciled"}
    with receipt.open("x") as output:
        json.dump(audit, output)
    # A private app/image creation is a provider write, guarded above and never performed by prepare/check.
    try:
        async with asyncio.timeout(600):
            app = await modal.App.lookup.aio(settings.modal_app, create_if_missing=True)
            dockerfile = OUT / "build-context/backend/Dockerfile.modal"
            if f"FROM {plan['build']['base']}\n" not in dockerfile.read_text():
                raise ValueError("Pinned literal base differs from the reviewed recipe.")
            image = modal.Image.from_dockerfile(dockerfile, context_dir=OUT / "build-context",
                        add_python=plan["build"]["addPython"], secrets=[])
            image = await image.build.aio(app)
        audit.update(status="built-not-boundary-verified", imageId=image.object_id)
    except BaseException as error:
        audit.update(status="failed-or-cancelled", retry="Review provider state/billing; no automatic retry.")
        if isinstance(getattr(error, "image_id", None), str):
            audit["failedImageId"] = error.image_id
        raise
    finally:
        audit["finishedAt"] = datetime.now(UTC).isoformat()
        write_json(receipt, audit)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "check", "build-image"], default="check", nargs="?")
    parser.add_argument("--execute", action="store_true", help="Future authorization only; never enables gates itself.")
    args = parser.parse_args()
    if args.action == "prepare":
        asyncio.run(prepare())
    elif args.action == "build-image" and args.execute:
        asyncio.run(build_image())
    else:
        plan = verify_prepared()
        print(json.dumps({"status": "dry-run-only", "cloudWrites": 0, "modelRequests": 0,
                          "manifestSha256": sha(OUT / "run-manifest.json"), "estimatedUsd": plan["budget"]["subtotal"],
                          "liveDisabledReasons": Settings().live_reasons}))


if __name__ == "__main__":
    main()
