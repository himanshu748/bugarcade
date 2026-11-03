"""Provider availability stays distinct from configuration and never reveals credentials."""
from fastapi.testclient import TestClient

from backend.config import Settings
from backend.main import create_app


def test_selected_modal_health_never_falls_back_to_or_exposes_baseten_key(tmp_path):
    settings = Settings(data_dir=tmp_path, model_provider="modal", modal_proxy_token="",
                        model="synthetic.us-west.modal.direct", api_key="unused-baseten-synthetic",
                        live_enabled=False, budget_approved=False, approved_budget_usd=0)
    with TestClient(create_app(settings)) as client:
        response = client.get("/api/health")
    data = response.json()
    assert response.status_code == 200
    assert data["modelProvider"] == "modal" and data["modelConfigured"] is False and data["liveEnabled"] is False
    assert "MODAL_PROXY_TOKEN is unavailable." in data["liveDisabledReasons"]
    assert "BASETEN_API_KEY is unavailable." not in data["liveDisabledReasons"]
    assert settings.api_key not in response.text and "api_key" not in response.text


def test_authorized_compute_without_inference_access_cannot_submit_live_job(tmp_path):
    settings = Settings(data_dir=tmp_path, model_provider="modal", modal_proxy_token="", model="", api_key="",
        live_enabled=True, budget_approved=True, approved_budget_usd=1, modal_credentials_present=True,
        modal_image_id="im-synthetic", input_usd_per_million=1.25, output_usd_per_million=4.25,
        sandbox_usd_per_hour=0.3318)
    assert settings.compute_reasons == [] and settings.live_reasons
    with TestClient(create_app(settings)) as client:
        response = client.post("/api/jobs", json={"challengeId": "lost-note", "mode": "live", "idempotencyKey": "compute-only-no-model"})
        assert response.status_code == 503
        assert "MODAL_PROXY_TOKEN" in response.text
        assert client.get("/api/health").json()["liveEnabled"] is False
