import json
import shutil
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from backend.adapter import InvalidProject, make_starter, validate_archive, write_project
from backend.config import Settings
from backend.jobs import Jobs
from backend.recording import RecordingError, extract_frames
from backend.schemas import JobRequest
from backend.store import Capacity, Conflict, Store


class UploadTooLarge(HTTPException):
    def __init__(self):
        super().__init__(413, "Request exceeds the bounded upload/body ceiling.")


class BodyLimit:
    def __init__(self, app, maximum: int):
        self.app = app
        self.maximum = maximum
        self.active_uploads = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        is_upload = scope.get("method") == "POST" and scope.get("path") == "/api/projects"
        if is_upload and self.active_uploads >= 1:
            await JSONResponse({"detail": "A recording intake is already running. Retry after it finishes."}, status_code=429)(scope, receive, send)
            return
        if is_upload:
            self.active_uploads += 1
        size = 0
        maximum = self.maximum if is_upload else 16 * 1024

        async def bounded_receive():
            nonlocal size
            message = await receive()
            size += len(message.get("body", b""))
            if size > maximum:
                raise UploadTooLarge
            return message

        try:
            await self.app(scope, bounded_receive, send)
        except UploadTooLarge:
            await JSONResponse({"detail": "Request exceeds the 21 MiB total upload ceiling."}, status_code=413)(scope, receive, send)
        finally:
            if is_upload:
                self.active_uploads -= 1


def read_challenges(root: Path) -> list[dict]:
    path = root / "shared/challenges.json"
    return json.loads(path.read_text()) if path.exists() else []


def evidence_summary(root: Path, challenge_id: str) -> dict | None:
    path = root / "evidence/seeds" / challenge_id / "summary.json"
    return json.loads(path.read_text()) if path.is_file() else None


def artifact(root: Path, relative: str) -> FileResponse:
    path = (root / relative).resolve()
    if (not path.is_relative_to(root.resolve()) or not path.is_file()
            or path.suffix not in {".json", ".png", ".webm", ".mp4", ".zip", ".mjs", ".txt", ".log", ".html"}):
        raise HTTPException(404, "Artifact not found.")
    return FileResponse(path, filename=path.name, headers={"Content-Security-Policy": "sandbox; default-src 'none'",
                                                          "X-Content-Type-Options": "nosniff"})


def create_app(settings: Settings | None = None, *, runner=None, cloud_runner=None, planner=None) -> FastAPI:
    settings = settings or Settings()
    store = Store(settings.data_dir / "jobs.sqlite3")
    jobs = Jobs(settings, store, local_runner=runner, modal_runner=cloud_runner, planner=planner)

    @asynccontextmanager
    async def lifespan(_app):
        store.recover()
        yield
        await jobs.close()

    app = FastAPI(title="BugArcade", version="0.1.0", lifespan=lifespan)
    app.state.store, app.state.jobs, app.state.settings = store, jobs, settings
    app.add_middleware(BodyLimit, maximum=21 * 1024 * 1024)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])

    @app.middleware("http")
    async def local_origin(request: Request, call_next):
        origin = request.headers.get("origin")
        if request.method not in {"GET", "HEAD", "OPTIONS"} and origin:
            parsed = urlsplit(origin)
            if parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.port not in {5173, 4173, 8000, 8001}:
                return JSONResponse({"detail": "Only the local BugArcade workbench may change jobs or uploads."}, status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/api/health")
    async def health():
        return {"status": "ok", "liveEnabled": not settings.live_reasons, "liveDisabledReasons": settings.live_reasons,
                "modelProvider": settings.model_provider, "modelConfigured": not settings.model_reasons,
                "mode": "local-single-user", "limits": {"maxActions": settings.max_actions, "maxModelCalls": settings.max_model_calls,
                "jobSeconds": settings.job_timeout_seconds, "concurrency": 1, "maxQueue": settings.max_queue}}

    @app.get("/api/challenges")
    async def challenges():
        return [{**item, "evidence": evidence_summary(settings.root, item["id"])} for item in read_challenges(settings.root)]

    @app.get("/api/challenges/{challenge_id}/evidence")
    async def evidence(challenge_id: str):
        if challenge_id not in {item["id"] for item in read_challenges(settings.root)}:
            raise HTTPException(404, "Unknown challenge.")
        data = evidence_summary(settings.root, challenge_id)
        if data is None:
            raise HTTPException(404, "No captured verification exists yet. Run the local seed verifier.")
        return data

    @app.get("/api/artifacts/{challenge_id}/{path:path}")
    async def seed_artifact(challenge_id: str, path: str):
        if challenge_id not in {item["id"] for item in read_challenges(settings.root)}:
            raise HTTPException(404, "Unknown challenge.")
        return artifact(settings.root / "evidence/seeds" / challenge_id, path)

    @app.get("/api/job-artifacts/{job_id}/{path:path}")
    async def job_artifact(job_id: str, path: str):
        if not store.get(job_id):
            raise HTTPException(404, "Unknown job.")
        return artifact(settings.root / "evidence/jobs" / job_id, path)

    @app.post("/api/jobs", status_code=202)
    async def create_job(request: JobRequest):
        if request.challengeId and request.challengeId not in {row["id"] for row in read_challenges(settings.root)}:
            raise HTTPException(404, "Unknown challenge.")
        if request.projectId and not store.project(request.projectId):
            raise HTTPException(404, "Unknown uploaded project.")
        if request.mode == "live" and settings.live_reasons:
            raise HTTPException(503, {"message": "Live cloud execution is disabled.", "reasons": settings.live_reasons})
        try:
            job, created = store.create(request, max_queue=settings.max_queue,
                         reservation=settings.live_reservation_usd if request.mode == "live" else 0,
                         budget=settings.approved_budget_usd, max_live_jobs=settings.max_live_jobs)
        except Conflict as exc:
            raise HTTPException(409, str(exc)) from exc
        except Capacity as exc:
            raise HTTPException(429, str(exc)) from exc
        if created:
            jobs.start(job)
        return job

    @app.get("/api/jobs/{job_id}")
    async def get_job(job_id: str):
        job = store.get(job_id)
        if not job:
            raise HTTPException(404, "Unknown job.")
        return job

    @app.post("/api/jobs/{job_id}/cancel")
    async def cancel_job(job_id: str):
        job = await jobs.cancel(job_id)
        if not job:
            raise HTTPException(404, "Unknown job.")
        return job

    @app.post("/api/projects", status_code=201)
    async def project_upload(project: UploadFile = File(...), recording: UploadFile = File(...),
                             hints: str = Form(""), authorized: bool = Form(False)):
        if not authorized:
            raise HTTPException(422, "Confirm that you own or are authorized to test this source and recording.")
        if len(hints) > 2000:
            raise HTTPException(422, "Hints are limited to 2,000 characters.")
        if not (project.filename or "").lower().endswith(".zip"):
            raise HTTPException(422, "Project must use the starter ZIP format.")
        suffix = Path(recording.filename or "").suffix.lower()
        if suffix not in {".mp4", ".webm"}:
            raise HTTPException(422, "Recording must be MP4 or WebM.")
        raw = await project.read(settings.max_zip_bytes + 1)
        try:
            manifest, files, hashes = validate_archive(raw)
        except (InvalidProject, ValidationError) as exc:
            raise HTTPException(422, str(exc)) from exc
        project_id = uuid.uuid4().hex
        path = settings.data_dir / "projects" / project_id
        committed = False
        try:
            write_project(path, files)
            recording_path = path / f"recording{suffix}"
            total = 0
            with recording_path.open("wb") as output:
                while chunk := await recording.read(64 * 1024):
                    total += len(chunk)
                    if total > settings.max_upload_bytes:
                        raise HTTPException(413, "Recording exceeds 20 MiB.")
                    output.write(chunk)
            metadata = await extract_frames(recording_path, path / "frames")
            document = {"id": project_id, "title": manifest.title, "path": str(path.resolve()),
                        "hashes": hashes, "recording": metadata, "hints": hints, "authorized": True}
            store.put_project(document)
            committed = True
            return {"id": project_id, "title": manifest.title,
                    "recording": {**metadata, "frames": [{"timestampMs": f["timestampMs"], "file": Path(f["path"]).name} for f in metadata["frames"]]},
                    "execution": "Uploaded source requires authorized live Modal execution; it has not been executed."}
        except RecordingError as exc:
            raise HTTPException(422, str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(503, "The pinned PyAV media decoder is unavailable. Run the documented dependency setup.") from exc
        except Capacity as exc:
            raise HTTPException(429, str(exc)) from exc
        finally:
            await project.close()
            await recording.close()
            if not committed and path.exists():
                # Only a newly-created, uncommitted temporary upload owned by this request.
                shutil.rmtree(path)

    @app.get("/api/starter")
    async def starter():
        try:
            data = make_starter(settings.root)
        except (OSError, ValueError, StopIteration):
            raise HTTPException(503, "Starter fixtures are not installed.") from None
        return Response(data, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="bugarcade-starter-v1.zip"'})

    return app


app = create_app()
