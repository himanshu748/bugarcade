"""Synthetic transport objects test admission only; Linux/kernel behavior is separate."""
import hashlib
import json

import pytest

from backend import runner


def envelope(receipt):
    return {"uid": 0, "directoryUid": 0, "mode": "0600", "directoryMode": "0700",
            "sha256": hashlib.sha256((json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()).hexdigest(),
            "receipt": receipt}


def invoke(value):
    return runner.checked_guard_result(json.dumps(value), mode="worker", variant="buggy", inputs={},
                                      guard_sha="a" * 64, output="{}", returncode=0)


@pytest.fixture
def synthetic(monkeypatch):
    # The real kernel/UID/cleanup validator has its own independent contradiction tests.
    monkeypatch.setattr(runner, "validate_receipt", lambda *_args, **_kwargs: True)
    return envelope({"syntheticTransportOnly": True,
                     "execution": {"returncode": 0, "stdoutSha256": hashlib.sha256(b"{}").hexdigest()}})


def test_valid_transport_preserves_payload(synthetic):
    assert invoke(synthetic)["guard"] == synthetic["receipt"]


@pytest.mark.parametrize(("field", "value"), [
    ("uid", False), ("uid", 1000), ("directoryUid", False), ("directoryUid", 1000),
    ("mode", "0644"), ("directoryMode", "0777"), ("sha256", "0" * 64),
])
def test_untrusted_receipt_transport_fails_closed(synthetic, field, value):
    synthetic[field] = value
    with pytest.raises(runner.RunnerError, match="resource boundary"):
        invoke(synthetic)


@pytest.mark.parametrize("field", ["returncode", "stdoutSha256"])
def test_report_cannot_substitute_another_execution(synthetic, field):
    synthetic["receipt"]["execution"][field] = 2 if field == "returncode" else "0" * 64
    with pytest.raises(runner.RunnerError):
        invoke(envelope(synthetic["receipt"]))


def test_kernel_contract_rejection_is_never_a_worker_pass(synthetic, monkeypatch):
    def reject(*_args, **_kwargs):
        raise runner.GuardError("Synthetic missing kernel attribution")
    monkeypatch.setattr(runner, "validate_receipt", reject)
    with pytest.raises(runner.RunnerError):
        invoke(synthetic)


@pytest.mark.parametrize("raw", ["[]", "null", "not json", "{}", "x" * (128 * 1024 + 1)])
def test_malformed_or_oversized_transport_is_an_infrastructure_error(raw):
    with pytest.raises(runner.RunnerError):
        runner.checked_guard_result(raw, mode="worker", variant="buggy", inputs={}, guard_sha="a" * 64,
                                    output="{}", returncode=0)
