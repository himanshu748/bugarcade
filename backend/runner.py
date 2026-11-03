"""Two runners share a wire protocol, not a security guarantee."""
import asyncio
import hashlib
import json
import os
import signal
from pathlib import Path
from typing import Any

from backend.adapter import seed_manifest
from backend.artifact_transfer import ArtifactError, unpack_archive
from backend.cgroup_guard import GuardError, validate_receipt
from backend.config import Settings

GUARD_INSPECTION = """import hashlib,json,os,stat
p='/tmp/bugarcade-guard/receipt.json'
d=os.lstat('/tmp/bugarcade-guard')
assert stat.S_ISDIR(d.st_mode) and d.st_uid==0 and stat.S_IMODE(d.st_mode)==0o700
fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
try:
 s=os.fstat(fd)
 assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and stat.S_IMODE(s.st_mode)==0o600 and s.st_size<=65536
 raw=os.read(fd,65537)
 assert len(raw)==s.st_size and len(raw)<=65536
 print(json.dumps({'uid':s.st_uid,'mode':'0600','directoryUid':d.st_uid,'directoryMode':'0700','sha256':hashlib.sha256(raw).hexdigest(),'receipt':json.loads(raw)}))
finally: os.close(fd)
"""


class RunnerError(RuntimeError):
    pass


def checked_guard_result(raw: str, *, mode: str, variant: str, inputs: dict[str, str],
                         guard_sha: str, output: str, returncode: int) -> dict:
    """Authenticate the protected transport separately from the kernel receipt contract."""
    try:
        if len(raw.encode()) > 128 * 1024:
            raise ValueError("Oversized guard response.")
        envelope = json.loads(raw)
        receipt = envelope.pop("receipt")
        if (type(envelope.get("uid")) is not int or envelope["uid"] != 0
                or type(envelope.get("directoryUid")) is not int or envelope["directoryUid"] != 0
                or envelope.get("mode") != "0600" or envelope.get("directoryMode") != "0700"
                or envelope.get("sha256") != hashlib.sha256((json.dumps(receipt, sort_keys=True, indent=2) + "\n").encode()).hexdigest()):
            raise ValueError("Untrusted resource receipt.")
        validate_receipt(receipt, mode=mode, expected_inputs=inputs,
                         expected_guard_sha=guard_sha, expected_variant=variant)
        if (type(returncode) is not int or receipt["execution"]["returncode"] != returncode
                or receipt["execution"]["stdoutSha256"] != hashlib.sha256(output.encode()).hexdigest()):
            raise ValueError("Guard and executed process differ.")
        return {"guard": receipt, "guardFile": envelope}
    except (GuardError, ValueError, TypeError, KeyError, AttributeError) as error:
        raise RunnerError("VM resource boundary failed or contradicted its evidence; no reproduction was claimed.") from error


def decode_result(raw: bytes | str) -> dict:
    try:
        result = json.loads(raw)
        if not isinstance(result, dict) or result.get("status") not in {"passed", "failed", "error"}:
            raise ValueError
        if result["status"] != "error" and not isinstance(result.get("assertion"), dict):
            raise ValueError
        return result
    except (ValueError, TypeError) as exc:
        raise RunnerError("Browser worker returned an invalid result; this is not a reproduction.") from exc


async def read_bounded(stream, limit: int) -> bytes:
    result = bytearray()
    while chunk := await stream.read(8192):
        result.extend(chunk)
        if len(result) > limit:
            raise RunnerError("Worker output ceiling exceeded.")
    return bytes(result)


class LocalRunner:
    kind = "local-trusted-seeds"

    def __init__(self, settings: Settings):
        self.settings = settings

    async def run(self, challenge_id: str, variant: str, actions: list[dict], artifact_dir: Path,
                  project_dir: Path | None = None, *, assertion_hash: str | None = None) -> dict:
        if project_dir is not None or challenge_id not in {"lost-note", "rollback", "search", "duplicate", "cleanup"}:
            raise RunnerError("Local execution accepts shipped trusted seed fixtures only. Submitted source requires Modal.")
        artifact_dir.mkdir(parents=True, exist_ok=True)
        home = self.settings.data_dir / "runtime-home"
        home.mkdir(parents=True, exist_ok=True)
        # Explicit allowlist: no model/cloud credentials, proxies, NODE_OPTIONS or inherited user cookies.
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home),
                       "LANG": "C", "NODE_ENV": "test"}
        browser_cache = os.getenv("PLAYWRIGHT_BROWSERS_PATH")
        if not browser_cache:
            browser_cache = str(Path.home() / ("Library/Caches/ms-playwright" if os.uname().sysname == "Darwin" else ".cache/ms-playwright"))
        environment["PLAYWRIGHT_BROWSERS_PATH"] = browser_cache
        process = await asyncio.create_subprocess_exec("node", "worker/cli.mjs", cwd=self.settings.root,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    env=environment, start_new_session=True)
        request = {"challengeId": challenge_id, "variant": variant, "actions": actions,
                   "artifactDir": str(artifact_dir.resolve())}
        if assertion_hash:
            request["assertionHash"] = assertion_hash
        try:
            async with asyncio.timeout(self.settings.run_timeout_seconds):
                process.stdin.write((json.dumps(request) + "\n").encode())
                await process.stdin.drain()
                process.stdin.close()
                stdout, _stderr = await asyncio.gather(read_bounded(process.stdout, self.settings.max_output_bytes),
                                                       read_bounded(process.stderr, self.settings.max_output_bytes))
                await process.wait()
                if process.returncode not in {0, 2}:
                    raise RunnerError("Browser worker failed to start or exited unexpectedly. See local setup instructions.")
                return decode_result(stdout)
        except TimeoutError as exc:
            raise RunnerError("Browser run exceeded its deadline; timeout is not reproduction.") from exc
        finally:
            # The leader may already have exited while browser descendants are still alive.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            if process.returncode is None:
                await process.wait()


class ModalRunner:
    kind = "modal-sandbox"

    def __init__(self, settings: Settings, modal_module: Any = None):
        self.settings = settings
        self.modal_module = modal_module
        self.pending_cleanup: set[asyncio.Task] = set()

    async def _create(self, factory, *args, **kwargs):
        creation = asyncio.create_task(factory(*args, **kwargs))
        try:
            return await asyncio.shield(creation)
        except asyncio.CancelledError:
            async def cleanup_when_created():
                sandbox = await creation
                await asyncio.wait_for(sandbox.terminate.aio(wait=True), 10)
            cleanup = asyncio.create_task(cleanup_when_created())
            self.pending_cleanup.add(cleanup)
            def completed(task):
                self.pending_cleanup.discard(task)
                if not task.cancelled():
                    task.exception()  # consume errors; sandbox TTL is the fallback when provider is unreachable
            cleanup.add_done_callback(completed)
            try:
                await asyncio.wait_for(asyncio.shield(cleanup), 10)
            except TimeoutError:
                # Keep a strong reference and continue cleanup if remote creation resolves later.
                pass
            raise

    async def run(self, challenge_id: str, variant: str, actions: list[dict], artifact_dir: Path,
                  project_dir: Path | None = None, *, assertion_hash: str | None = None) -> dict:
        if self.settings.compute_reasons:
            raise RunnerError("Sandbox execution is disabled: " + " ".join(self.settings.compute_reasons))
        if self.modal_module is None:
            try:
                import modal
            except ImportError as exc:
                raise RunnerError("Install the pinned cloud extra before using Modal.") from exc
            if modal.__version__ != "1.6.3":
                raise RunnerError("VM execution requires the pinned Modal 1.6.3 cloud extra.")
        else:
            modal = self.modal_module
        sandbox = None
        artifact_dir.mkdir(parents=True, exist_ok=True)
        runtime = {"kind": "guarded-modal-vm-runtime", "status": "started", "runtimeRequested": "vm",
                   "imageId": self.settings.modal_image_id, "sandboxId": None, "appId": None,
                   "requestedResources": {"cpu": [1.0, 2.0], "memoryMiB": [2048, 2048]},
                   "cleanup": {"terminationRequested": False, "terminalObserved": False, "returncode": None}}
        completed = False
        try:
            async with asyncio.timeout(self.settings.run_timeout_seconds):
                # Image already exists and is immutable. No build, package download, host mount or secret injection.
                app = await modal.App.lookup.aio(self.settings.modal_app, create_if_missing=False)
                image = modal.Image.from_id(self.settings.modal_image_id)
                sandbox = await self._create(modal.Sandbox.create.aio, "python3", "-c", "import time; time.sleep(180)",
                    app=app, image=image, timeout=int(self.settings.run_timeout_seconds), cpu=(1.0, 2.0),
                    runtime="vm", memory=(2048, 2048), block_network=True, secrets=[], volumes={}, network_file_systems={},
                    include_oidc_identity_token=False, workdir="/opt/bugarcade",
                    env={"NODE_ENV": "test", "HOME": "/tmp/home", "BUGARCADE_SANDBOX": "1", "BUGARCADE_CGROUP_GUARD": "1"})
                runtime.update(sandboxId=getattr(sandbox, "object_id", None), appId=getattr(app, "app_id", None))
                # Readiness is checked inside the try/finally, so missing worker/dependencies terminates the sandbox.
                readiness = await sandbox.exec.aio("python3", "-c", "from pathlib import Path; assert all(Path('/opt/bugarcade/'+p).is_file() for p in ['worker/cli.mjs','backend/cgroup_guard.py'])", timeout=5)
                await readiness.wait.aio()
                if readiness.returncode != 0:
                    raise RunnerError("The prebuilt sandbox image did not pass readiness.")
                project = {}
                if project_dir:
                    project = {relative: (project_dir / relative).read_text() for relative in ("buggy/App.tsx", "fixed/App.tsx", "manifest.json")}
                else:
                    # Transfer the exact inspected seed sources too: a stale prebuilt image cannot silently substitute older fixtures.
                    rows = json.loads((self.settings.root / "shared/challenges.json").read_text())
                    manifest = seed_manifest(next(row for row in rows if row["id"] == challenge_id))
                    project["manifest.json"] = manifest.model_dump_json()
                    for seed_variant in ("buggy", "fixed"):
                        source = self.settings.root / "fixtures" / challenge_id / seed_variant / "App.tsx"
                        project[f"{seed_variant}/App.tsx"] = source.read_text()
                for relative, content in project.items():
                    await sandbox.filesystem.write_text.aio(content, f"/tmp/project/{relative}")
                request = {"challengeId": challenge_id, "variant": variant, "actions": actions,
                           "artifactDir": "/tmp/evidence", "projectDir": "/tmp/project"}
                if assertion_hash:
                    request["assertionHash"] = assertion_hash
                request_text = json.dumps(request)
                expected_inputs = {f"/tmp/project/{name}": hashlib.sha256(content.encode()).hexdigest() for name, content in project.items()}
                expected_inputs["/tmp/request.json"] = hashlib.sha256(request_text.encode()).hexdigest()
                await sandbox.filesystem.write_text.aio(request_text, "/tmp/request.json")
                process = await sandbox.exec.aio("python3", "backend/cgroup_guard.py", "worker",
                                                 timeout=int(self.settings.run_timeout_seconds))
                raw = await process.stdout.read.aio()
                if len(raw.encode()) > self.settings.max_output_bytes:
                    raise RunnerError("Sandbox output ceiling exceeded.")
                await process.wait.aio()
                inspection = await sandbox.exec.aio("python3", "-c", GUARD_INSPECTION, timeout=5)
                guard_raw = await inspection.stdout.read.aio()
                await inspection.wait.aio()
                if inspection.returncode != 0 or len(guard_raw.encode()) > 128 * 1024:
                    raise RunnerError("Trusted VM resource receipt is unavailable; no reproduction was claimed.")
                runtime.update(checked_guard_result(guard_raw, mode="worker", inputs=expected_inputs, variant=variant,
                    guard_sha=hashlib.sha256((self.settings.root / "backend/cgroup_guard.py").read_bytes()).hexdigest(),
                    output=raw, returncode=process.returncode))
                if process.returncode not in {0, 2}:
                    raise RunnerError("Sandbox browser execution failed; this is not a reproduction.")
                result = decode_result(raw)
                # One bounded transfer preserves all evidence without one remote file session per artifact.
                export = await sandbox.exec.aio("python3", "backend/artifact_transfer.py", timeout=8)
                inventory = await export.stdout.read.aio()
                await export.wait.aio()
                if export.returncode != 0 or len(inventory.encode()) > 64 * 1024:
                    raise RunnerError("Evidence archive creation failed; no verification claim was made.")
                try:
                    manifest = json.loads(inventory)
                    archive = await sandbox.filesystem.read_bytes.aio("/tmp/evidence-export.zip")
                    unpack_archive(archive, manifest, artifact_dir)
                except (ArtifactError, ValueError) as exc:
                    raise RunnerError("Evidence archive failed its size, path, inventory or integrity checks.") from exc
                runtime["status"] = "worker-completed"
                completed = True
                return result
        except TimeoutError as exc:
            raise RunnerError("Sandbox startup/execution deadline exceeded; this is not a reproduction.") from exc
        finally:
            try:
                if sandbox is not None:
                    runtime["cleanup"]["terminationRequested"] = True
                    # Await termination on success, readiness failure, worker failure and cancellation.
                    await asyncio.wait_for(asyncio.shield(sandbox.terminate.aio(wait=True)), timeout=10)
                    if hasattr(sandbox, "poll"):
                        code = await asyncio.wait_for(sandbox.poll.aio(), timeout=5)
                        runtime["cleanup"].update(returncode=code, terminalObserved=code is not None)
                    if completed and not runtime["cleanup"]["terminalObserved"]:
                        raise RunnerError("Sandbox termination is unconfirmed; no verification claim was made.")
            finally:
                (artifact_dir / "runtime-receipt.json").write_text(json.dumps(runtime, indent=2))
