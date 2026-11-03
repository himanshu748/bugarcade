"""Backend contract/fault tests. Provider transports and cloud sandboxes here are synthetic doubles."""
import asyncio
import io
import json
import stat
import zipfile
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.adapter import InvalidProject, validate_archive
from backend.config import Settings
from backend.jobs import Jobs
from backend.main import BodyLimit, create_app
from backend.planner import Planner, PlannerError
from backend.runner import LocalRunner, ModalRunner, RunnerError, decode_result
from backend.schemas import JobRequest, Manifest, Proposal, invariant_hash
from backend.store import Capacity, Conflict, Store


@pytest.fixture
def manifest():
    return Manifest.model_validate({"id": "lost-note", "title": "Synthetic test contract", "goal": "Keep the new note",
        "allowedTargets": ["sync", "note", "result", "done"],
        "assertion": {"target": "result", "operator": "contains", "expected": "new note"},
        "completion": {"target": "done", "value": "done"},
        "schedule": [{"id": "sync-1", "key": "sync", "response": {"ok": True}, "status": 200}],
        "actions": [{"type": "click", "target": "sync"}, {"type": "click", "target": "note"}, {"type": "release", "request": "sync-1"}],
        "initialActions": [{"type": "fill", "target": "note", "value": "redundant"}, {"type": "click", "target": "sync"},
                           {"type": "click", "target": "note"}, {"type": "release", "request": "sync-1"}]})


@pytest.fixture
def settings(tmp_path, manifest):
    (tmp_path / "shared").mkdir()
    (tmp_path / "shared/challenges.json").write_text(json.dumps([manifest.model_dump()]))
    for variant in ("buggy", "fixed"):
        path = tmp_path / "fixtures/lost-note" / variant
        path.mkdir(parents=True)
        (path / "App.tsx").write_text("import React from 'react'; export default function App(){return <p>Fixture</p>}")
    return Settings(root=tmp_path, data_dir=tmp_path / "data", live_enabled=False, budget_approved=False,
                    api_key="", modal_credentials_present=False, max_minimize_probes=8)


def make_zip(manifest, extra=None, source=None):
    files = {"manifest.json": manifest.model_dump_json(),
             "buggy/App.tsx": source or "import {useState} from 'react'; export default function App(){return null}",
             "fixed/App.tsx": "export default function App(){return null}"}
    files.update(extra or {})
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, content in files.items():
            archive.writestr(name, content)
    return output.getvalue()


def test_valid_starter_preserves_source_hashes(manifest):
    parsed, files, hashes = validate_archive(make_zip(manifest))
    assert parsed == manifest
    assert set(hashes) == set(files)
    assert hashes["buggy/App.tsx"] != hashes["fixed/App.tsx"]


@pytest.mark.parametrize("name", ["../escape.tsx", "/absolute.tsx", "buggy\\App.tsx", "package.json", "node_modules/x.js"])
def test_unsafe_or_unsupported_archive_members(manifest, name):
    with pytest.raises(InvalidProject):
        validate_archive(make_zip(manifest, {name: "payload"}))


def test_symlink_and_duplicate_members_rejected(manifest):
    raw = io.BytesIO(make_zip(manifest))
    with zipfile.ZipFile(raw, "a") as archive:
        member = zipfile.ZipInfo("README.md")
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(member, "/etc/passwd")
    with pytest.raises(InvalidProject, match="symbolic"):
        validate_archive(raw.getvalue())


def test_compression_bomb_and_bad_zip_rejected(manifest):
    with pytest.raises(InvalidProject):
        validate_archive(make_zip(manifest, {"README.md": "a" * 200_000}))
    with pytest.raises(InvalidProject):
        validate_archive(b"not a zip")


@pytest.mark.parametrize("source", ["import x from 'child_process'; export default x", "export default import('https://example.com')", "export default require('fs')"])
def test_unsupported_imports_rejected(manifest, source):
    with pytest.raises(InvalidProject):
        validate_archive(make_zip(manifest, source=source))


def test_action_schema_forbids_code_navigation_and_extra_fields(manifest):
    for action in ({"type": "evaluate", "code": "fetch('x')"}, {"type": "click", "target": "sync", "script": "x"}):
        with pytest.raises(ValidationError):
            Proposal.model_validate({"actions": [action], "candidateAssertion": manifest.assertion.model_dump(), "rationale": "x"})


def test_job_source_and_idempotency_schema():
    with pytest.raises(ValidationError):
        JobRequest(challengeId="lost-note", projectId="p", idempotencyKey="unique-id")
    with pytest.raises(ValidationError):
        JobRequest(projectId="p", mode="recorded", idempotencyKey="unique-id")


def test_store_idempotency_conflicts_capacity_and_restart(settings):
    store = Store(settings.data_dir / "test.sqlite")
    request = JobRequest(challengeId="lost-note", idempotencyKey="same-request")
    first, created = store.create(request, max_queue=1)
    repeat, created_again = store.create(request, max_queue=1)
    assert created and not created_again and first == repeat
    with pytest.raises(Conflict):
        store.create(JobRequest(challengeId="search", idempotencyKey="same-request"), max_queue=1)
    with pytest.raises(Capacity):
        store.create(JobRequest(challengeId="lost-note", idempotencyKey="second-request"), max_queue=1)
    store.transition(first["id"], "preparing", "start")
    assert Store(store.path).recover() == 1
    assert store.get(first["id"])["state"] == "failed"
    assert store.get(first["id"])["retryable"]


def test_budget_reservation_persists_and_no_duplicate_charge(settings):
    store = Store(settings.data_dir / "test.sqlite")
    request = JobRequest(challengeId="lost-note", mode="live", idempotencyKey="live-request")
    first, _ = store.create(request, max_queue=2, reservation=0.8, budget=1, max_live_jobs=2)
    repeat, created = store.create(request, max_queue=2, reservation=0.8, budget=1, max_live_jobs=2)
    assert first == repeat and not created
    with pytest.raises(Capacity, match="ceiling"):
        store.create(JobRequest(challengeId="lost-note", mode="live", idempotencyKey="live-another"), max_queue=2, reservation=0.8, budget=1, max_live_jobs=2)


class DeterministicRunner:
    """Synthetic oracle for orchestration semantics, not evidence for any actual seed."""
    def __init__(self, outcome=None):
        self.outcome = outcome
        self.calls = []

    async def run(self, challenge_id, variant, actions, artifact_dir, project_dir=None, *, assertion_hash=None):
        self.calls.append((variant, actions))
        artifact_dir.mkdir(parents=True, exist_ok=True)
        (artifact_dir / "player.html").write_text("<!doctype html><p>Synthetic unit-test player, not a captured app</p>")
        (artifact_dir / "trace.zip").write_bytes(b"Synthetic unit-test trace placeholder")
        (artifact_dir / "recording.webm").write_bytes(b"Synthetic unit-test recording placeholder")
        if self.outcome == "startup":
            raise RunnerError("Synthetic failed sandbox startup")
        if self.outcome == "error":
            return {"status": "error", "error": "Synthetic timeout"}
        needed = [{"type": "click", "target": "sync"}, {"type": "click", "target": "note"}, {"type": "release", "request": "sync-1"}]
        if not all(action in actions for action in needed):
            return {"status": "error", "error": "Completion checkpoint missing"}
        passed = variant == "fixed" or self.outcome == "pass"
        return {"status": "passed" if passed else "failed", "assertion": {"pass": passed, "actual": "new note" if passed else "old",
                "target": "result", "operator": "contains", "expected": "new note", "hash": assertion_hash,
                "completion": {"target": "done", "value": "done"}},
                "browserVersion": "synthetic-test", "elapsedMs": 1, "artifacts": {}}


async def run_job(settings, runner, *, mode="recorded", planner=None):
    store = Store(settings.data_dir / "test.sqlite")
    job, _ = store.create(JobRequest(challengeId="lost-note", mode=mode, idempotencyKey="test-request"),
                          max_queue=2, reservation=0.1 if mode == "live" else 0, budget=1)
    jobs = Jobs(settings, store, local_runner=runner, modal_runner=runner, planner=planner)
    await jobs._drive(job["id"])
    return store.get(job["id"])


def test_pipeline_minimizes_only_valid_pairs_and_verifies_three(settings, manifest):
    runner = DeterministicRunner()
    job = asyncio.run(run_job(settings, runner))
    assert job["state"] == "completed"
    result = job["result"]
    assert result["buggyFailures"] == result["fixedPasses"] == 3
    assert result["initialActionCount"] == 4 and result["minimizedActionCount"] == 3
    assert result["invariantHash"] == invariant_hash(manifest)
    assert result["modelCalls"] == 0 and result["provenance"][0]["origin"] == "authored-seed-plan"
    assert [e["state"] for e in job["events"]] == ["queued", "preparing", "investigating", "reproducing", "minimizing", "validating", "completed"]


def test_not_reproduced_when_invariant_does_not_fail(settings):
    job = asyncio.run(run_job(settings, DeterministicRunner("pass")))
    assert job["state"] == "not-reproduced" and not job["result"]["verified"]


@pytest.mark.parametrize("outcome", ["error", "startup"])
def test_timeout_and_startup_never_count_as_reproduction(settings, outcome):
    job = asyncio.run(run_job(settings, DeterministicRunner(outcome)))
    assert job["state"] == "failed"
    assert job["result"] is None


def test_cancel_running_job_awaits_cleanup(settings):
    async def exercise():
        entered, cleaned = asyncio.Event(), asyncio.Event()
        class Blocking:
            async def run(self, *args, **kwargs):
                entered.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cleaned.set()
        store = Store(settings.data_dir / "cancel.sqlite")
        job, _ = store.create(JobRequest(challengeId="lost-note", idempotencyKey="cancel-request"), max_queue=2)
        jobs = Jobs(settings, store, local_runner=Blocking())
        jobs.start(job)
        await asyncio.wait_for(entered.wait(), 1)
        result = await jobs.cancel(job["id"])
        assert result["state"] == "cancelled" and cleaned.is_set()
        assert (await jobs.cancel(job["id"]))["state"] == "cancelled"
    asyncio.run(exercise())


def response_for(manifest, actions=None, assertion=None):
    return {"choices": [{"message": {"content": json.dumps({"actions": actions or [a.model_dump() for a in manifest.actions],
            "candidateAssertion": assertion or manifest.assertion.model_dump(), "rationale": "Inspect delayed sync"})}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 60}}


def live_settings(settings, **overrides):
    values = dict(live_enabled=True, budget_approved=True, approved_budget_usd=1, api_key="synthetic-test-key",
                  modal_credentials_present=True, modal_image_id="im-synthetic", input_usd_per_million=1,
                  output_usd_per_million=2, sandbox_usd_per_hour=1)
    values.update(overrides)
    return replace(settings, **values)


def test_live_model_proposal_drives_execution(settings, manifest):
    captured = []
    def handler(request):
        captured.append(json.loads(request.content))
        return httpx.Response(200, json=response_for(manifest))
    configured = live_settings(settings)
    planner = Planner(configured, httpx.MockTransport(handler))
    runner = DeterministicRunner()
    job = asyncio.run(run_job(configured, runner, mode="live", planner=planner))
    assert job["state"] == "completed"
    assert job["result"]["modelCalls"] == 1
    assert runner.calls[0][1] == [a.model_dump() for a in manifest.actions]
    assert "response_format" not in captured[0]
    prompt_manifest = json.loads(captured[0]["messages"][1]["content"][0]["text"])["manifest"]
    assert "actions" not in prompt_manifest and "initialActions" not in prompt_manifest
    assert job["result"]["provenance"][0]["proposalId"]
    assert "synthetic-test-key" not in json.dumps(job)


@pytest.mark.parametrize("kind", ["timeout", "invalid-action", "weakened", "unknown-target", "malformed", "credential", "excess-tokens"])
def test_model_faults_fail_closed(settings, manifest, kind):
    def handler(_request):
        if kind == "timeout":
            raise httpx.ReadTimeout("Synthetic provider timeout")
        if kind == "malformed":
            return httpx.Response(200, json={"choices": []})
        if kind == "excess-tokens":
            return httpx.Response(200, json={**response_for(manifest), "usage": {"prompt_tokens": 100000, "completion_tokens": 100}})
        actions = [{"type": "evaluate", "script": "x"}] if kind == "invalid-action" else None
        if kind == "unknown-target":
            actions = [{"type": "click", "target": "undeclared"}]
        assertion = {**manifest.assertion.model_dump(), "expected": ""} if kind == "weakened" else None
        return httpx.Response(200, json=response_for(manifest, actions, assertion))
    planner = Planner(live_settings(settings, api_key="" if kind == "credential" else "synthetic-test-key"), httpx.MockTransport(handler))
    with pytest.raises(PlannerError):
        asyncio.run(planner.propose(manifest, "export default App", [], ""))


def test_local_runner_rejects_uploaded_code(settings):
    with pytest.raises(RunnerError, match="requires Modal"):
        asyncio.run(LocalRunner(settings).run("lost-note", "buggy", [], settings.data_dir, settings.data_dir / "uploaded"))


def test_worker_result_errors_not_guessed():
    for raw in ("{}", "[]", "{\"status\":\"success\"}", "not json"):
        with pytest.raises(RunnerError):
            decode_result(raw)


class AsyncMethod:
    def __init__(self, fn):
        self.aio = fn


@pytest.mark.parametrize("cancel", [False, True])
def test_modal_terminated_on_failed_readiness_and_cancellation(settings, cancel):
    async def exercise():
        entered, terminated = asyncio.Event(), asyncio.Event()
        async def lookup(*args, **kwargs):
            return object()
        async def terminate(**kwargs):
            terminated.set()
        async def exec_(*args, **kwargs):
            entered.set()
            if cancel:
                await asyncio.Event().wait()
            raise RunnerError("Synthetic readiness failure")
        sandbox = SimpleNamespace(exec=AsyncMethod(exec_), terminate=AsyncMethod(terminate))
        create_options = {}
        async def create(*args, **kwargs):
            create_options.update(kwargs)
            return sandbox
        fake = SimpleNamespace(App=SimpleNamespace(lookup=AsyncMethod(lookup)), Image=SimpleNamespace(from_id=lambda _: object()),
                               Sandbox=SimpleNamespace(create=AsyncMethod(create)))
        configured = replace(settings, live_enabled=True, budget_approved=True, approved_budget_usd=1, api_key="synthetic",
                    modal_credentials_present=True, modal_image_id="im-synthetic", input_usd_per_million=1,
                    output_usd_per_million=1, sandbox_usd_per_hour=1)
        task = asyncio.create_task(ModalRunner(configured, fake).run("lost-note", "buggy", [], settings.data_dir / "artifacts"))
        await entered.wait()
        if cancel:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(RunnerError):
                await task
        assert terminated.is_set()
        assert create_options["block_network"] is True
        assert create_options["secrets"] == [] and create_options["volumes"] == {}
        assert create_options["cpu"] == (1.0, 2.0) and create_options["memory"] == (2048, 2048)
        assert create_options["runtime"] == "vm" and create_options["env"]["BUGARCADE_CGROUP_GUARD"] == "1"
        assert create_options["include_oidc_identity_token"] is False
    asyncio.run(exercise())


def test_http_health_live_unavailable_and_untrusted_origin(settings):
    with TestClient(create_app(settings, runner=DeterministicRunner())) as client:
        health = client.get("/api/health").json()
        assert not health["liveEnabled"] and health["liveDisabledReasons"]
        response = client.post("/api/jobs", json={"challengeId": "lost-note", "mode": "live", "idempotencyKey": "http-live-request"})
        assert response.status_code == 503
        assert client.post("/api/jobs", headers={"Origin": "https://evil.example"}, json={}).status_code == 403
        assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 400


def test_http_bad_upload_missing_authorization_and_artifact_escape(settings, manifest):
    with TestClient(create_app(settings)) as client:
        files = {"project": ("test.zip", make_zip(manifest), "application/zip"), "recording": ("demo.webm", b"fake", "video/webm")}
        assert client.post("/api/projects", files=files).status_code == 422
        assert client.post("/api/projects", files=files, data={"authorized": "true"}).status_code == 422
        files["project"] = ("bad.zip", b"broken", "application/zip")
        assert client.post("/api/projects", files=files, data={"authorized": "true"}).status_code == 422
        assert client.get("/api/artifacts/lost-note/%2e%2e/%2e%2e/.env").status_code == 404
        assert client.get("/api/starter").status_code == 200


@pytest.mark.parametrize("invalid", [float("nan"), float("inf"), -1.0, 0.0])
def test_nonfinite_budgets_and_rates_fail_closed(settings, invalid):
    assert live_settings(settings, approved_budget_usd=invalid).live_reasons
    assert live_settings(settings, input_usd_per_million=invalid).live_reasons
    store = Store(settings.data_dir / "invalid-budget.sqlite")
    with pytest.raises(Capacity):
        store.create(JobRequest(challengeId="lost-note", mode="live", idempotencyKey="invalid-budget"),
                     max_queue=1, reservation=invalid, budget=10)


def test_intake_limit_precedes_parser_and_rejects_concurrent_intake():
    async def exercise():
        entered, release = asyncio.Event(), asyncio.Event()
        calls = []
        async def target(scope, receive, send):
            calls.append(scope)
            entered.set()
            await release.wait()
            await receive()
        middleware = BodyLimit(target, maximum=10)
        first_messages, second_messages = [], []
        async def body():
            return {"type": "http.request", "body": b"a" * 11, "more_body": False}
        async def first_send(message):
            first_messages.append(message)
        async def second_send(message):
            second_messages.append(message)
        scope = {"type": "http", "method": "POST", "path": "/api/projects"}
        task = asyncio.create_task(middleware(scope, body, first_send))
        await entered.wait()
        await middleware(scope, body, second_send)
        assert second_messages[0]["status"] == 429 and len(calls) == 1
        release.set()
        await task
        assert first_messages[0]["status"] == 413
        assert middleware.active_uploads == 0
    asyncio.run(exercise())


def test_multipart_total_size_bound(settings, manifest):
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/projects", data={"authorized": "true"}, files={
            "project": ("test.zip", make_zip(manifest), "application/zip"),
            "recording": ("test.webm", b"x" * (22 * 1024 * 1024), "video/webm")})
        assert response.status_code == 413


def test_changed_worker_invariant_is_rejected(settings):
    class Drifted(DeterministicRunner):
        async def run(self, *args, **kwargs):
            result = await super().run(*args, **kwargs)
            if result["status"] != "error":
                result["assertion"]["expected"] = ""
            return result
    job = asyncio.run(run_job(settings, Drifted()))
    assert job["state"] == "failed" and "invariant differs" in job["error"]


def test_packaged_challenge_contains_exact_sources_and_replay(settings):
    job = asyncio.run(run_job(settings, DeterministicRunner()))
    directory = settings.root / "evidence/jobs" / job["id"]
    challenge = json.loads((directory / "challenge.json").read_text())
    replay = json.loads((directory / "replay.json").read_text())
    assert challenge["invariantHash"] == replay["invariantHash"] == job["result"]["invariantHash"]
    assert replay["actions"] == job["result"]["actions"]
    with zipfile.ZipFile(directory / "source.zip") as archive:
        assert archive.read("buggy/App.tsx").decode() == (settings.root / "fixtures/lost-note/buggy/App.tsx").read_text()
    assert {"challenge", "replay", "source"}.issubset(job["result"]["artifacts"])
    assert (directory / "player-buggy.html").is_file() and (directory / "fixed-trace.zip").is_file()
    assert challenge["player"]["kind"] == "offline-browser-cartridge"
    assert challenge["player"]["buggyUrl"].endswith("player-buggy.html")


def test_cancel_during_modal_creation_still_terminates_new_sandbox(settings):
    async def exercise():
        creation_started, finish_creation, terminated = asyncio.Event(), asyncio.Event(), asyncio.Event()
        async def create():
            creation_started.set()
            await finish_creation.wait()
            async def terminate(**kwargs):
                terminated.set()
            return SimpleNamespace(terminate=AsyncMethod(terminate))
        runner = ModalRunner(settings)
        task = asyncio.create_task(runner._create(create))
        await creation_started.wait()
        task.cancel()
        finish_creation.set()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert terminated.is_set()
    asyncio.run(exercise())


@pytest.mark.parametrize("kind", ["timeout", "invalid", "http-error"])
def test_failed_model_attempts_persist_sanitized_provenance(settings, manifest, kind):
    def handler(_request):
        if kind == "timeout":
            raise httpx.ReadTimeout("Untrusted raw timeout includes secret-like text DO_NOT_STORE")
        if kind == "http-error":
            return httpx.Response(429, text="DO_NOT_STORE raw provider body")
        return httpx.Response(200, json={**response_for(manifest), "choices": [{"message": {"content": "DO_NOT_STORE invalid JSON"}}]})
    configured = live_settings(settings)
    planner = Planner(configured, httpx.MockTransport(handler))
    runner = DeterministicRunner()
    job = asyncio.run(run_job(configured, runner, mode="live", planner=planner))
    assert job["state"] == "failed" and not runner.calls
    result = job["result"]
    assert result["modelCalls"] == 1 and not result["verified"]
    attempt = result["provenance"][0]
    assert attempt["outcome"] == "failed" and attempt["requestHash"]
    assert attempt["finishedAt"] >= attempt["attemptedAt"]
    assert attempt["executedActions"] == []
    assert "DO_NOT_STORE" not in json.dumps(job) and "synthetic-test-key" not in json.dumps(job)
    if kind in {"timeout", "http-error"}:
        assert result["estimatedModelCostUsd"] is None and attempt["usage"] is None
    else:
        assert attempt["usage"]["prompt_tokens"] == 100 and result["estimatedModelCostUsd"] > 0
    assert (settings.root / "evidence/jobs" / job["id"] / "provenance.json").is_file()
