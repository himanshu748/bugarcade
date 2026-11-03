"""Explicit spending gates. Reading presence is safe; no credential values leave this process."""
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def configured_model() -> str:
    if os.getenv("BUGARCADE_MODEL"):
        return os.environ["BUGARCADE_MODEL"]
    if os.getenv("BUGARCADE_MODEL_PROVIDER", "baseten") == "modal":
        return ""
    return os.getenv("BASETEN_MODEL", "meta-models/muse-spark-open")


def modal_proxy_credential() -> str:
    combined = os.getenv("MODAL_PROXY_TOKEN", "")
    if combined:
        return combined
    token_id, secret = os.getenv("MODAL_PROXY_TOKEN_ID", ""), os.getenv("MODAL_PROXY_TOKEN_SECRET", "")
    return f"{token_id}.{secret}" if token_id and secret else ""


def modal_credentials_available() -> bool:
    """Use the SDK's existing local profile too; never export or log its values."""
    if os.getenv("MODAL_TOKEN_ID") and os.getenv("MODAL_TOKEN_SECRET"):
        return True
    try:
        from modal.config import config
        return bool(config.get("token_id") and config.get("token_secret"))
    except (ImportError, OSError, ValueError, KeyError):
        return False


@dataclass(frozen=True)
class Settings:
    root: Path = ROOT
    data_dir: Path = field(default_factory=lambda: Path(os.getenv("BUGARCADE_DATA_DIR", ROOT / ".data")))
    live_enabled: bool = field(default_factory=lambda: os.getenv("BUGARCADE_LIVE_ENABLED") == "true")
    budget_approved: bool = field(default_factory=lambda: os.getenv("BUGARCADE_BUDGET_APPROVED") == "true")
    approved_budget_usd: float = field(default_factory=lambda: float(os.getenv("BUGARCADE_BUDGET_USD", "0")))
    api_key: str = field(default_factory=lambda: os.getenv("BASETEN_API_KEY", ""), repr=False)
    model_provider: str = field(default_factory=lambda: os.getenv("BUGARCADE_MODEL_PROVIDER", "baseten"))
    modal_proxy_token: str = field(default_factory=modal_proxy_credential, repr=False)
    model: str = field(default_factory=configured_model)
    modal_image_id: str = field(default_factory=lambda: os.getenv("BUGARCADE_MODAL_IMAGE_ID", ""))
    modal_app: str = field(default_factory=lambda: os.getenv("BUGARCADE_MODAL_APP", "bugarcade-worker"))
    modal_credentials_present: bool = field(default_factory=modal_credentials_available)
    input_usd_per_million: float = field(default_factory=lambda: float(os.getenv("BUGARCADE_INPUT_USD_PER_MILLION", "0")))
    output_usd_per_million: float = field(default_factory=lambda: float(os.getenv("BUGARCADE_OUTPUT_USD_PER_MILLION", "0")))
    sandbox_usd_per_hour: float = field(default_factory=lambda: float(os.getenv("BUGARCADE_SANDBOX_USD_PER_HOUR", "0")))
    max_live_jobs: int = 1
    max_actions: int = 12
    max_model_calls: int = 2
    max_output_tokens: int = 2048
    max_input_tokens: int = 24000
    max_minimize_probes: int = 20
    job_timeout_seconds: float = 300
    model_timeout_seconds: float = 20
    run_timeout_seconds: float = 45
    max_queue: int = 4
    max_upload_bytes: int = 20 * 1024 * 1024
    max_zip_bytes: int = 256 * 1024
    max_output_bytes: int = 1024 * 1024

    @property
    def model_api_key(self) -> str:
        if self.model_provider == "baseten":
            return self.api_key
        if self.model_provider == "modal":
            return self.modal_proxy_token
        return ""

    @property
    def model_endpoint(self) -> str:
        if self.model_provider == "baseten":
            return "https://inference.baseten.co/v1/chat/completions"
        if self.model_provider == "modal":
            return "https://inference.us-west.modal.direct/v1/chat/completions"
        raise ValueError("Unsupported model provider; no model request is allowed.")

    @property
    def model_reasons(self) -> list[str]:
        """Model routing/auth validation, independent of compute/image provisioning."""
        reasons = []
        if self.model_provider not in {"baseten", "modal"}:
            reasons.append("BUGARCADE_MODEL_PROVIDER must be baseten or modal.")
        elif not self.model_api_key:
            reasons.append("MODAL_PROXY_TOKEN is unavailable." if self.model_provider == "modal" else "BASETEN_API_KEY is unavailable.")
        if self.model_provider == "modal":
            if self.modal_proxy_token and not re.fullmatch(r"wk-[A-Za-z0-9_-]+\.ws-[A-Za-z0-9_-]+", self.modal_proxy_token):
                reasons.append("Modal inference requires an endpoint proxy token; SDK API tokens are not interchangeable.")
            if not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.us-west\.modal\.direct", self.model):
                reasons.append("BUGARCADE_MODEL must be an existing Shared Endpoint hostname under .us-west.modal.direct.")
        return reasons

    @property
    def compute_reasons(self) -> list[str]:
        """Authorize sandbox execution independently of inference access; never authorizes model calls."""
        reasons = []
        if not self.live_enabled:
            reasons.append("Live cloud execution is disabled (BUGARCADE_LIVE_ENABLED).")
        if not self.budget_approved or not math.isfinite(self.approved_budget_usd) or self.approved_budget_usd <= 0:
            reasons.append("An explicit approved budget is required (BUGARCADE_BUDGET_APPROVED and BUGARCADE_BUDGET_USD).")
        if not self.modal_credentials_present:
            reasons.append("Modal credentials are unavailable: use an existing SDK profile or trusted-backend MODAL_TOKEN_ID / MODAL_TOKEN_SECRET.")
        if not self.modal_image_id.startswith("im-"):
            reasons.append("A prebuilt immutable BUGARCADE_MODAL_IMAGE_ID is required.")
        if any(not math.isfinite(value) or value <= 0 for value in (self.input_usd_per_million, self.output_usd_per_million, self.sandbox_usd_per_hour)):
            reasons.append("Current conservative model and sandbox rates must be configured for budget reservations.")
        return reasons

    @property
    def live_reasons(self) -> list[str]:
        return self.compute_reasons + self.model_reasons

    @property
    def live_reservation_usd(self) -> float:
        # Reserve the whole worst-case configured model context and sandbox wall time; never refund automatically.
        model = self.max_model_calls * (self.max_input_tokens * self.input_usd_per_million + self.max_output_tokens * self.output_usd_per_million) / 1_000_000
        return model + (self.job_timeout_seconds + self.run_timeout_seconds + 10) * self.sandbox_usd_per_hour / 3600
