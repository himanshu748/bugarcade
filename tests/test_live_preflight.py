"""Local preparation tests: no provider requests or submitted code execution."""
import asyncio
import io
import json
import sys
from types import SimpleNamespace

import pytest

from backend.config import Settings, modal_credentials_available
from backend.sandbox_entry import copy_output
from scripts import cloud_boundary_checks, live_validation


def test_existing_modal_profile_recognized_without_enabling_live(monkeypatch):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    monkeypatch.delenv("MODAL_TOKEN_SECRET", raising=False)
    monkeypatch.setitem(sys.modules, "modal.config", SimpleNamespace(config=SimpleNamespace(get=lambda name: "synthetic")))
    monkeypatch.setenv("BUGARCADE_LIVE_ENABLED", "false")
    monkeypatch.setenv("BUGARCADE_BUDGET_APPROVED", "false")
    monkeypatch.setenv("BUGARCADE_BUDGET_USD", "0")
    assert modal_credentials_available()
    settings = Settings()
    assert settings.modal_credentials_present
    assert settings.live_reasons
    assert not settings.live_enabled


def test_missing_modal_profile_fails_closed(monkeypatch):
    monkeypatch.delenv("MODAL_TOKEN_ID", raising=False)
    monkeypatch.delenv("MODAL_TOKEN_SECRET", raising=False)
    monkeypatch.setitem(sys.modules, "modal.config", SimpleNamespace(config=SimpleNamespace(get=lambda name: None)))
    assert not modal_credentials_available()


def test_explicit_modal_pair_never_requires_profile(monkeypatch):
    monkeypatch.setenv("MODAL_TOKEN_ID", "synthetic")
    monkeypatch.setenv("MODAL_TOKEN_SECRET", "synthetic")
    monkeypatch.setitem(sys.modules, "modal.config", None)
    assert modal_credentials_available()


def test_output_guard_stops_before_emitting_over_ceiling():
    emitted = bytearray()
    assert not copy_output(io.BytesIO(b"x" * 16385), emitted.extend, limit=16384)
    assert len(emitted) == 16384
    assert copy_output(io.BytesIO(b"ok"), emitted.extend, limit=2)


def test_build_context_is_exact_trusted_allowlist():
    names = {path.relative_to(live_validation.ROOT).as_posix() for path in live_validation.build_files()}
    assert "backend/boundary_probe.py" in names
    assert "worker/react-bundler.mjs" in names
    assert {"fixtures/app.css", "fixtures/harness.tsx", "fixtures/cartridge-transport.ts"}.issubset(names)
    assert all(not path.startswith((".data/", "evidence/", ".env", ".venv/", "node_modules/")) for path in names)
    assert len(names) == len(live_validation.build_files())


def test_recipe_uses_literal_pinned_base_for_legacy_builder():
    recipe = (live_validation.ROOT / "backend/Dockerfile.modal").read_text()
    assert f"FROM {live_validation.BASE}\n" in recipe
    assert "ARG PLAYWRIGHT_BASE" not in recipe and "FROM ${" not in recipe


@pytest.mark.parametrize("attempt", ["../escape", "/tmp/escape", "attempt-02/../bad"])
def test_attempt_output_rejects_path_traversal(monkeypatch, attempt):
    monkeypatch.setenv("BUGARCADE_VALIDATION_ATTEMPT", attempt)
    with pytest.raises(ValueError, match="attempt-NN"):
        live_validation.output_dir()


def test_attempt_output_preserves_original_receipts(monkeypatch):
    monkeypatch.setenv("BUGARCADE_VALIDATION_ATTEMPT", "attempt-02")
    assert live_validation.output_dir() == live_validation.ROOT / "evidence/live-authorized/attempt-02/prepared"


def test_prepared_estimate_covers_non_job_costs():
    estimate = live_validation.estimate()
    assert estimate["approvedUsd"] == 0
    assert estimate["subtotal"] > estimate["jobReservationOnly"]
    assert estimate["subtotalWith25PercentContingency"] <= estimate["smallestPracticalAllowance"]


def test_paid_build_guard_requires_explicit_future_authorization(monkeypatch):
    import pytest
    monkeypatch.setattr(live_validation, "verify_prepared", lambda: {"budget": {"smallestPracticalAllowance": 0.25}})
    monkeypatch.setenv("BUGARCADE_LIVE_ENABLED", "false")
    monkeypatch.setenv("BUGARCADE_BUDGET_APPROVED", "false")
    monkeypatch.setenv("BUGARCADE_BUDGET_USD", "0")
    with pytest.raises(ValueError, match="No cloud action"):
        live_validation.require_approval()


def test_build_lookup_failure_preserves_attempt_receipt(monkeypatch, tmp_path):
    import pytest
    output = tmp_path / "prepared"
    output.mkdir()
    (output / "run-manifest.json").write_text("synthetic-plan")
    monkeypatch.setattr(live_validation, "OUT", output)
    monkeypatch.setattr(live_validation, "require_approval", lambda **kwargs: ({}, Settings(modal_app="synthetic-app")))

    async def lookup(*args, **kwargs):
        raise RuntimeError("Synthetic lookup failure; no provider transport")

    monkeypatch.setitem(sys.modules, "modal", SimpleNamespace(App=SimpleNamespace(lookup=SimpleNamespace(aio=lookup))))
    with pytest.raises(RuntimeError, match="Synthetic lookup"):
        asyncio.run(live_validation.build_image())
    receipt = json.loads((tmp_path / "image-build-receipt.json").read_text())
    assert receipt["status"] == "failed-or-cancelled"
    assert receipt["startedAt"] and receipt["finishedAt"]
    assert receipt["app"] == "synthetic-app"
    assert receipt["manifestSha256"] == live_validation.sha(output / "run-manifest.json")
    assert receipt["actualCostUsd"] is None


def test_boundary_lookup_failure_records_finished_failure(monkeypatch, tmp_path):
    import pytest
    output = tmp_path / "prepared"
    output.mkdir()
    (output / "run-manifest.json").write_text("synthetic-plan")
    settings = Settings(live_enabled=True, budget_approved=True, approved_budget_usd=1, api_key="synthetic",
                        modal_credentials_present=True, modal_image_id="im-synthetic", modal_app="synthetic-app",
                        input_usd_per_million=1.25, output_usd_per_million=4.25, sandbox_usd_per_hour=0.50)
    live_validation.write_json(tmp_path / "image-build-receipt.json", {"status": "built-not-boundary-verified",
        "manifestSha256": live_validation.sha(output / "run-manifest.json"), "imageId": settings.modal_image_id, "app": settings.modal_app})
    monkeypatch.setattr(cloud_boundary_checks, "OUT", output)
    monkeypatch.setattr(cloud_boundary_checks, "require_approval", lambda **kwargs: ({}, settings))

    async def lookup(*args, **kwargs):
        raise RuntimeError("Synthetic lookup failure; no provider transport")

    monkeypatch.setitem(sys.modules, "modal", SimpleNamespace(App=SimpleNamespace(lookup=SimpleNamespace(aio=lookup))))
    with pytest.raises(RuntimeError, match="Synthetic lookup"):
        asyncio.run(cloud_boundary_checks.checks())
    receipt = json.loads((tmp_path / "boundary-receipt.json").read_text())
    assert receipt["status"] == "failed-or-cancelled-no-auto-retry"
    assert receipt["startedAt"] and receipt["finishedAt"]


@pytest.mark.parametrize("mismatch", [None, "provider", "endpoint", "model", "not-configured"])
def test_prepared_modal_plan_binds_selected_provider_without_requiring_built_image(monkeypatch, tmp_path, mismatch):
    import pytest
    output = tmp_path / "prepared"
    output.mkdir()
    (output / "run-manifest.json").write_text("synthetic review only; no provider transport")
    settings = Settings(live_enabled=True, budget_approved=True, approved_budget_usd=1, api_key="",
                        model_provider="modal", modal_proxy_token="wk-synthetic.ws-synthetic",
                        model="synthetic-muse.us-west.modal.direct", modal_credentials_present=True,
                        modal_image_id="", input_usd_per_million=1.25, output_usd_per_million=4.25,
                        sandbox_usd_per_hour=0.50)
    plan = {"budget": {"smallestPracticalAllowance": 0.25}, "model": {
        "provider": "modal", "endpoint": settings.model_endpoint, "model": settings.model, "configurationReady": True}}
    if mismatch:
        key, value = {"provider": ("provider", "baseten"), "endpoint": ("endpoint", "https://foreign.invalid/v1"),
                      "model": ("model", "different.us-west.modal.direct"), "not-configured": ("configurationReady", False)}[mismatch]
        plan["model"][key] = value
    monkeypatch.setattr(live_validation, "OUT", output)
    monkeypatch.setattr(live_validation, "Settings", lambda: settings)
    monkeypatch.setattr(live_validation, "verify_prepared", lambda: plan)
    monkeypatch.setenv("BUGARCADE_APPROVED_MANIFEST_SHA256", live_validation.sha(output / "run-manifest.json"))
    if mismatch and mismatch != "not-configured":
        with pytest.raises(ValueError, match="No cloud action"):
            live_validation.require_approval()
    else:
        assert live_validation.require_approval() == (plan, settings)
        assert settings.live_reasons  # Image still missing; this only admits the separately guarded image-build stage.


def test_current_model_credential_can_be_supplied_after_preparation_without_mutating_receipts(monkeypatch, tmp_path):
    from dataclasses import replace
    output = tmp_path / "prepared"
    output.mkdir()
    manifest_path = output / "run-manifest.json"
    manifest_path.write_text("synthetic fixed model identity; no provider calls")
    settings = Settings(live_enabled=True, budget_approved=True, approved_budget_usd=1, api_key="",
        model_provider="modal", model="fixed-muse.us-west.modal.direct", modal_proxy_token="", modal_credentials_present=True,
        input_usd_per_million=1.25, output_usd_per_million=4.25, sandbox_usd_per_hour=0.50)
    plan = {"budget": {"smallestPracticalAllowance": 0.25}, "model": {
        "provider": "modal", "endpoint": settings.model_endpoint, "model": settings.model, "configurationReady": False}}
    (tmp_path / "image-build-receipt.json").write_text("synthetic preserved receipt")
    before = {p.name: p.read_bytes() for p in [manifest_path, tmp_path / "image-build-receipt.json"]}
    monkeypatch.setattr(live_validation, "OUT", output)
    monkeypatch.setattr(live_validation, "verify_prepared", lambda: plan)
    monkeypatch.setenv("BUGARCADE_APPROVED_MANIFEST_SHA256", live_validation.sha(manifest_path))
    monkeypatch.setattr(live_validation, "Settings", lambda: settings)
    assert live_validation.require_approval(model_access=False) == (plan, settings)
    with pytest.raises(ValueError, match="No cloud action"):
        live_validation.require_approval()
    settings = replace(settings, modal_proxy_token="wk-synthetic.ws-synthetic")
    assert live_validation.require_approval() == (plan, settings)
    assert before == {p.name: p.read_bytes() for p in [manifest_path, tmp_path / "image-build-receipt.json"]}
    for changes in ({"model": "other.us-west.modal.direct"}, {"model_provider": "baseten"},
                    {"modal_proxy_token": "ak-sdk.as-secret"}, {"modal_proxy_token": ""}):
        bad = replace(settings, **changes)
        monkeypatch.setattr(live_validation, "Settings", lambda bad=bad: bad)
        with pytest.raises(ValueError, match="No cloud action"):
            live_validation.require_approval()


@pytest.mark.parametrize("failure", [None, "disabled", "unapproved", "zero-budget", "sdk", "rates", "digest", "provider"])
def test_compute_only_approval_never_grants_model_access(monkeypatch, tmp_path, failure):
    from dataclasses import replace
    output = tmp_path / "prepared"
    output.mkdir()
    (output / "run-manifest.json").write_text("synthetic compute approval; no provider calls")
    settings = Settings(live_enabled=True, budget_approved=True, approved_budget_usd=1, api_key="",
        model_provider="modal", model="", modal_proxy_token="", modal_credentials_present=True,
        modal_image_id="im-synthetic", input_usd_per_million=1.25, output_usd_per_million=4.25,
        sandbox_usd_per_hour=0.50)
    plan = {"budget": {"smallestPracticalAllowance": 0.25}, "model": {
        "provider": "modal", "endpoint": settings.model_endpoint, "model": "", "configurationReady": False}}
    changes = {"disabled": {"live_enabled": False}, "unapproved": {"budget_approved": False},
        "zero-budget": {"approved_budget_usd": 0}, "sdk": {"modal_credentials_present": False},
        "rates": {"sandbox_usd_per_hour": 0}, "provider": {"model_provider": "baseten"}}
    if failure in changes:
        settings = replace(settings, **changes[failure])
    monkeypatch.setattr(live_validation, "OUT", output)
    monkeypatch.setattr(live_validation, "Settings", lambda: settings)
    monkeypatch.setattr(live_validation, "verify_prepared", lambda: plan)
    monkeypatch.setenv("BUGARCADE_APPROVED_MANIFEST_SHA256", "wrong" if failure == "digest" else live_validation.sha(output / "run-manifest.json"))
    with pytest.raises(ValueError, match="No cloud action"):
        live_validation.require_approval()  # Inference stages stay model-gated; compute-only stages never grant model access.
    if failure:
        with pytest.raises(ValueError, match="No cloud action"):
            live_validation.require_approval(model_access=False)
    else:
        assert live_validation.require_approval(model_access=False) == (plan, settings)
        assert settings.compute_reasons == []
        assert settings.live_reasons == settings.model_reasons
