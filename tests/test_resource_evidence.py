"""Synthetic readbacks test evidence classification, never provider enforcement."""
import json

import pytest

from scripts.cloud_boundary_checks import verify_memory_outcome, verify_resources


def resources():
    return dict(appId="ap-owned", imageId="im-reviewed", cpuMilliRequest=1000,
                cpuMilliMax=2000, memoryMiBRequest=1024, memoryMiBMax=2048, timeoutSeconds=30,
                resultStatus="GENERIC_STATUS_FAILURE", exception="Container OOM: out of memory")


@pytest.mark.parametrize("field,value", [("appId", "ap-other"), ("imageId", "im-other"),
    ("cpuMilliMax", 4000), ("memoryMiBMax", 4096), ("timeoutSeconds", 60)])
def test_resource_readback_rejects_wrong_identity_or_ceiling(field, value):
    row = resources()
    row[field] = value
    with pytest.raises(ValueError):
        verify_resources(row, "ap-owned", "im-reviewed", 30)


def test_exact_resource_readback():
    verify_resources(resources(), "ap-owned", "im-reviewed", 30)


@pytest.mark.parametrize("status,reason", [
    ("GENERIC_STATUS_TERMINATED", "OOM"),
    ("GENERIC_STATUS_TIMEOUT", "out of memory"),
    ("GENERIC_STATUS_MEMORY_MANAGER_EVICTION", "out of memory"),
    ("GENERIC_STATUS_FAILURE", "killed with signal 9"),
    ("GENERIC_STATUS_SUCCESS", ""),
])
def test_generic_kill_timeout_eviction_not_oom_proof(status, reason):
    row = {**resources(), "resultStatus": status, "exception": reason}
    with pytest.raises(ValueError):
        verify_memory_outcome(row, '{"allocatedMiB":1920}\n')


@pytest.mark.parametrize("progress", [[{"allocatedMiB":512}],
    [{"allocatedMiB":2560}], [{"allocatedMiB":1920}, {"completed":True}]])
def test_oom_requires_bounded_progress_and_no_completion(progress):
    with pytest.raises(ValueError):
        verify_memory_outcome(resources(), "\n".join(map(json.dumps, progress)))


def test_specific_provider_oom_with_progress_is_classified():
    result = verify_memory_outcome(resources(), '{"allocatedMiB":64}\n{"allocatedMiB":1920}\n')
    assert result["allocatedMiBBeforeProviderOOM"] == 1920
