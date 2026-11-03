"""Build a local, allowlisted review archive. Never publish, deploy or call providers."""
from __future__ import annotations

import argparse
import hashlib
import html
import io
import json
import re
import shutil
import stat
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "dist-submission"
STAGE = OUT / "bugarcade-review"
LIVE = ROOT / "evidence/jobs/6d18b3f942ea45698c972d6763ce3383"
HELDOUT = ROOT / "evidence/jobs/a75b736d5dc942c8a31e69c56ee599f9"
HELDOUT_INPUT = ROOT / "evaluation/heldout/coupon-total"
HELDOUT_TRIAL = ROOT / "evaluation/heldout/trials/coupon-total-02"
DEMO = ROOT / "evidence/submission-demo/bugarcade-demo.mp4"
RUNTIME_PROOF = ROOT / "evidence/competition-finish/runtime-public-summary.json"
SEEDS = ("lost-note", "rollback", "search", "duplicate", "cleanup")
SOURCE_ROOTS = {
    "frontend": {".tsx", ".ts", ".css"}, "fixtures": {".tsx", ".ts", ".css"},
    "backend": {".py"}, "worker": {".mjs"}, "shared": {".json"},
    "tests": {".py", ".ts", ".mjs"}, "scripts": {".py", ".mjs"},
    "public": {".png", ".svg"},
}
SOURCE_FILES = (
    ".gitignore", "package.json", "package-lock.json", "pyproject.toml", "uv.lock", "index.html",
    "tsconfig.json", "vite.config.ts", "playwright.config.ts", "eslint.config.js",
    "backend/Dockerfile.modal", "docs/STARTER.md", "docs/JUDGE_GUIDE.md", "docs/SUBMISSION_DRAFT.md",
)
RUNTIME_LICENSES = ("react", "react-dom", "scheduler")
SEED_TOP = ("summary.json", "recording.json", "regression.test.mjs", "regression-buggy.txt", "regression-fixed.txt")
RUN_FILES = ("result.json", "actions.json", "console.json", "network.json", "frames.json", "final.png", "recording.webm", "trace.zip")
MAX_MEMBERS, MAX_FILE, MAX_TOTAL = 2000, 16 * 1024**2, 350 * 1024**2
FIXED_TIME = (2026, 11, 3, 0, 0, 0)
ENDPOINT = re.compile(r"\b[A-Za-z0-9_-]+--ep-[A-Za-z0-9_-]+\.(?:us-west\.)?modal\.direct\b")
RESOURCE_ID = re.compile(r"\b(?:ap|ep|sb|st|im|ta|ak|as|pk|ps)-[A-Za-z0-9]{16,}\b")
HOME_PATH = re.compile(re.escape("/" + "Users" + "/") + r"[^/\s\"']+/[^\s\"'<>]*")
LINUX_HOME = re.compile(re.escape("/" + "home" + "/") + r"[^/\s\"']+/[^\s\"'<>]*")
SECRET_PATTERNS = {
    "private-key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "openai-key-shaped": re.compile(rb"\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b"),
    "github-token-shaped": re.compile(rb"\b(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}\b"),
    "aws-key-shaped": re.compile(rb"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "modal-credential-shaped": re.compile(rb"\b(?:ak|as|pk|ps)-[A-Za-z0-9]{20,}\b"),
    "modal-workspace-proxy-shaped": re.compile(rb"\b(?:wk|ws)-[A-Za-z0-9_-]{16,}\b"),
    "modal-workspace-proxy-combined": re.compile(rb"\bwk-[A-Za-z0-9_-]{8,}\.ws-[A-Za-z0-9_-]{8,}\b"),
    "baseten-key-shaped": re.compile(rb"\b[a-z]{2}_[A-Za-z0-9]{40,}\b"),
}
TEXT_SUFFIXES = {".py", ".tsx", ".ts", ".mjs", ".js", ".json", ".jsonl", ".trace", ".stacks", ".network", ".css", ".html", ".md", ".toml", ".lock", ".txt", ".log", ".tap", ".svg", ".modal", ".srt", ".vtt", ".ass"}
transforms: list[dict] = []
origins: dict[str, dict] = {}
fixture_exclusions: dict[str, int] = {}
SYNTHETIC_PROXY_LITERALS = {
    "tests/test_modal_planner.py": (b"wk-" + b"synthetic.ws-" + b"not-a-real-secret", b"wk-" + b"synthetic", b"ws-" + b"not-a-real-secret"),
    "tests/test_live_preflight.py": (b"wk-" + b"synthetic.ws-" + b"synthetic",),
}


def sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def safe_name(name: str) -> None:
    path = PurePosixPath(name)
    if not name or "\\" in name or "\x00" in name or path.is_absolute() or path.as_posix() != name or any(p in {".", ".."} for p in path.parts):
        raise ValueError("Unsafe archive member name")
    if any(p in {".data", ".venv", "node_modules", "__pycache__", ".cache", ".design-tools", ".hallmark"} or p.startswith(".env") for p in path.parts):
        raise ValueError("Forbidden package path")


def zip_bytes(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, raw in sorted(members.items()):
            safe_name(name)
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(info, raw)
    return buffer.getvalue()


def redact_text(text: str) -> tuple[str, list[str]]:
    reasons = []
    for pattern, replacement, reason in (
        (ENDPOINT, "workspace-endpoint-redacted.us-west.modal.direct", "workspace endpoint identifier"),
        (RESOURCE_ID, "provider-resource-redacted", "provider resource identifier"),
        (HOME_PATH, "/redacted/local-path", "personal host filesystem path"),
        (LINUX_HOME, "/redacted/local-path", "personal Linux home path"),
    ):
        text, count = pattern.subn(replacement, text)
        if count:
            reasons.append(f"{reason}: {count}")
    return text, reasons


def sanitized(raw: bytes, suffix: str, label: str) -> bytes:
    if suffix == ".zip":
        members = {}
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if len(archive.infolist()) > 160:
                raise ValueError("Nested archive member ceiling exceeded")
            if sum(i.file_size for i in archive.infolist()) > 24 * 1024**2:
                raise ValueError("Nested archive expanded-byte ceiling exceeded")
            for info in archive.infolist():
                safe_name(info.filename)
                if info.filename in members:
                    raise ValueError("Duplicate nested ZIP member")
                if info.is_dir() or stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1:
                    raise ValueError("Unsupported nested ZIP member")
                value = archive.read(info)
                members[info.filename] = sanitized(value, Path(info.filename).suffix, label + "!" + info.filename)
        # Preserve exact original bytes when nothing inside was changed.
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            unchanged = all(archive.read(name) == value for name, value in members.items())
        return raw if unchanged else zip_bytes(members)
    if suffix in TEXT_SUFFIXES or suffix == "":
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            return raw
        text, reasons = redact_text(text)
        updated = text.encode()
        if reasons:
            transforms.append({"path": label, "originalSha256": sha(raw), "packagedSha256": sha(updated), "reasons": reasons})
        return updated
    return raw


def put(name: str, raw: bytes, *, original: Path | None = None, sanitize: bool = True) -> None:
    safe_name(name)
    if original and (not original.resolve().is_relative_to(ROOT)
                     or any(part.is_symlink() for part in (original, *original.parents) if part.is_relative_to(ROOT))):
        raise ValueError("Only regular in-project files may be packaged")
    limit = 200 * 1024**2 if name == "proof/demo.mp4" else MAX_FILE
    if len(raw) > limit:
        raise ValueError(f"Member size ceiling exceeded: {name}")
    updated = sanitized(raw, Path(name).suffix, name) if sanitize else raw
    target = STAGE / name
    if target.exists():
        raise ValueError(f"Duplicate staged member: {name}")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(updated)
    origins[name] = {"source": str(original.relative_to(ROOT)) if original else "generated-public-review-document",
                     "originalSha256": sha(raw), "packagedSha256": sha(updated), "byteIdentical": raw == updated}


def copy(source: Path, name: str | None = None) -> None:
    if not source.is_file():
        raise ValueError(f"Required allowlisted input missing: {source.relative_to(ROOT)}")
    put(name or source.relative_to(ROOT).as_posix(), source.read_bytes(), original=source)


def staged_core_test_proof() -> None:
    report_file = OUT / "staged-core-tests.json"
    report = json.loads(report_file.read_text())
    output = OUT / "staged-pytest-output.txt"
    if (report.get("status") != "passed" or report.get("passed") != 360 or report.get("providerCalls") != 0
            or report.get("PYTHONPATHOverride") is not False or sha(output.read_bytes()) != report.get("rawOutputSha256")):
        raise ValueError("Staged core test proof is missing or inconsistent")
    expected = {file.relative_to(STAGE).as_posix() for directory in ("backend", "tests") for file in (STAGE / directory).rglob("*.py")}
    expected.update({"pyproject.toml", "uv.lock"})
    if set(report["sourceHashes"]) != expected:
        raise ValueError("Staged core test source inventory changed; rerun the actual public suite")
    for name, digest in report["sourceHashes"].items():
        safe_name(name)
        if sha((STAGE / name).read_bytes()) != digest:
            raise ValueError("Staged core test source changed; rerun the actual public suite")
    copy(report_file, "proof/staged-core-tests.public.json")
    copy(output, "proof/staged-core-tests.txt")


def validate_runtime_proof(proof: dict) -> None:
    """Admit only the explicitly public completed runtime derivative, never private receipts."""
    if (not isinstance(proof, dict) or proof.get("kind") != "public-derived-guarded-runtime-verification"
            or proof.get("status") != "verified" or proof.get("currentLiveApiEnabled") is not False
            or type(proof.get("modelCallsInRuntimeVerification")) is not int
            or proof["modelCallsInRuntimeVerification"] != 0):
        raise ValueError("Public runtime proof must be verified and cannot imply live API or model execution")
    runtime = proof["runtime"]
    if (runtime.get("provider") != "Modal" or runtime.get("runtime") != "vm" or runtime.get("sdkVersion") != "1.6.3"
            or runtime.get("outerMemoryMiB") != [2048, 2048] or runtime.get("workloadMemoryLimitBytes") != 1073741824
            or runtime.get("workloadSwapMaxBytes") != 0 or runtime.get("sandboxTtlSeconds") != 45
            or runtime.get("cpuRequestedPhysicalCores") != 1 or runtime.get("cpuMaximumPhysicalCores") != 2
            or runtime.get("guardSha256") != sha((ROOT / "backend/cgroup_guard.py").read_bytes())):
        raise ValueError("Public runtime resources or trusted guard source differ")
    if any(type(runtime.get(key)) is not int for key in ("workloadMemoryLimitBytes", "workloadSwapMaxBytes", "sandboxTtlSeconds", "cpuRequestedPhysicalCores", "cpuMaximumPhysicalCores")):
        raise ValueError("Public runtime numeric resources cannot be boolean or coerced strings")
    boundary, seed, regression, terminal, memory = (proof[key] for key in ("boundary", "seedVerification", "exactRegression", "termination", "memoryEvidence"))
    if (boundary.get("passed") != 6 or boundary.get("total") != 6 or len(boundary.get("controls", [])) != 6
            or [row.get("mode") for row in boundary["controls"]] != ["probe-memory", "probe-manual-kill", "probe-timeout", "readiness-failure", "cancellation", "provider-ttl"]
            or any(row.get("status") != "passed" for row in boundary["controls"])):
        raise ValueError("All six distinct completed runtime controls are required")
    if (memory.get("kernelConstraint") != "CONSTRAINT_MEMCG" or memory.get("exactLeafAndVictimPidMatched") is not True
            or memory.get("globalOomObserved") is not False or memory.get("supervisorSurvivedOutsideLeaf") is not True
            or memory.get("rootProtectedReceiptVerified") is not True or memory.get("leafCleanupVerified") is not True
            or any(type(memory.get("localEventDeltas", {}).get(key)) is not int or memory["localEventDeltas"][key] <= 0
                   for key in ("max", "oom", "oom_kill", "oom_group_kill"))):
        raise ValueError("Public memory proof lacks definitive local kernel attribution")
    if (seed.get("pairs"), seed.get("runs"), seed.get("buggyFailures"), seed.get("fixedPasses")) != (5, 30, 15, 15):
        raise ValueError("Runtime proof requires all five repeated pairs")
    if [case.get("id") for case in seed.get("cases", [])] != list(SEEDS):
        raise ValueError("Public runtime cohort must contain the five exact shipped cases")
    for case in seed["cases"]:
        if (case.get("buggyFailures") != 3 or case.get("fixedPasses") != 3 or len(case.get("resultHashes", [])) != 6
                or not re.fullmatch(r"[a-f0-9]{64}", case.get("invariantHash", ""))
                or any(not re.fullmatch(r"[a-f0-9]{64}", digest) for digest in case["resultHashes"])):
            raise ValueError("Each public runtime case requires its frozen invariant and six original result hashes")
        for variant in ("buggy", "fixed"):
            if case.get("sourceHashes", {}).get(variant) != sha((ROOT / "fixtures" / case["id"] / variant / "App.tsx").read_bytes()):
                raise ValueError("Public runtime case source changed")
    if any(type(row.get("testExitCode")) is not int for row in regression.get("runs", [])):
        raise ValueError("Regression exit codes must be real integer observations")
    if (regression.get("testSha256") != sha((LIVE / "regression.test.mjs").read_bytes())
            or regression.get("sameTestAgainstBothBuilds") is not True or regression.get("guardProtectedReceiptsVerified") is not True
            or [(r.get("variant"), r.get("testExitCode"), r.get("result")) for r in regression.get("runs", [])]
            != [("buggy", 1, "failed"), ("fixed", 0, "passed")]):
        raise ValueError("Identical exact regression must fail buggy and pass fixed under the guard")
    if any(terminal.get(key) != expected for key, expected in {"boundaryVmsTerminal": 6, "seedVmsTerminal": 30,
            "regressionVmsTerminal": 2, "verifiedCohortVmsTerminal": 38, "firstFailedCohortVmsTerminal": 6}.items()):
        raise ValueError("Public runtime VM cleanup is incomplete")
    if any(not re.fullmatch(r"[a-f0-9]{64}", proof.get("bindings", {}).get(key, ""))
           for key in ("runtimeManifestSha256", "boundaryPhaseSha256", "seedPhaseSha256", "regressionReceiptSha256")):
        raise ValueError("Public runtime proof must bind its actual private evidence hashes")


def runtime_proof() -> dict | None:
    if not RUNTIME_PROOF.exists():
        return None
    if RUNTIME_PROOF.is_symlink() or RUNTIME_PROOF.stat().st_size > 256 * 1024:
        raise ValueError("Runtime public derivative must be a bounded regular file")
    raw = RUNTIME_PROOF.read_bytes()
    proof = json.loads(raw)
    validate_runtime_proof(proof)
    if scan(raw, "proof/runtime-summary.json"):
        raise ValueError("Runtime derivative contains a private identifier or known credential shape")
    put("proof/runtime-summary.json", raw, original=RUNTIME_PROOF, sanitize=False)
    return proof


def runtime_html(proof: dict | None) -> str:
    if proof is None:
        return '<section id="runtime"><h2>Runtime verification is pending</h2><p>E06 remains open. General uploaded-app live execution stays disabled; the historical model jobs do not establish the new guarded runtime.</p></section>'
    return '<section id="runtime"><h2>The guarded runtime is verified</h2><p>Six real boundary controls passed. The five unchanged known challenges each produced three buggy failures and three fixed passes in 30 guarded browser runs. The identical exported regression then failed buggy and passed fixed in two additional VMs. All 38 VMs in the verified cohort have terminal evidence.</p><p>A root-owned 1 GiB workload cgroup inside a 2 GiB Modal VM produced exact kernel memcg/leaf/victim attribution and local OOM counters. Manual-kill and timeout controls stayed distinct. The earlier outer-memory exit137 remains inconclusive; the failed cleanup/metadata attempts remain recorded.</p><p>General live API execution stays off. This verifies the reviewed runtime and narrow schedules, not arbitrary repositories, broad reliability or production security. These runtime checks made no model calls; genuine Muse decisions are documented separately below.</p><p><a href="runtime-summary.json">Public runtime evidence and source hashes</a></p></section>'


def public_proof() -> dict:
    summary = json.loads((LIVE / "summary.json").read_text())
    provenance = json.loads((LIVE / "provenance.json").read_text())
    accepted = [p for p in provenance if p.get("outcome") == "proposed"]
    if not summary.get("verified") or summary.get("mode") != "live" or len(accepted) != 1:
        raise ValueError("Known Meta proof does not meet the expected captured-live contract")
    proposal = accepted[0]
    assert proposal["proposedActions"] == summary["initialActions"] == proposal["executedActions"]
    selected = {key: summary[key] for key in (
        "verified", "mode", "runner", "challengeId", "sourceHashes", "invariantHash", "assertion", "completion", "seed", "schedule",
        "initialActions", "actions", "initialActionCount", "minimizedActionCount", "minimizationProbes", "minimality", "buggyFailures",
        "fixedPasses", "validationRuns", "browserRuns", "infrastructureErrors", "elapsedMs", "modelCalls", "modelUsage", "modelProvider", "estimatedModelCostUsd", "limits",
    )}
    selected.update(publicDerivative=True, evaluationScope="One known seed; not held-out generalization", modelIdentity="meta-models/Muse-Spark-Open-816B-A42B",
                    workspaceEndpoint="redacted", originalSummarySha256=sha((LIVE / "summary.json").read_bytes()),
                    originalProvenanceSha256=sha((LIVE / "provenance.json").read_bytes()))
    # Proposal/action/assertion payloads stay untouched; only account/path metadata is sanitized.
    clean = json.loads(redact_text(json.dumps(proposal, ensure_ascii=False))[0])
    assert clean["proposal"] == proposal["proposal"] and clean["proposedActions"] == proposal["proposedActions"]
    put("proof/live/summary.public.json", (json.dumps(selected, indent=2) + "\n").encode(), original=LIVE / "summary.json")
    put("proof/live/provenance.public.json", (json.dumps(clean, indent=2, ensure_ascii=False) + "\n").encode(), original=LIVE / "provenance.json")
    # Keep source binding/hash receipt for curated public derivatives, not a false byte-identity claim.
    for file in ("summary.public.json", "provenance.public.json"):
        source = LIVE / file.replace(".public", "")
        origins["proof/live/" + file].update(originalSha256=sha(source.read_bytes()), byteIdentical=False, derivative=True)
    input_frames = []
    for index, frame in enumerate(proposal["frames"]):
        source = ROOT / f"evidence/live-authorized/attempt-07/prepared/frames/frame-{index:02d}.png"
        if sha(source.read_bytes()) != frame["sha256"]:
            raise ValueError("Original model input frame hash mismatch")
        copy(source, f"proof/live/input-frames/frame-{index:02d}.png")
        input_frames.append({**frame, "file": f"frame-{index:02d}.png"})
    put("proof/live/input-frames/frames.json", (json.dumps(input_frames, indent=2) + "\n").encode())
    copy(LIVE / "regression.test.mjs", "proof/live/regression.test.mjs")
    for variant in ("buggy", "fixed"):
        copy(LIVE / f"player-{variant}.html", f"proof/live/player-{variant}.html")
        copy(LIVE / f"{variant}-recording.webm", f"proof/live/{variant}-recording.webm")
        copy(LIVE / f"{variant}-trace.zip", f"proof/live/{variant}-trace.zip")
        copy(ROOT / f"evidence/live-authorized/known-seed-05/regression-{variant}.tap", f"proof/live/regression-{variant}.tap")
    rows = []
    for i, directory in enumerate(("10-validation-buggy", "11-validation-fixed", "12-validation-buggy", "13-validation-fixed", "14-validation-buggy", "15-validation-fixed")):
        run = json.loads((LIVE / directory / "result.json").read_text())
        expected = "failed" if i % 2 == 0 else "passed"
        assert run["status"] == expected and run["error"] is None
        assert run["assertion"]["hash"] == summary["invariantHash"]
        assert [event["action"] for event in run["actions"]] == summary["actions"]
        assert run["schedule"] == summary["schedule"] and run["seed"] == summary["seed"]
        for file in RUN_FILES:
            copy(LIVE / directory / file, f"proof/live/{directory}/{file}")
        for file in sorted((LIVE / directory).glob("frame-*.png")):
            copy(file, f"proof/live/{directory}/{file.name}")
        assert (STAGE / f"proof/live/{directory}/result.json").read_bytes() == (LIVE / directory / "result.json").read_bytes()
        rows.append({"directory": directory, "variant": run["variant"], "status": run["status"], "actual": run["assertion"]["actual"],
                     "resultSha256": sha((LIVE / directory / "result.json").read_bytes())})
    assert summary["buggyFailures"] == summary["fixedPasses"] == 3
    selected["validation"] = rows
    selected["proposal"] = proposal["proposal"]
    selected["proposalPayloadSha256"] = sha(canonical(proposal["proposal"]).encode())
    selected["regressionSha256"] = sha((LIVE / "regression.test.mjs").read_bytes())
    selected["inputFrames"] = input_frames
    regression_receipt = json.loads((ROOT / "evidence/live-authorized/known-seed-05/session.json").read_text())
    selected["regressionOutputs"] = {}
    for entry in regression_receipt["regressions"]:
        variant, report = entry["variant"], entry["report"]
        original = (ROOT / f"evidence/live-authorized/known-seed-05/regression-{variant}.tap").read_bytes()
        if (report["testReturncode"] != (1 if variant == "buggy" else 0) or report["timedOut"]
                or report["outputBounded"] is not True or sha(original) != report["tapSha256"]):
            raise ValueError("Captured regression output does not match its execution receipt")
        public = (STAGE / f"proof/live/regression-{variant}.tap").read_bytes()
        selected["regressionOutputs"][variant] = {"exitCode": report["testReturncode"],
            "originalSha256": sha(original), "publicSha256": sha(public), "output": public.decode("utf-8")}
    put("proof/live/evaluation.public.json", (json.dumps(selected, indent=2, ensure_ascii=False) + "\n").encode())
    return selected


def heldout_proof() -> dict:
    """Curate the separately frozen first-party coupon case, never a sixth seed."""
    summary = json.loads((HELDOUT / "summary.json").read_text())
    provenance = json.loads((HELDOUT / "provenance.json").read_text())
    freeze = json.loads((HELDOUT_INPUT / "artifacts/freeze.json").read_text())
    candidate = json.loads((HELDOUT_INPUT / "manifest.json").read_text())
    investigation = json.loads((HELDOUT_TRIAL / "investigation-receipt.json").read_text())
    regression = json.loads((HELDOUT_TRIAL / "regression-receipt.json").read_text())
    accepted = [row for row in provenance if row.get("outcome") == "proposed"]
    if (summary.get("verified") is not True or summary.get("mode") != "live" or summary.get("challengeId") != "coupon-total"
            or len(accepted) != 1 or summary.get("modelCalls") != 1 or investigation.get("status") != "verified-pipeline-heldout"
            or regression.get("status") != "exact-regression-verified"):
        raise ValueError("Held-out proof lacks its genuine live investigation and exact-test receipts")
    proposal = accepted[0]
    if proposal["proposedActions"] != summary["initialActions"] or proposal["executedActions"] != summary["initialActions"]:
        raise ValueError("Held-out model actions did not drive initial execution")
    if (candidate.get("actions") or candidate.get("initialActions") or candidate.get("hint") or candidate.get("explanation")
            or summary["invariantHash"] != freeze["invariantHash"] or summary["seed"] != freeze["seed"]
            or summary["assertion"] != freeze["assertion"] or summary["completion"] != freeze["completion"]):
        raise ValueError("Held-out source/input freeze does not match the executed invariant")
    frozen_at = datetime.fromisoformat(freeze["frozenAt"].replace("Z", "+00:00")).timestamp()
    if frozen_at >= proposal["attemptedAt"]:
        raise ValueError("Candidate must be frozen before the first model proposal")
    for variant in ("buggy", "fixed"):
        name = f"{variant}/App.tsx"
        if sha((HELDOUT_INPUT / name).read_bytes()) != freeze["sourceHashes"][name] or summary["sourceHashes"][name] != freeze["sourceHashes"][name]:
            raise ValueError("Held-out fixture source changed after freezing")
        copy(HELDOUT_INPUT / name, f"proof/heldout/source/{name}")
    copy(HELDOUT_INPUT / "manifest.json", "proof/heldout/source/frozen-manifest.json")
    copy(HELDOUT_INPUT / "artifacts/freeze.json", "proof/heldout/freeze.json")
    selected = {key: summary[key] for key in (
        "verified", "mode", "runner", "challengeId", "sourceHashes", "invariantHash", "assertion", "completion", "seed", "schedule",
        "initialActions", "actions", "initialActionCount", "minimizedActionCount", "minimizationProbes", "minimality", "buggyFailures",
        "fixedPasses", "validationRuns", "browserRuns", "infrastructureErrors", "elapsedMs", "modelCalls", "modelUsage", "modelProvider", "estimatedModelCostUsd",
    )}
    selected.update(publicDerivative=True, evaluationScope="One pipeline-held-out first-party app, frozen before model use; not an independent benchmark or model-training holdout",
                    modelIdentity="meta-models/Muse-Spark-Open-816B-A42B", workspaceEndpoint="redacted", frozenAt=freeze["frozenAt"],
                    originalSummarySha256=sha((HELDOUT / "summary.json").read_bytes()), originalProvenanceSha256=sha((HELDOUT / "provenance.json").read_bytes()))
    clean = json.loads(redact_text(json.dumps(proposal, ensure_ascii=False))[0])
    if clean["proposal"] != proposal["proposal"]:
        raise ValueError("Privacy redaction unexpectedly changed the held-out model proposal")
    for name, value, original in (("summary.public.json", selected, HELDOUT / "summary.json"), ("provenance.public.json", clean, HELDOUT / "provenance.json")):
        target = f"proof/heldout/{name}"
        put(target, (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode(), original=original)
        origins[target].update(originalSha256=sha(original.read_bytes()), byteIdentical=False, derivative=True)
    for name in ("regression.test.mjs", "source.zip", "replay.json", "player-buggy.html", "player-fixed.html", "buggy-recording.webm", "fixed-recording.webm", "buggy-trace.zip", "fixed-trace.zip"):
        copy(HELDOUT / name, f"proof/heldout/{name}")
    selected["inputFrames"] = []
    for index, frame in enumerate(proposal["frames"]):
        source = HELDOUT_INPUT / f"artifacts/recording-frames/frame-{index:02d}.png"
        if sha(source.read_bytes()) != frame["sha256"]:
            raise ValueError("Held-out model input frame differs from captured provenance")
        copy(source, f"proof/heldout/input-frames/frame-{index:02d}.png")
        selected["inputFrames"].append({**frame, "file": f"frame-{index:02d}.png"})
    put("proof/heldout/input-frames/frames.json", (json.dumps(selected["inputFrames"], indent=2) + "\n").encode())
    selected["validation"] = []
    for row in summary["runs"]:
        if row["phase"] != "validation":
            continue
        directory = Path(row["artifactDirectory"]).name
        run = json.loads((HELDOUT / directory / "result.json").read_text())
        if (run["error"] is not None or run["status"] != ("failed" if row["variant"] == "buggy" else "passed")
                or run["assertion"]["hash"] != summary["invariantHash"] or run["schedule"] != summary["schedule"]
                or run["seed"] != summary["seed"] or [event["action"] for event in run["actions"]] != summary["actions"]):
            raise ValueError("Held-out validation result contradicts its frozen replay")
        for name in RUN_FILES:
            copy(HELDOUT / directory / name, f"proof/heldout/{directory}/{name}")
        for frame in sorted((HELDOUT / directory).glob("frame-*.png")):
            copy(frame, f"proof/heldout/{directory}/{frame.name}")
        target = STAGE / f"proof/heldout/{directory}/result.json"
        if target.read_bytes() != (HELDOUT / directory / "result.json").read_bytes():
            raise ValueError("Held-out canonical result bytes must remain unchanged")
        selected["validation"].append({"directory": directory, "variant": row["variant"], "status": run["status"], "actual": run["assertion"]["actual"], "resultSha256": sha(target.read_bytes())})
    if (len(selected["validation"]) != 6 or sum(row["variant"] == "buggy" for row in selected["validation"]) != 3
            or summary["buggyFailures"] != 3 or summary["fixedPasses"] != 3):
        raise ValueError("Held-out proof requires exactly three buggy failures and three fixed passes")
    selected["regressionSha256"] = sha((HELDOUT / "regression.test.mjs").read_bytes())
    if selected["regressionSha256"] != regression["testSha256"]:
        raise ValueError("Held-out exact regression test hash differs from its execution receipt")
    selected["regressionOutputs"] = {}
    for row in regression["runs"]:
        variant, report = row["variant"], row["report"]
        source = HELDOUT_TRIAL / f"regression-{variant}.tap"
        raw = source.read_bytes()
        if (variant not in {"buggy", "fixed"} or report["testReturncode"] != (1 if variant == "buggy" else 0)
                or report["timedOut"] is not False or report["outputBounded"] is not True or sha(raw) != report["tapSha256"]
                or report["result"]["assertion"]["hash"] != summary["invariantHash"]):
            raise ValueError("Held-out exact-test output is missing or contradictory")
        copy(source, f"proof/heldout/regression-{variant}.tap")
        public = (STAGE / f"proof/heldout/regression-{variant}.tap").read_bytes()
        selected["regressionOutputs"][variant] = {"exitCode": report["testReturncode"], "originalSha256": sha(raw), "publicSha256": sha(public), "output": public.decode()}
    if set(selected["regressionOutputs"]) != {"buggy", "fixed"}:
        raise ValueError("Both held-out exact-test outcomes are required")
    sandboxes = investigation["sandboxes"] + regression["sandboxes"]
    if len(sandboxes) != 16 or any(row.get("terminationConfirmed") is not True for row in sandboxes):
        raise ValueError("Held-out lifecycle evidence is incomplete")
    selected.update(sandboxesTerminal=16, proposal=proposal["proposal"], proposalPayloadSha256=sha(canonical(proposal["proposal"]).encode()),
                    limits="One first-party pipeline-held-out case under one schedule. Historical cloud run predates the new guarded VM runtime; current runtime evidence is documented separately.")
    put("proof/heldout/evaluation.public.json", (json.dumps(selected, indent=2, ensure_ascii=False) + "\n").encode())
    return selected


def heldout_html(proof: dict, runtime: dict | None = None) -> str:
    def esc(value):
        return html.escape(str(value))
    current_runtime = ('The current guarded VM runtime has a separate verified six-control, five-case 3+3 cohort and exact-test record. <a href="../runtime-summary.json">Inspect that runtime proof</a>. General live API execution stays disabled.' if runtime else 'General uploaded-app live execution remains disabled while the separate guarded-runtime verification is pending.')
    outputs = "".join(f'<article><h3>{esc(variant)} · exit {esc(row["exitCode"])}</h3><pre>{esc(row["output"])}</pre></article>' for variant, row in proof["regressionOutputs"].items())
    runs = "".join(f'<article><h3>{esc(row["variant"])} · {esc(row["status"])}</h3><p>Observed total: {esc(row["actual"])}</p><img loading="lazy" src="{esc(row["directory"])}/final.png" alt="Actual captured {esc(row["variant"])} coupon validation result"><p><a href="{esc(row["directory"])}/result.json">Original result</a> · <a href="{esc(row["directory"])}/actions.json">Executed actions</a> · <a href="{esc(row["directory"])}/trace.zip">Browser trace</a></p></article>' for row in proof["validation"])
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'"><title>BugArcade · held-out coupon proof</title><style>body{{background:#11150f;color:#edf1e6;font:17px/1.6 system-ui;margin:0}}main{{max-width:1080px;margin:auto;padding:40px 24px}}h1{{font-size:clamp(34px,5vw,60px);line-height:1.1}}h2{{margin-top:48px}}a{{color:#c7f78d}}a:focus-visible,summary:focus-visible{{outline:2px solid #c7f78d;outline-offset:4px}}pre{{white-space:pre-wrap;overflow-wrap:anywhere;background:#1a2117;padding:20px}}code{{overflow-wrap:anywhere}}.runs,.outputs{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:28px}}img{{width:100%;height:auto}}article{{border-top:1px solid #45513d}}nav{{display:flex;gap:24px;flex-wrap:wrap}}summary{{cursor:pointer;padding:16px 0}}</style></head><body><main><p><a href="../index.html">← Main demo and known-seed proof</a></p><h1>The coupon worked.<br>The total stayed wrong.</h1><p>Camp Supply displays a successful 10% coupon, but a missing React memo dependency keeps the total at $48.00. The fix correctly recomputes $43.20.</p><nav><a href="player-buggy.html" target="_blank" rel="noopener">Play coupon bug ↗</a><a href="player-fixed.html" target="_blank" rel="noopener">Play coupon fix ↗</a></nav><p>Apply coupon → Release coupon-1. These standalone apps replay a controlled local schedule; they make no model or cloud call.</p><h2>A separate, first-party held-out example</h2><p>The candidate was authored and frozen before this model investigation, outside the five gallery cases and supplied planner examples. Submitted actions, initial actions, hints and explanation were empty. An authored witness created the input recording and was excluded from the planner payload.</p><p>This is one pipeline-held-out first-party evaluation—not an independently sourced production bug, an external benchmark, or a claim about model training data. Three repeats under one schedule do not establish broad generalization.</p><p>One real Muse call · 3,963 tokens · 3 → 2 actions · 3 buggy failures / 3 fixed passes · 270.751 seconds. Four invalid minimization outcomes were excluded. Estimated inference: $0.01035075; provider billing remains separate. All sixteen investigation/regression sandboxes have terminal evidence.</p><details><summary>Accepted model proposal and frozen assertion</summary><pre>{esc(json.dumps({'proposal':proof['proposal'],'actions':proof['actions'],'assertion':proof['assertion'],'completion':proof['completion'],'seed':proof['seed'],'schedule':proof['schedule'],'invariantHash':proof['invariantHash']},indent=2,ensure_ascii=False))}</pre></details><p><a href="evaluation.public.json">Scoped evaluation record</a> · <a href="provenance.public.json">Public model provenance</a> · <a href="freeze.json">Original candidate freeze</a> · <a href="input-frames/frames.json">Recording input frame hashes</a> · <a href="source.zip">Packaged source</a></p><h2>Six genuine browser outcomes</h2><div class="runs">{runs}</div><h2>The identical exported test fails and passes</h2><p>Test SHA-256: <code>{esc(proof['regressionSha256'])}</code>.</p><p><a href="regression.test.mjs" download>Exact regression test</a> · <a href="regression-buggy.tap">Captured buggy test output</a> · <a href="regression-fixed.tap">Captured fixed test output</a></p><div class="outputs">{outputs}</div><h2>Scope remains explicit</h2><p>This historical model trial used the previously reviewed runtime; its own success does not validate the new cgroup-guarded VM runtime. {current_runtime}</p><p>The workspace endpoint and personal paths are redacted from public derivatives. Canonical result, source and test hashes are preserved in the package manifest. No private account screenshots, raw billing, credentials or organizer messages are included.</p></main></body></html>'''


def demo_assets() -> dict:
    folder = DEMO.parent
    inspection = json.loads((folder / "media-inspection.json").read_text())
    if (inspection.get("status") != "passed" or inspection.get("sourceSha256") != sha(DEMO.read_bytes())
            or inspection.get("fpsNumerator") != 30 or inspection.get("fpsDenominator") != 1
            or inspection.get("videoFramesDecoded") != 2610 or inspection.get("decodeErrors") != 0
            or inspection.get("durationSeconds") != 87.0 or inspection.get("audioRms", 0) <= 0):
        raise ValueError("Final demo media inspection is missing, stale or failed")
    copy(DEMO, "proof/demo.mp4")
    copy(folder / "narration.txt", "proof/demo-transcript.txt")
    copy(folder / "editorial-captions.srt", "proof/demo-chapters.srt")
    srt = (folder / "editorial-captions.srt").read_text()
    cues = []
    for chunk in srt.strip().split("\n\n"):
        lines = chunk.splitlines()
        if len(lines) < 3 or not re.fullmatch(r"[0-9]+", lines[0]):
            raise ValueError("Editorial chapter caption structure is invalid")
        cues.append("\n".join([lines[1].replace(",", "."), *lines[2:]]))
    put("proof/demo-chapters.vtt", ("WEBVTT\n\nNOTE Authored chapter summaries; full spoken transcript is demo-transcript.txt.\n\n" + "\n\n".join(cues) + "\n").encode())
    public = {key: inspection[key] for key in ("kind", "status", "sourceSha256", "sourceBytes", "durationSeconds", "videoCodec", "audioCodec", "width", "height", "fps", "fpsNumerator", "fpsDenominator", "sampleRate", "videoFramesDecoded", "audioFramesDecoded", "decodeErrors", "captureFrameHashesVerified", "sourceNarrationHashVerified")}
    public.update(audioProvider="Deepgram", narrationRequests=1, captionKind="Authored chapter summaries, separate from the full narration transcript",
                  provenance="Edited actual-browser screenshot captures with authored pointer and chapter overlays; not a continuous screen recording or a fresh model run",
                  scope="Known-note investigation demo; separate coupon proof is in heldout/index.html",
                  capturedDate="2026-11-03", historicalRuntimeState=True,
                  runtimeContext="Captured before final guarded-runtime verification. Narration states the gate status at capture time; current status belongs to the accompanying proof page.")
    put("proof/demo-inspection.public.json", (json.dumps(public, indent=2) + "\n").encode())
    put("proof/demo-README.md", b"# Historical narrated demo\n\nCaptured November 3, 2026, before final guarded-runtime verification. The 87-second narration preserves the gate status at capture time. Read the accompanying proof page for the current runtime result; the video is not the current gate verdict.\n\nThe spoken transcript is preserved in demo-transcript.txt. The SRT/WebVTT files are authored chapter summaries, not verbatim captions. Edited actual-browser captures include an authored pointer; this is neither continuous screen recording nor a fresh model call. One Deepgram narration request was used; no additional voice was generated for this context note. The separate coupon investigation is documented in heldout/index.html.\n")
    return public


def proof_html(proof: dict, demo: bool, runtime: dict | None = None) -> str:
    def esc(value: object) -> str:
        return html.escape(str(value))

    def code(value: object) -> str:
        return esc(json.dumps(value, indent=2, ensure_ascii=False))
    rows = "".join(f'<article><h3>{esc(r["directory"])} · {esc(r["status"])}</h3><p>Observed: <code>{esc(r["actual"])}</code></p><img loading="lazy" src="live/{esc(r["directory"])}/final.png" alt="Actual captured {esc(r["variant"])} result"/><p><a href="live/{esc(r["directory"])}/result.json">Result</a> · <a href="live/{esc(r["directory"])}/actions.json">Executed actions</a> · <a href="live/{esc(r["directory"])}/trace.zip">Browser trace</a></p></article>' for r in proof["validation"])
    frames = "".join(f'<article><h3>Input frame · {esc(f["timestampMs"])} ms</h3><img loading="lazy" src="live/input-frames/{esc(f["file"])}" alt="Actual model input recording sample at {esc(f["timestampMs"])} milliseconds"/><p><code>{esc(f["sha256"])}</code></p></article>' for f in proof["inputFrames"])
    test_outputs = "".join(f'<article><h3>{esc(variant.title())} · exit {esc(proof["regressionOutputs"][variant]["exitCode"])}</h3><pre>{esc(proof["regressionOutputs"][variant]["output"])}</pre></article>' for variant in ("buggy", "fixed"))
    demo_html = '<section><h2>Watch the 87-second demo</h2><p><strong>Historical capture · November 3, 2026.</strong> Recorded before final guarded-runtime verification. The narration states the gate status at capture time; current runtime status is documented below. <a href="demo-README.md">Capture context</a></p><video controls preload="metadata" src="demo.mp4"></video><p>Deepgram narration over edited actual-browser captures, with authored pointer and chapter captions. This is captured playback, with no fresh model call.</p><p><a href="demo-transcript.txt">Full spoken transcript</a> · <a href="demo-chapters.srt">Chapter captions (summary)</a> · <a href="demo-chapters.vtt">WebVTT chapters</a> · <a href="demo-inspection.public.json">Media inspection</a></p></section>' if demo else '<p>A final demo video has not been included in this archive. The captured browser recordings below are genuine worker output.</p>'
    return f'''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'"><title>BugArcade · captured proof</title><style>body{{margin:0;background:#11150f;color:#edf1e6;font:17px/1.6 system-ui,sans-serif}}main{{max-width:1080px;margin:auto;padding:40px 24px}}h1{{font-size:clamp(36px,5vw,64px);line-height:1.08;letter-spacing:-2px}}h2{{font-size:30px;line-height:1.2;margin-top:48px}}h3{{font-size:20px}}a{{color:#c7f78d}}a:focus-visible,summary:focus-visible{{outline:2px solid #c7f78d;outline-offset:4px}}p{{max-width:74ch}}pre{{overflow:auto;padding:20px;background:#1a2117;border:1px solid #45513d;white-space:pre-wrap;overflow-wrap:anywhere}}code{{overflow-wrap:anywhere}}.runs{{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:28px}}article{{border-top:1px solid #45513d}}img,video{{width:100%;height:auto}}.actions{{display:flex;gap:24px;flex-wrap:wrap;padding:16px 0}}summary{{cursor:pointer;padding:12px 0}}footer{{margin-top:48px;border-top:1px solid #45513d;padding-top:24px}}.test-outputs{{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px}}.test-outputs pre{{white-space:pre-wrap;overflow-wrap:anywhere;font-size:15px;line-height:1.5}}@media(max-width:750px){{.test-outputs{{grid-template-columns:1fr}}}}</style></head><body><main>
<p>A debugging game for React developers · local review package</p><h1>Break a real bug.<br>Replay it. Check the fix.</h1><p>Can you make Papertrail lose a note in three moves? Start sync, add the new note, then release the waiting save response. The buggy app overwrites your note with an old snapshot.</p>
<nav class="actions" aria-label="Playable versions"><a href="live/player-buggy.html" target="_blank" rel="noopener">Play buggy app ↗</a><a href="live/player-fixed.html" target="_blank" rel="noopener">Play fixed app ↗</a><a href="../docs/JUDGE_GUIDE.md">Judge guide</a></nav>
<p>These standalone apps use an in-memory response schedule and no network calls. Playback is for exploration. Independent captured worker assertions below are the verification evidence.</p>{demo_html}{runtime_html(runtime)}
<section><h2>Meta proposed. The browser decided.</h2><p>This is a public derivative of one genuinely captured Meta Muse Spark Open investigation through Modal. It is a known seed, not held-out generalization. Opening this page makes no model or cloud call.</p><p>One model call · 2,839 tokens · 4 → 3 actions · 3 buggy failures / 3 fixed passes · 276.552 seconds. Six invalid minimization outcomes were rejected. Estimated inference cost: $0.00631175; total provider billing is separate.</p><details open><summary>Accepted model proposal</summary><pre>{code(proof['proposal'])}</pre></details><details><summary>Minimized replay and immutable assertion</summary><pre>{code({'actions':proof['actions'],'assertion':proof['assertion'],'completion':proof['completion'],'seed':proof['seed'],'schedule':proof['schedule'],'invariantHash':proof['invariantHash']})}</pre></details><p><a href="live/summary.public.json">Public summary</a> · <a href="live/provenance.public.json">Public provenance and initial execution trace</a></p></section>
<section><h2>The recording evidence the model received</h2><p>Four actual timestamped input frames, each checked against the captured proposal’s input hash. These are recording samples, distinct from the later worker screenshots. Samples can miss fast interactions; browser action/network traces retain execution order.</p><div class="runs input-frames">{frames}</div><p><a href="live/input-frames/frames.json">Frame timestamps and hashes</a></p></section>
<section><h2>The same test fails buggy and passes fixed.</h2><p><a href="live/regression.test.mjs" download>Exact exported regression test</a> · <a href="live/regression-buggy.tap">Captured buggy test output</a> · <a href="live/regression-fixed.tap">Captured fixed test output</a></p><p>Test SHA-256: <code>{esc(proof['regressionSha256'])}</code>. This submitted-app test requires an authorized sandbox and explicit project directory. Do not bypass its guard to run uploaded source on the host.</p><details id="test-output"><summary>Inspect captured test output</summary><p>Actual Node test output from the two isolated regression runs. This page starts no test or provider call.</p><div class="test-outputs">{test_outputs}</div></details><div class="runs">{rows}</div></section>
<section><h2>Genuine captured recordings</h2><h3>Buggy</h3><video controls preload="none" src="live/buggy-recording.webm"></video><h3>Fixed</h3><video controls preload="none" src="live/fixed-recording.webm"></video><p>Text alternative: Sync → Add note → Release save-1. The buggy app loses “Book the demo slot”; the fixed app retains it. Recordings are worker captures, separate from your current playback session.</p></section>
<section><h2>A second app, held out from this pipeline</h2><p>Camp Supply accepted a 10% coupon but kept the old total. A separate Muse investigation proposed three actions, minimized to two, and verified three buggy failures plus three fixed passes. The exact exported test also failed buggy and passed fixed.</p><p><a href="heldout/index.html">Inspect the first-party held-out coupon case →</a></p><p>The app and assertion were frozen before model use; no witness action plan or hints were supplied. This is one first-party evaluation case, not a broad benchmark or a claim about model training data.</p></section>
<section><h2>Deliberately narrow claims</h2><p>The five gallery cases use authored plans with captured browser results. The note demo is one known seed; the coupon record is a separate first-party pipeline-held-out example. Three repeats under one schedule are repeatability evidence, not broad reliability. General uploaded-app live execution remains disabled. Current runtime verification is documented separately above.</p><p>The workspace endpoint and personal filesystem paths are redacted in public derivatives. Fixture source, proposal/action/assertion payloads and six result files are preserved. See <a href="../transformation-receipt.json">transformation receipt</a>, <a href="../package-manifest.json">file hashes</a> and <a href="../package-audit.json">package audit</a>.</p></section><footer><p>No deployment, publication or hackathon submission has been performed. Participant acceptance was verified from an October20 organizer approval. A November3 organizer update requires an open-source GitHub repository and emphasizes a three-minute demo. Repository publication, project-license selection and submission remain pending authorization; the public page still supplies no numeric project-judging weights.</p></footer></main></body></html>'''


def scan(raw: bytes, name: str, *, nested: bool = True) -> list[dict]:
    scanned = raw
    excluded = 0
    for literal in SYNTHETIC_PROXY_LITERALS.get(name, ()):
        excluded += scanned.count(literal)
        scanned = scanned.replace(literal, b"documented-synthetic-test-fixture")
    if excluded:
        fixture_exclusions[name] = excluded
    findings = [{"path": name, "type": kind} for kind, pattern in SECRET_PATTERNS.items() if pattern.search(scanned)]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = ""
    for pattern, kind in ((ENDPOINT, "workspace-endpoint"), (RESOURCE_ID, "provider-resource-id"), (HOME_PATH, "personal-host-path"), (LINUX_HOME, "personal-home-path")):
        if pattern.search(text):
            findings.append({"path": name, "type": kind})
    if nested and name.endswith(".zip"):
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            if len(archive.infolist()) > 160 or sum(i.file_size for i in archive.infolist()) > 24 * 1024**2:
                raise ValueError("Nested scan ceiling exceeded")
            for info in archive.infolist():
                safe_name(info.filename)
                findings.extend(scan(archive.read(info), name + "!" + info.filename, nested=False))
    return findings


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--demo", type=Path, help="Only evidence/submission-demo/bugarcade-demo.mp4 is admitted")
    args = parser.parse_args()
    if args.demo and (args.demo.resolve() != DEMO or not DEMO.is_file() or DEMO.is_symlink()):
        raise ValueError("Demo must be the explicitly allowlisted in-project MP4")
    if OUT.is_symlink() or STAGE.is_symlink():
        raise ValueError("Generated output directories must not be symlinks")
    OUT.mkdir(exist_ok=True)
    (OUT / "build-receipt.json").write_text(json.dumps({"status": "building", "published": False, "submitted": False}) + "\n")
    # A failed rebuild must not leave a previous passed receipt as its current verdict.
    if STAGE.exists():
        # Delete only this tool's generated staging directory, never arbitrary supplied paths.
        shutil.rmtree(STAGE)
    STAGE.mkdir()
    for directory, suffixes in SOURCE_ROOTS.items():
        for source in sorted((ROOT / directory).rglob("*")):
            if source.is_file() and "__pycache__" not in source.parts and source.suffix in suffixes:
                copy(source)
    for file in SOURCE_FILES:
        if file not in origins:
            copy(ROOT / file)
    staged_core_test_proof()
    # Notices for the React runtime embedded in offline cartridges.
    for dependency in RUNTIME_LICENSES:
        copy(ROOT / "node_modules" / dependency / "LICENSE", f"third-party/{dependency}-MIT-LICENSE.txt")
    for seed in SEEDS:
        folder = ROOT / "evidence/seeds" / seed
        for name in SEED_TOP:
            copy(folder / name)
        for frame in sorted((folder / "recording-frames").glob("*.png")):
            copy(frame)
        for variant in ("buggy", "fixed"):
            for n in range(1, 4):
                run = folder / f"{variant}-{n}"
                for name in RUN_FILES:
                    # Repeat 2/3 may intentionally omit extra video/frame captures.
                    if name == "recording.webm" and not (run / name).is_file():
                        continue
                    copy(run / name)
                for frame in sorted(run.glob("frame-*.png")):
                    copy(frame)
    proof = public_proof()
    runtime = runtime_proof()
    heldout = heldout_proof()
    put("proof/heldout/index.html", heldout_html(heldout, runtime).encode())
    demo = None
    if args.demo:
        demo = demo_assets()
    put("proof/index.html", proof_html(proof, bool(args.demo), runtime).encode())
    readme = '''# BugArcade review package

Open `proof/index.html` for the offline playable cartridges, real captured Meta decisions and separate known-note/first-party-held-out coupon outcomes. No credentials or dependency install is needed for that review. Read `docs/JUDGE_GUIDE.md` and `docs/SUBMISSION_DRAFT.md` for the walkthrough, exact scope and draft narrative.

## Run the complete local app

Use Node 22.14+ and Python 3.12/3.13 with uv. Dependency versions are pinned. In this extracted directory:

```sh
npm ci --ignore-scripts
uv sync --extra dev --extra cloud
npx playwright install chromium
npm start
```

Open http://127.0.0.1:5173. If occupied, preserve that service and run the UI with `npm run dev -- --port 4173`, plus `npm run dev:fixtures` and `.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000` in separate terminals. All services bind loopback. Dependency/browser installation needs network once; execution never installs submitted dependencies. No cloud access is enabled by these commands.

The five shipped seeds and their evidence work without model credentials. The private completed-job database is deliberately absent, so the app's historical Meta link shows an explicit unavailable state. Use the independent `proof/index.html` public record instead; this is not a fabricated live API response. No personal browser progress is included.

Checks: `npm run lint`, `npm run typecheck`, `npm run build`, `.venv/bin/pytest`, `.venv/bin/ruff check backend tests scripts`, `npm run test:worker`, `node --experimental-strip-types --test tests/arcade-progress.test.mjs tests/job-evidence.test.mjs`. Browser tests need the three local services and can create genuine local recorded jobs; set `BUGARCADE_BASE_URL` and `BUGARCADE_EXISTING_SERVERS=1` when using an alternate UI port. The historical 45-test result belongs to the maintainer’s original workspace. `investigation-proof.spec.ts` depends on private completed-job state deliberately excluded here; those private-route cases cannot pass in this clean public install. Use the independent offline proof for that captured Meta record. The portable browser suite is:

```sh
npx playwright test tests/e2e/arcade.spec.ts tests/e2e/focus.spec.ts tests/e2e/gamification.spec.ts tests/e2e/hallmark.spec.ts tests/e2e/job-status.spec.ts tests/e2e/landing.spec.ts tests/e2e/motion.spec.ts
```

This command is supplied for reproduction; the package receipt records actual offline proof checks, not a claim that the entire portable suite has been freshly run from a new install.

General uploaded-app live execution stays disabled; E06 memory-kill attribution is pending new-runtime validation. The coupon case is a separately labeled first-party pipeline-held-out example, not broad generalization evidence. The local runner is a development convenience for trusted seeds, not security isolation. No production-readiness, arbitrary-repository support, broad generalization, publication or submission claim is made. The organizer requires an open-source GitHub repository; no project license grant or repository publication has been authorized or performed.

Verify `package-manifest.json` against the extracted file bytes. `package-audit.json` and `transformation-receipt.json` document bounded scanning, archive checks and staged-only privacy redactions. This manifest excludes itself and the audit to avoid circular hashes; the outer ZIP SHA is in the adjacent build receipt. Installed dependencies and credentials are excluded; three MIT license texts under `third-party/` accompany the runtime already embedded in the cartridges.
'''
    if runtime:
        readme = readme.replace("General uploaded-app live execution stays disabled; E06 memory-kill attribution is pending new-runtime validation.", "The guarded-runtime evidence verifies six boundary controls, all five 3+3 seed pairs and the identical failing/passing regression, with all 38 cohort VMs terminal; see proof/runtime-summary.json. General live API execution remains off by policy.")
    put("README.md", readme.encode())
    receipt = {"kind": "explicit-public-derivative", "scope": "Staged copies only; private originals unchanged", "transformations": transforms,
               "selectedDerivativeSources": {k: v for k, v in origins.items() if v.get("derivative")},
               "protected": {"fixtureSourcesUnchanged": all(v["byteIdentical"] for k, v in origins.items() if k.startswith("fixtures/")),
                             "liveRegressionSha256": proof["regressionSha256"], "proposalPayloadSha256": proof["proposalPayloadSha256"],
                             "validationResultSha256": {r["directory"]: r["resultSha256"] for r in proof["validation"]},
                             "heldoutRegressionSha256": heldout["regressionSha256"], "heldoutProposalPayloadSha256": heldout["proposalPayloadSha256"],
                             "heldoutValidationResultSha256": {r["directory"]: r["resultSha256"] for r in heldout["validation"]}},
               "limits": "Known text identifiers and paths redacted; PNG/MP4/WebM content requires visual review. Public derivatives are not original signed attestations."}
    put("transformation-receipt.json", (json.dumps(receipt, indent=2) + "\n").encode(), sanitize=False)
    # A final scan covers actual staged payload bytes, including inner trace ZIP members.
    findings = []
    inventory = {}
    for file in sorted(STAGE.rglob("*")):
        if not file.is_file():
            continue
        name = file.relative_to(STAGE).as_posix()
        safe_name(name)
        raw = file.read_bytes()
        findings.extend(scan(raw, name))
        inventory[name] = {"bytes": len(raw), "sha256": sha(raw), **({"source": origins[name]["source"], "sourceSha256": origins[name]["originalSha256"], "byteIdenticalToSource": origins[name]["byteIdentical"]} if name in origins else {})}
    if findings:
        (OUT / "scan-findings.json").write_text(json.dumps({"status": "failed", "findings": findings}, indent=2) + "\n")
        raise ValueError("Bounded package scan found redacted finding locations; inspect dist-submission/scan-findings.json")
    if len(inventory) > MAX_MEMBERS or sum(v["bytes"] for v in inventory.values()) > MAX_TOTAL:
        raise ValueError("Package aggregate/member ceiling exceeded")
    generated_at = datetime.now(timezone.utc).isoformat()  # noqa: UP017 -- packager also supports system Python 3.9
    manifest = {"schemaVersion": 1, "package": "BugArcade local review", "generatedAt": generated_at,
                "notPublishedOrSubmitted": True, "demoIncluded": bool(args.demo), "demo": demo, "allowlist": {"sourceRoots": {k: sorted(v) for k, v in SOURCE_ROOTS.items()},
                    "sourceFiles": list(SOURCE_FILES), "embeddedRuntimeLicenseTexts": list(RUNTIME_LICENSES), "evidence": "Five named authored seeds; separate known-note and pipeline-held-out first-party coupon live proposals, six runs each, standalone players, exact tests/TAP; optional exact demo/transcript/chapter-caption paths"},
                "files": inventory, "excludesManifestAndAudit": True}
    (STAGE / "package-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    audit = {"status": "passed", "payloadFiles": len(inventory), "expandedPayloadBytes": sum(v["bytes"] for v in inventory.values()),
             "knownPatternFindings": [], "intentionalSyntheticFixtureExclusions": fixture_exclusions,
             "nestedZipScan": "all included nested members scanned with 160-member/24MiB ceilings",
             "pathTypeSizeChecks": "passed", "extractionAndHashCheck": "passed", "limits": {"members": MAX_MEMBERS, "regularMemberBytes": MAX_FILE, "aggregateBytes": MAX_TOTAL},
             "scanLimitations": "Known patterns only, not Git history or unknown secret formats. Exact documented synthetic proxy literals in two named tests are excluded; any other wk/ws-shaped token fails. Images/media are not OCR-scanned. Visual app-only evidence allowlist excludes account screenshots.",
             "sourceDerivatives": len(transforms), "demoIncluded": bool(args.demo), "runtimeVerificationIncluded": runtime is not None, "newProviderCalls": 0}
    (STAGE / "package-audit.json").write_text(json.dumps(audit, indent=2) + "\n")
    members = {file.relative_to(STAGE).as_posix(): file.read_bytes() for file in STAGE.rglob("*") if file.is_file()}
    archive_path = OUT / "bugarcade-review.zip"
    archive_path.write_bytes(zip_bytes(members))
    # Independently read the produced ZIP and safely extract exact regular members, then rehash.
    with tempfile.TemporaryDirectory(prefix="bugarcade-package-review-") as temporary:
        target = Path(temporary)
        with zipfile.ZipFile(archive_path) as archive:
            if len(archive.infolist()) != len(members) or len(archive.namelist()) != len(set(archive.namelist())):
                raise ValueError("Archive member inventory mismatch")
            if archive.testzip() is not None:
                raise ValueError("Archive CRC check failed")
            for info in archive.infolist():
                safe_name(info.filename)
                if not stat.S_ISREG(info.external_attr >> 16) or info.flag_bits & 1:
                    raise ValueError("Archive contains nonregular/encrypted member")
                raw = archive.read(info)
                if raw != members[info.filename] or scan(raw, info.filename):
                    raise ValueError("Actual archived bytes differ or fail final scan")
                file = target / info.filename
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_bytes(raw)
            for name, record in inventory.items():
                raw = (target / name).read_bytes()
                if len(raw) != record["bytes"] or sha(raw) != record["sha256"]:
                    raise ValueError("Extracted manifest hash mismatch")
    result = {"status": "passed", "archive": archive_path.relative_to(ROOT).as_posix(), "archiveBytes": archive_path.stat().st_size,
              "archiveSha256": sha(archive_path.read_bytes()), "archiveMembers": len(members), "manifestSha256": sha((STAGE / "package-manifest.json").read_bytes()),
              "audit": audit, "privateOriginalsModified": False, "published": False, "submitted": False}
    (OUT / "build-receipt.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: result[k] for k in ("status", "archive", "archiveBytes", "archiveSha256", "archiveMembers", "published", "submitted")}))


if __name__ == "__main__":
    main()
