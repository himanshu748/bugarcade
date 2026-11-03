"""Bounded orchestration. Every positive result comes from completed browser assertions."""
import asyncio
import hashlib
import json
import time
from pathlib import Path

from backend.adapter import seed_manifest
from backend.config import Settings
from backend.packaging import package_challenge, render_regression
from backend.planner import Planner, PlannerError
from backend.runner import LocalRunner, ModalRunner, RunnerError
from backend.schemas import Manifest, digest, invariant_hash
from backend.store import TERMINAL, Store


class Jobs:
    def __init__(self, settings: Settings, store: Store, *, local_runner=None, modal_runner=None, planner=None):
        self.settings = settings
        self.store = store
        self.local = local_runner or LocalRunner(settings)
        self.modal = modal_runner or ModalRunner(settings)
        self.planner = planner or Planner(settings)
        self.tasks: dict[str, asyncio.Task] = {}
        self.semaphore = asyncio.Semaphore(1)

    def start(self, job: dict) -> None:
        task = asyncio.create_task(self._drive(job["id"]))
        self.tasks[job["id"]] = task
        task.add_done_callback(lambda _: self.tasks.pop(job["id"], None))

    async def close(self) -> None:
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def cancel(self, job_id: str) -> dict | None:
        job = self.store.get(job_id)
        if not job or job["state"] in TERMINAL:
            return job
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        return self.store.transition(job_id, "cancelled", "Cancelled; active worker cleanup was awaited.")

    def _source(self, job: dict) -> tuple[Manifest, Path | None, str, list[dict], str, dict]:
        if job["projectId"]:
            project = self.store.project(job["projectId"])
            if not project:
                raise RunnerError("Uploaded project is unavailable.")
            path = Path(project["path"])
            manifest = Manifest.model_validate_json((path / "manifest.json").read_text())
            source = (path / "buggy/App.tsx").read_text()
            return manifest, path, source, project["recording"]["frames"], project["hints"], project["hashes"]
        rows = json.loads((self.settings.root / "shared/challenges.json").read_text())
        raw = next((row for row in rows if row["id"] == job["challengeId"]), None)
        if not raw:
            raise RunnerError("Unknown seed challenge.")
        manifest = seed_manifest(raw)
        hashes = {}
        source = ""
        for variant in ("buggy", "fixed"):
            path = self.settings.root / "fixtures" / manifest.id / variant / "App.tsx"
            if not path.exists():
                path = self.settings.root / "fixtures" / manifest.id / f"{variant}.tsx"
            content = path.read_text()
            hashes[variant] = hashlib.sha256(content.encode()).hexdigest()
            if variant == "buggy":
                source = content
        frames = []
        recording_meta = self.settings.root / "evidence/seeds" / manifest.id / "recording.json"
        if recording_meta.exists():
            for frame in json.loads(recording_meta.read_text()).get("frames", [])[:4]:
                path = (recording_meta.parent / frame["path"]).resolve()
                if path.is_relative_to(recording_meta.parent.resolve()) and path.is_file():
                    frames.append({**frame, "path": str(path)})
        return manifest, None, source, frames, "", hashes

    async def _drive(self, job_id: str) -> None:
        try:
            async with self.semaphore:
                if self.store.get(job_id)["state"] in TERMINAL:
                    return
                async with asyncio.timeout(self.settings.job_timeout_seconds):
                    await self._execute(job_id)
        except asyncio.CancelledError:
            self.store.transition(job_id, "cancelled", "Cancelled; worker termination was requested and awaited.", result=self._failure_result(job_id))
            raise
        except TimeoutError:
            self.store.transition(job_id, "failed", "Job deadline reached; no verification claim was made.",
                                  error="The bounded job deadline expired. Reduce the action plan and retry.", retryable=True, result=self._failure_result(job_id))
        except (RunnerError, PlannerError, ValueError, OSError) as exc:
            # Known error messages are controlled; unknown OS details could include paths, never return provider payloads.
            message = str(exc) if isinstance(exc, (RunnerError, PlannerError)) else "Input, artifact or worker validation failed. Check the starter and local setup."
            self.store.transition(job_id, "failed", "Run stopped with a recoverable error.", error=message[:600], retryable=True, result=self._failure_result(job_id))
        except Exception:
            self.store.transition(job_id, "failed", "Unexpected orchestration error; no success claim was made.",
                                  error="The backend could not complete this run. Check local diagnostics and retry.", retryable=True, result=self._failure_result(job_id))

    def _failure_result(self, job_id: str) -> dict | None:
        path = self.settings.root / "evidence/jobs" / job_id / "provenance.json"
        if not path.is_file():
            return None
        proposals = json.loads(path.read_text())
        attempted = [p for p in proposals if p.get("providerCallAttempted")]
        if not attempted:
            return None
        known_costs = all(p.get("estimatedModelCostUsd") is not None for p in attempted)
        return {"verified": False, "modelCalls": len(attempted), "provenance": proposals,
                "modelUsage": [p.get("usage") for p in attempted],
                "estimatedModelCostUsd": sum(p["estimatedModelCostUsd"] for p in attempted) if known_costs else None,
                "artifacts": {"provenance": f"/api/job-artifacts/{job_id}/provenance.json"},
                "limits": "A dispatched model request may incur cost even when it times out or is cancelled. Unknown usage/cost is not zero."}

    async def _execute(self, job_id: str) -> None:
        job = self.store.get(job_id)
        started = time.monotonic()
        if job["mode"] == "live" and self.settings.live_reasons:
            raise RunnerError("Live execution lacks explicit configured authorization. No provider call was made.")
        self.store.transition(job_id, "preparing", "Loading source, frozen invariant and the controlled request schedule.")
        manifest, project_dir, source, frames, hints, hashes = self._source(job)
        frozen = invariant_hash(manifest)
        runner = self.modal if job["mode"] == "live" else self.local
        artifact_root = self.settings.root / "evidence/jobs" / job_id
        artifact_root.mkdir(parents=True, exist_ok=False)
        runs = []
        proposals = []
        actions: list[dict] = []
        probe_count = 0

        async def run(variant: str, sequence: list[dict], phase: str) -> dict:
            if invariant_hash(manifest) != frozen:
                raise RunnerError("Invariant identity changed; execution refused.")
            directory = artifact_root / f"{len(runs):02}-{phase}-{variant}"
            result = await runner.run(manifest.id, variant, sequence, directory, project_dir, assertion_hash=frozen)
            if result["status"] != "error":
                returned = result.get("assertion", {})
                rule = manifest.assertion
                if (any(returned.get(key) != value for key, value in rule.model_dump().items())
                        or returned.get("hash") != frozen or returned.get("completion") != manifest.completion.model_dump()):
                    raise RunnerError("Worker invariant differs from the trusted frozen assertion/checkpoint. Result rejected.")
                actual = returned.get("actual")
                if rule.operator == "count":
                    valid_actual = type(actual) is int and actual >= 0
                else:
                    valid_actual = isinstance(actual, str)
                if not valid_actual:
                    raise RunnerError("Worker returned an invalid observed value. Result rejected.")
                passed = rule.expected in actual if rule.operator == "contains" else rule.expected == actual
                if returned.get("pass") is not passed or result["status"] != ("passed" if passed else "failed"):
                    raise RunnerError("Worker verdict contradicts its deterministic observation. Result rejected.")
            record = {"variant": variant, "phase": phase, "actions": sequence, "proposalId": proposals[-1]["proposalId"],
                      "invariantHash": frozen, "artifactDirectory": str(directory.relative_to(self.settings.root / "evidence")),
                      "result": result}
            runs.append(record)
            executed = [event["action"] for event in result.get("actions", [])
                        if isinstance(event, dict) and "action" in event and event.get("status") == "executed"]
            if phase == "initial" and variant == "buggy":
                proposals[-1]["executedActions"] = executed
            proposals[-1].setdefault("executions", []).append({"variant": variant, "phase": phase,
                "actions": executed, "status": result["status"], "artifactDirectory": record["artifactDirectory"]})
            (artifact_root / "provenance.json").write_text(json.dumps(proposals, indent=2))
            (artifact_root / "runs.json").write_text(json.dumps(runs, indent=2))
            if result["status"] == "error":
                raise RunnerError("Browser actions or infrastructure failed. This run is not a reproduced bug.")
            return result

        previous = None
        reproduced = False
        attempts = self.settings.max_model_calls if job["mode"] == "live" else 1
        for attempt in range(attempts):
            self.store.transition(job_id, "investigating", "Muse proposes a bounded action plan from source and sampled frames." if job["mode"] == "live" else "Using an authored seed plan; no model call is made in recorded-demo mode.")
            if job["mode"] == "live":
                def record_attempt(event, number=attempt + 1):
                    event["attemptNumber"] = number
                    if proposals and proposals[-1].get("attemptNumber") == number:
                        proposals[-1] = event
                    else:
                        proposals.append(event)
                    (artifact_root / "provenance.json").write_text(json.dumps(proposals, indent=2))
                actions, provenance = await self.planner.propose(manifest, source, frames, hints, previous, on_event=record_attempt)
            else:
                actions = [action.model_dump() for action in manifest.initialActions or manifest.actions]
                provenance = {"origin": "authored-seed-plan", "model": None, "modelCalls": 0, "usage": None,
                              "estimatedModelCostUsd": 0, "proposalId": digest(actions), "proposedActions": actions, "executedActions": [],
                              "invariantHash": frozen}
                proposals.append(provenance)
            (artifact_root / "provenance.json").write_text(json.dumps(proposals, indent=2))
            self.store.transition(job_id, "reproducing", f"Executing proposal {attempt + 1} in a fresh browser context.")
            buggy = await run("buggy", actions, "initial")
            fixed = await run("fixed", actions, "initial")
            reproduced = buggy["status"] == "failed" and fixed["status"] == "passed"
            if reproduced:
                break
            previous = {"buggy": {"status": buggy["status"], "assertion": buggy["assertion"]},
                        "fixed": {"status": fixed["status"], "assertion": fixed["assertion"]}}
        initial = list(actions)
        if not reproduced:
            result = self._summary(job, manifest, hashes, frozen, proposals, runs, initial, actions, started, 0, False)
            (artifact_root / "summary.json").write_text(json.dumps(result, indent=2))
            self.store.transition(job_id, "not-reproduced", "No valid failing-buggy/passing-fixed pair was observed within the attempt budget.", result=result)
            return
        self.store.transition(job_id, "minimizing", "Testing deletions on both versions while preserving the frozen invariant and completion checkpoint.")
        index = 0
        while len(actions) > 1 and index < len(actions) and probe_count < self.settings.max_minimize_probes:
            candidate = actions[:index] + actions[index + 1:]
            probe_count += 1
            try:
                buggy = await run("buggy", candidate, "minimize")
                if buggy["status"] == "failed":
                    fixed = await run("fixed", candidate, "minimize")
                    if fixed["status"] == "passed":
                        actions = candidate
                        index = 0
                        continue
            except RunnerError:
                # Invalid deletions are recorded as errors, not accepted as a reproduction.
                pass
            index += 1
        self.store.transition(job_id, "validating", "Running three consecutive buggy/fixed pairs under the identical schedule.")
        verified = True
        for _ in range(3):
            buggy = await run("buggy", actions, "validation")
            fixed = await run("fixed", actions, "validation")
            verified = verified and buggy["status"] == "failed" and fixed["status"] == "passed"
        result = self._summary(job, manifest, hashes, frozen, proposals, runs, initial, actions, started, probe_count, verified)
        regression = render_regression(manifest, hashes, frozen, actions, project_dir)
        (artifact_root / "regression.test.mjs").write_text(regression)
        if verified:
            result["artifacts"].update(package_challenge(self.settings.root, artifact_root, manifest, result, project_dir))
        (artifact_root / "summary.json").write_text(json.dumps(result, indent=2))
        self.store.transition(job_id, "completed" if verified else "not-reproduced",
                              "Three buggy failures and three fixed passes verified under this schedule." if verified else "Final repeated verification did not meet the three-pair gate.", result=result)

    def _summary(self, job, manifest, hashes, frozen, proposals, runs, initial, actions, started, probes, verified):
        validation = [row for row in runs if row["phase"] == "validation"]
        usage = [row.get("usage") for row in proposals if row.get("usage")]
        return {"verified": verified, "mode": job["mode"], "runner": "modal-sandbox" if job["mode"] == "live" else "local-trusted-seeds",
                "challengeId": manifest.id, "cohort": "submitted-example" if job["projectId"] else "known-seed",
                "sourceHashes": hashes, "invariantHash": frozen, "assertion": manifest.assertion.model_dump(),
                "completion": manifest.completion.model_dump(), "seed": manifest.seed,
                "schedule": [entry.model_dump() for entry in manifest.schedule],
                "initialActions": initial, "actions": actions, "initialActionCount": len(initial), "minimizedActionCount": len(actions),
                "minimizationProbes": probes, "minimality": "bounded deletion search; not a global optimum",
                "buggyFailures": sum(r["variant"] == "buggy" and r["result"]["status"] == "failed" for r in validation),
                "fixedPasses": sum(r["variant"] == "fixed" and r["result"]["status"] == "passed" for r in validation),
                "validationRuns": len(validation), "browserRuns": len(runs),
                "infrastructureErrors": sum(r["result"]["status"] == "error" for r in runs),
                "elapsedMs": round((time.monotonic() - started) * 1000), "modelCalls": len(proposals) if job["mode"] == "live" else 0,
                "modelUsage": usage or None, "model": self.settings.model if job["mode"] == "live" else None,
                "modelProvider": self.settings.model_provider if job["mode"] == "live" else None,
                "estimatedModelCostUsd": sum(p.get("estimatedModelCostUsd") or 0 for p in proposals) if all(p.get("estimatedModelCostUsd") is not None for p in proposals) else None,
                "provenance": proposals, "runs": runs,
                "artifacts": {"summary": f"/api/job-artifacts/{job['id']}/summary.json", "regression": f"/api/job-artifacts/{job['id']}/regression.test.mjs",
                              "provenance": f"/api/job-artifacts/{job['id']}/provenance.json"},
                "limits": "Repeatability under one controlled schedule is not broad reliability or held-out generalization evidence."}
