"""A single SQLite transaction owns idempotency, capacity and conservative spending reservations."""
import json
import math
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from backend.schemas import JobRequest, digest

TERMINAL = {"completed", "not-reproduced", "failed", "cancelled"}
ACTIVE = {"queued", "preparing", "investigating", "reproducing", "minimizing", "validating"}
TRANSITIONS = {
    "queued": {"preparing", "cancelled", "failed"},
    "preparing": {"investigating", "failed", "cancelled"},
    "investigating": {"reproducing", "failed", "cancelled"},
    "reproducing": {"investigating", "minimizing", "not-reproduced", "failed", "cancelled"},
    "minimizing": {"validating", "failed", "cancelled"},
    "validating": {"completed", "not-reproduced", "failed", "cancelled"},
}


class Conflict(ValueError):
    pass


class Capacity(ValueError):
    pass


class Store:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with self.connect() as db:
            db.executescript("""
              PRAGMA journal_mode=WAL;
              CREATE TABLE IF NOT EXISTS jobs(
                id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL,
                request_hash TEXT NOT NULL, document TEXT NOT NULL,
                reserved_usd REAL NOT NULL DEFAULT 0, live INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, document TEXT NOT NULL);
            """)

    def connect(self):
        return sqlite3.connect(self.path, timeout=5)

    def create(self, request: JobRequest, *, max_queue: int, reservation: float = 0,
               budget: float = 0, max_live_jobs: int = 1) -> tuple[dict, bool]:
        fingerprint = digest(request.model_dump(exclude={"idempotencyKey"}))
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = db.execute("SELECT request_hash,document FROM jobs WHERE idempotency_key=?", (request.idempotencyKey,)).fetchone()
            if old:
                if old[0] != fingerprint:
                    raise Conflict("This idempotency key belongs to a different request.")
                return json.loads(old[1]), False
            documents = [json.loads(row[0]) for row in db.execute("SELECT document FROM jobs")]
            if len(documents) >= 200:
                raise Capacity("Local history limit reached (200 jobs). Export and archive data before continuing.")
            if sum(job["state"] in ACTIVE for job in documents) >= max_queue:
                raise Capacity("The bounded job queue is full. Wait for a job or cancel one.")
            if request.mode == "live":
                if not all(math.isfinite(value) and value > 0 for value in (reservation, budget)):
                    raise Capacity("Live budget and reservation must be finite positive amounts.")
                spent, count = db.execute("SELECT COALESCE(SUM(reserved_usd),0),SUM(live) FROM jobs").fetchone()
                if (count or 0) >= max_live_jobs or spent + reservation > budget or reservation <= 0:
                    raise Capacity("Approved live-job or conservative budget ceiling reached. No provider call was made.")
            now = time.time()
            job = {"id": uuid.uuid4().hex, **request.model_dump(exclude={"idempotencyKey"}),
                   "state": "queued", "createdAt": now, "updatedAt": now, "result": None, "error": None,
                   "events": [{"state": "queued", "at": now, "message": "Queued for one-at-a-time execution."}],
                   "reservedUsd": reservation, "retryable": False}
            db.execute("INSERT INTO jobs VALUES(?,?,?,?,?,?)", (job["id"], request.idempotencyKey, fingerprint,
                       json.dumps(job), reservation, int(request.mode == "live")))
            return job, True

    def get(self, job_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT document FROM jobs WHERE id=?", (job_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def transition(self, job_id: str, state: str, message: str, *, result: Any = None,
                   error: str | None = None, retryable: bool = False) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT document FROM jobs WHERE id=?", (job_id,)).fetchone()
            if not row:
                raise KeyError(job_id)
            job = json.loads(row[0])
            if job["state"] in TERMINAL:
                return job
            if state not in TRANSITIONS[job["state"]]:
                raise ValueError(f"Invalid transition {job['state']} → {state}")
            job.update(state=state, updatedAt=time.time(), result=result, error=error, retryable=retryable)
            job["events"].append({"state": state, "at": job["updatedAt"], "message": message})
            db.execute("UPDATE jobs SET document=? WHERE id=?", (json.dumps(job), job_id))
            return job

    def recover(self) -> int:
        with self.connect() as db:
            ids = [row[0] for row in db.execute("SELECT id FROM jobs")]
        count = 0
        for job_id in ids:
            job = self.get(job_id)
            if job and job["state"] in ACTIVE:
                self.transition(job_id, "failed", "Backend restarted; interrupted work was not marked successful.",
                                error="Interrupted by restart. Start a new request to retry.", retryable=True)
                count += 1
        return count

    def put_project(self, document: dict) -> None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT COUNT(*) FROM projects").fetchone()[0] >= 20:
                raise Capacity("Local project storage limit reached (20 projects).")
            db.execute("INSERT INTO projects VALUES(?,?)", (document["id"], json.dumps(document)))

    def project(self, project_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute("SELECT document FROM projects WHERE id=?", (project_id,)).fetchone()
        return json.loads(row[0]) if row else None
