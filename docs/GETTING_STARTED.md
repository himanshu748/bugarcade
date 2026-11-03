# Run BugArcade locally

The arcade runs on your computer. Playing the five included cases needs no account, model key or cloud execution.

## Prerequisites

- Node.js 22.14 or newer and npm.
- Python 3.12 or 3.13 and [uv](https://docs.astral.sh/uv/getting-started/installation/).
- A supported desktop browser. Playwright installs its own Chromium for automated verification.

## Install and start

```sh
git clone https://github.com/himanshu748/bugarcade.git
cd bugarcade
npm ci --ignore-scripts
uv sync --extra dev --extra cloud
npx playwright install chromium
npm start
```

Open [localhost:5173](http://127.0.0.1:5173). `npm start` launches the React frontend, fixture server and FastAPI backend. Ctrl+C stops all three. Installing dependencies and Chromium requires network access; the included arcade does not call a model provider.

| Service | Default address | Purpose |
| --- | --- | --- |
| React frontend | `127.0.0.1:5173` | Gallery, arena, replay, evidence and creator |
| Fixture server | `127.0.0.1:4174` | Included React apps and controlled API simulator |
| FastAPI backend | `127.0.0.1:8000` | Upload validation, job orchestration and artifacts |

Keep these services on loopback. The backend is a single-user development service with one worker, not an authenticated public API.

### If port 5173 is already in use

Preserve the existing service. Run these in three terminals from the repository root:

```sh
npm run dev -- --port 4173
```

```sh
npm run dev:fixtures
```

```sh
.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Open [localhost:4173](http://127.0.0.1:4173). The frontend proxies `/api` to port 8000. Do not use Vite's static preview as a replacement for the API proxy.

## Play your first case

Choose **The disappearing note**. Your goal is to lose the newly added note in three moves. Click or type in the embedded app; use the network rack to decide when pending responses arrive. Reset restarts the attempt. Hints and Reveal are optional.

After catching the bug, reveal its action timeline and explanation. **Test the fix** replays the captured actions against the fixed counterpart. The evidence panel links the deterministic assertion, trace, screenshots and regression test. Stars and best moves are personal browser progress; verification results come from the browser worker.

## Inspect the captured Meta investigations

Open [proof/index.html](../proof/index.html) directly in your browser for the known-note investigation, or [proof/heldout/index.html](../proof/heldout/index.html) for the separate coupon case. These self-contained pages need no install or credentials. They include playable captured cartridges, actual model proposals, action records and failing/passing test output.

The public repository excludes the maintainer's private job database. A historical job URL in a clean install can therefore show **unavailable**. The independent proof pages are the portable record; they do not impersonate a live API response.

## Create a challenge

The creator accepts [Starter v1](STARTER.md): a manifest, buggy/fixed React components and a short MP4/WebM bug recording. Download a valid starter from the creator or `/api/starter` while FastAPI is running. The recording guides investigation; the browser assertion determines the result.

**Recorded mode** is available for the shipped seed apps, uses an authored replay and makes no model call. Uploaded projects require live-agent mode. **Live-agent mode** requires separately configured backend credentials, an immutable prebuilt Modal image, an approved finite budget and explicit live switches. It starts disabled. Do not turn it on just to play the arcade, and do not execute uploaded source with the local runner. See [architecture](ARCHITECTURE.md) and [security](SECURITY.md) before operating live execution.

## Run checks

```sh
npm run lint
npm run typecheck
npm run build
.venv/bin/ruff check backend tests scripts
.venv/bin/pytest
npm run test:worker
node --experimental-strip-types --test tests/arcade-progress.test.mjs tests/job-evidence.test.mjs
```

The portable browser suite starts the local services when needed:

```sh
npx playwright test tests/e2e/arcade.spec.ts tests/e2e/focus.spec.ts tests/e2e/gamification.spec.ts tests/e2e/hallmark.spec.ts tests/e2e/job-status.spec.ts tests/e2e/landing.spec.ts tests/e2e/motion.spec.ts
```

For already-running services on port 4173, prefix that command with `BUGARCADE_BASE_URL=http://127.0.0.1:4173 BUGARCADE_EXISTING_SERVERS=1`. `investigation-proof.spec.ts` is a maintainer capture test that depends on the excluded private completed-job database; it is outside the portable suite.

To recapture all five trusted seeds, run `npm run verify:seeds`. This executes real local browsers and overwrites their generated evidence, so use a separate checkout if you want to preserve the published capture. Local tests and seed verification make no model or cloud requests.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Python environment missing | Run `uv sync --extra dev --extra cloud` in the repository root. |
| Address already in use | Check all three service ports; use the alternate frontend instructions above. |
| Browser executable missing | Run `npx playwright install chromium`. |
| API unavailable | Confirm FastAPI is running on port 8000 and use `npm run dev`, not a static file server, for the main app. |
| Live mode unavailable | Expected until the trusted backend has explicit live authorization, credentials, rates and a prebuilt image. |
| Old model job unavailable | Use the portable proof pages; the public install does not include private job history. |

Local uploads and jobs are stored in `.data/`. Traces and recordings may contain entered app content. Review exports before sharing, and preserve anything you need before resetting local state.
