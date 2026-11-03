"""Optional Modal provider contracts use HTTPX/provider doubles only; no live inference."""
import asyncio
import hashlib
import json
from dataclasses import replace

import httpx
import pytest

from backend.config import Settings
from backend.jobs import Jobs
from backend.planner import Planner, PlannerError
from backend.schemas import JobRequest, Manifest, invariant_hash
from backend.store import Store

MODAL_ENDPOINT = "https://inference.us-west.modal.direct/v1/chat/completions"
MODEL = "synthetic-muse.us-west.modal.direct"
PROXY = "wk-synthetic.ws-not-a-real-secret"


@pytest.fixture
def manifest():
    return Manifest.model_validate({"id": "lost-note", "title": "Synthetic Modal contract", "goal": "Keep the note",
        "allowedTargets": ["sync", "result", "done"], "assertion": {"target": "result", "operator": "contains", "expected": "new note"},
        "completion": {"target": "done", "value": "done"}, "schedule": [],
        "actions": [{"type": "click", "target": "sync"}]})


@pytest.fixture
def settings(tmp_path):
    return Settings(root=tmp_path, data_dir=tmp_path / "data", model_provider="modal", model=MODEL,
                    api_key="unselected-baseten-synthetic", modal_proxy_token=PROXY, live_enabled=True,
                    budget_approved=True, approved_budget_usd=1, modal_credentials_present=True,
                    modal_image_id="im-synthetic", input_usd_per_million=1.25, output_usd_per_million=4.25,
                    sandbox_usd_per_hour=0.3318, max_minimize_probes=1)


def response_for(manifest, **changes):
    proposal = {"actions": [a.model_dump() for a in manifest.actions],
                "candidateAssertion": manifest.assertion.model_dump(), "rationale": "Synthetic delayed update plan"}
    proposal.update(changes)
    return {"choices": [{"message": {"content": json.dumps(proposal)}}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 60}}


def test_modal_request_uses_only_selected_proxy_and_records_frame_provenance(settings, manifest, tmp_path, monkeypatch):
    captured = []
    monkeypatch.setenv("HTTPS_PROXY", "https://untrusted.invalid")
    frame = tmp_path / "frame.png"
    frame.write_bytes(b"synthetic frame bytes, not provider/video evidence")
    def handler(request):
        captured.append(request)
        return httpx.Response(200, json=response_for(manifest))
    selected = replace(settings, api_key="")
    actions, audit = asyncio.run(Planner(selected, httpx.MockTransport(handler)).propose(
        manifest, "export default function App(){return null}", [{"path": str(frame), "timestampMs": 125}], ""))
    assert actions == [a.model_dump() for a in manifest.actions]
    assert len(captured) == 1 and str(captured[0].url) == MODAL_ENDPOINT
    assert captured[0].headers["authorization"] == f"Bearer {PROXY}"
    payload = json.loads(captured[0].content)
    assert payload["model"] == MODEL and payload["max_tokens"] == selected.max_output_tokens
    assert "response_format" not in payload
    assert audit["provider"] == "modal" and audit["endpoint"] == MODAL_ENDPOINT
    assert audit["origin"] == "live-model" and audit["outcome"] == "proposed"
    assert audit["invariantHash"] == invariant_hash(manifest)
    assert audit["frames"][0] == {"timestampMs": 125, "sha256": hashlib.sha256(frame.read_bytes()).hexdigest()}
    assert audit["usage"] == {"prompt_tokens": 100, "completion_tokens": 60}
    assert audit["estimatedModelCostUsd"] == pytest.approx(0.00038)
    assert PROXY not in json.dumps(audit) and PROXY not in repr(selected)


@pytest.mark.parametrize("overrides", [
    {"model_provider": "other"}, {"modal_proxy_token": ""}, {"modal_proxy_token": "ak-sdk.as-secret"},
    {"model": "meta-models/Muse-Spark-Open-816B-A42B"}, {"model": "https://synthetic.us-west.modal.direct"},
    {"model": "synthetic.us-west.modal.direct/path"}, {"model": "synthetic.us-west.modal.direct?key=secret"},
    {"model": "user@synthetic.us-west.modal.direct"}, {"model": "synthetic.us-west.modal.direct.evil.invalid"},
    {"model": ""}, {"live_enabled": False}, {"budget_approved": False}, {"approved_budget_usd": 0},
    {"modal_image_id": ""}, {"modal_credentials_present": False},
])
def test_invalid_or_unapproved_modal_configuration_has_no_transport(settings, manifest, overrides):
    calls = []
    def handler(request):
        calls.append(request)
        raise AssertionError("No synthetic transport should be reached")
    with pytest.raises(PlannerError):
        asyncio.run(Planner(replace(settings, **overrides), httpx.MockTransport(handler)).propose(manifest, "source", [], ""))
    assert not calls


@pytest.mark.parametrize("change", ["unknown-action", "unknown-target", "changed-assertion"])
def test_modal_output_cannot_expand_actions_or_weaken_invariant(settings, manifest, change):
    proposal = {}
    if change == "unknown-action":
        proposal["actions"] = [{"type": "evaluate", "script": "untrusted"}]
    elif change == "unknown-target":
        proposal["actions"] = [{"type": "click", "target": "undeclared"}]
    else:
        proposal["candidateAssertion"] = {**manifest.assertion.model_dump(), "expected": ""}
    def handler(_request):
        return httpx.Response(200, json=response_for(manifest, **proposal))
    with pytest.raises(PlannerError) as caught:
        asyncio.run(Planner(settings, httpx.MockTransport(handler)).propose(manifest, "source", [], ""))
    assert caught.value.provenance["provider"] == "modal"
    assert caught.value.provenance["outcome"] == "failed"


def test_redirect_does_not_forward_modal_proxy_to_another_origin(settings, manifest):
    captured = []
    def handler(request):
        captured.append(str(request.url))
        return httpx.Response(307, headers={"location": "https://foreign.invalid/collect"})
    with pytest.raises(PlannerError) as caught:
        asyncio.run(Planner(settings, httpx.MockTransport(handler)).propose(manifest, "source", [], ""))
    assert captured == [MODAL_ENDPOINT]
    assert caught.value.provenance["endpoint"] == MODAL_ENDPOINT
    assert PROXY not in str(caught.value)


def test_reported_token_excess_stops_modal_proposal(settings, manifest):
    calls = []
    def handler(request):
        calls.append(request)
        response = response_for(manifest)
        response["usage"]["prompt_tokens"] = settings.max_input_tokens + 1
        return httpx.Response(200, json=response)
    with pytest.raises(PlannerError, match="token use exceeded") as caught:
        asyncio.run(Planner(settings, httpx.MockTransport(handler)).propose(manifest, "source", [], ""))
    assert len(calls) == 1 and caught.value.provenance["provider"] == "modal"
    assert caught.value.provenance["usage"]["prompt_tokens"] == settings.max_input_tokens + 1


def test_existing_proxy_env_pair_is_combined_without_sdk_token_fallback(monkeypatch):
    for name in ["MODAL_PROXY_TOKEN", "MODAL_PROXY_TOKEN_ID", "MODAL_PROXY_TOKEN_SECRET", "BUGARCADE_MODEL"]:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("BUGARCADE_MODEL_PROVIDER", "modal")
    monkeypatch.setenv("MODAL_TOKEN_ID", "ak-sdk")
    monkeypatch.setenv("MODAL_TOKEN_SECRET", "as-sdk-secret")
    selected = Settings(modal_credentials_present=True)
    assert selected.model_api_key == "" and selected.model == ""
    monkeypatch.setenv("MODAL_PROXY_TOKEN_ID", "wk-synthetic")
    assert Settings(modal_credentials_present=True).model_api_key == ""
    monkeypatch.setenv("MODAL_PROXY_TOKEN_SECRET", "ws-not-a-real-secret")
    monkeypatch.setenv("BUGARCADE_MODEL", MODEL)
    selected = Settings(modal_credentials_present=True)
    assert selected.model_api_key == PROXY and selected.model == MODEL
    assert PROXY not in repr(selected)


def test_baseten_compatibility_never_uses_modal_proxy(settings):
    selected = replace(settings, model_provider="baseten", api_key="baseten-synthetic", model="meta-models/muse-spark-open")
    assert selected.model_api_key == "baseten-synthetic"
    assert selected.model_endpoint == "https://inference.baseten.co/v1/chat/completions"
    assert replace(selected, api_key="").model_api_key == ""
    assert not selected.live_reasons


def test_model_readiness_is_separate_from_unapproved_compute_and_missing_image(settings):
    before_image = replace(settings, modal_image_id="", modal_credentials_present=False,
                           live_enabled=False, budget_approved=False, approved_budget_usd=0)
    assert before_image.model_reasons == []
    assert any("approved budget" in reason for reason in before_image.live_reasons)
    assert any("prebuilt immutable" in reason for reason in before_image.live_reasons)
    assert any("Modal credentials are unavailable" in reason for reason in before_image.live_reasons)
    missing = replace(before_image, modal_proxy_token="", model="meta-models/Muse-Spark-Open-816B-A42B")
    assert len(missing.model_reasons) == 2
    assert all(reason in missing.live_reasons for reason in missing.model_reasons)
    invalid = replace(before_image, modal_proxy_token="ak-sdk.as-secret")
    assert any("SDK API tokens" in reason for reason in invalid.model_reasons)


def test_modal_proposal_drives_existing_job_loop_and_provider_summary(settings, manifest):
    """Synthetic end-to-end orchestration, never proof of browser/provider success."""
    (settings.root / "shared").mkdir()
    (settings.root / "shared/challenges.json").write_text(json.dumps([manifest.model_dump()]))
    for variant in ("buggy", "fixed"):
        folder = settings.root / "fixtures/lost-note" / variant
        folder.mkdir(parents=True)
        (folder / "App.tsx").write_text("export default function App(){return null}")
    calls = []
    class SyntheticRunner:
        async def run(self, challenge_id, variant, actions, artifact_dir, project_dir=None, *, assertion_hash=None):
            calls.append((variant, list(actions)))
            if not actions:
                return {"status": "error", "error": "Synthetic absent completion"}
            artifact_dir.mkdir(parents=True, exist_ok=True)
            for name in ("player.html", "trace.zip", "recording.webm"):
                (artifact_dir / name).write_bytes(b"Synthetic contract artifact; not a real capture")
            passed = variant == "fixed"
            return {"status": "passed" if passed else "failed", "error": None,
                "assertion": {**manifest.assertion.model_dump(), "hash": assertion_hash,
                    "completion": manifest.completion.model_dump(), "actual": "new note" if passed else "old note", "pass": passed},
                "actions": [{"action": action, "status": "executed"} for action in actions], "artifacts": {}}
    def handler(_request):
        return httpx.Response(200, json=response_for(manifest))
    async def run():
        store = Store(settings.data_dir / "jobs.sqlite3")
        job, _ = store.create(JobRequest(challengeId="lost-note", mode="live", idempotencyKey="synthetic-modal-job"),
                              max_queue=1, reservation=0.1, budget=1)
        jobs = Jobs(settings, store, modal_runner=SyntheticRunner(), planner=Planner(settings, httpx.MockTransport(handler)))
        await jobs._drive(job["id"])
        return store.get(job["id"])
    job = asyncio.run(run())
    assert job["state"] == "completed"
    assert calls[0] == ("buggy", [action.model_dump() for action in manifest.actions])
    assert job["result"]["modelProvider"] == "modal" and job["result"]["modelCalls"] == 1
    assert job["result"]["provenance"][0]["provider"] == "modal"
    assert job["result"]["provenance"][0]["proposedActions"] == job["result"]["provenance"][0]["executedActions"]
