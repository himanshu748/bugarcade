# BugArcade

**Can you make this app lose your note in three moves?**

BugArcade turns real React bugs into playable debugging challenges. Trigger the bug yourself, reveal the replay that explains it, then watch the same actions pass against the fix and keep the regression test that catches it if it ever returns.

Built for the Meta Global AI Developer Hackathon. Meta's Muse Spark Open model plans the reproduction; a deterministic verifier decides whether it actually worked.

Watch the [87-second demo](proof/demo.mp4).

## Try it in 30 seconds (no install, no keys)

Open [`proof/index.html`](proof/index.html) in a browser. It includes:

- the 87-second narrated demo, with transcript and captions
- playable buggy and fixed versions of each app
- the real Muse proposals, browser traces, recordings and exported regression tests

## The five bugs

| Case | Bug class | What goes wrong |
| --- | --- | --- |
| The vanishing note | Stale state | A delayed save acknowledgement restores an old snapshot and deletes notes added meanwhile |
| The undo from the past | Optimistic rollback | An older failed rename rolls back a newer successful one |
| Results from another time | Response ordering | A slower search response overwrites the newer results |
| One click too many | Pending submission | Every click sends a new request while one is already in flight |
| The ghost of a screen | Effect cleanup | An unmounted component's request still writes to the shared panel |

Each case has a buggy and a fixed version, a controlled API schedule you play with, a hidden cause to reveal, and stars for finding the shortest path to the bug.

## How it works

1. **Recording in, plan out.** Muse Spark Open reads the buggy source and timestamped recording frames, then proposes browser actions and a candidate failure assertion.
2. **Actions really run.** Playwright executes the proposed actions against the app, with API response order under BugArcade's control.
3. **Minimise.** BugArcade removes actions one at a time while the assertion still fails, so you get the smallest reproduction.
4. **Verify, don't trust.** The bug must fail three times on the buggy build and pass three times on the fixed build under the same schedule. The model never grades its own result.
5. **Keep the test.** The exact regression test is exported and re-run in isolated Modal sandboxes: it fails on buggy and passes on fixed.

## Results

| Job | Meta model's part | Verified outcome |
| --- | --- | --- |
| The vanishing note | 4 proposed actions, minimised to 3 | 3 buggy failures, 3 fixed passes; exported test fails buggy and passes fixed |
| Coupon app (held out, never shown to the planner) | 3 proposed actions, minimised to 2 | 3 buggy failures, 3 fixed passes; exported test re-verified in two more sandboxes |

All five seed cases also reproduce 3/3 buggy and pass 3/3 fixed inside the guarded VM runtime ([runtime summary](proof/runtime-summary.json)). Local checks: 360 Python tests, 106 evaluation tests, 16 worker tests and 45 browser scenarios, plus lint, types and build.

## Architecture

- **Frontend:** React 19 and TypeScript (Vite)
- **Backend:** Python and FastAPI, with SQLite job storage and strict action schemas
- **Execution:** bounded Playwright runs, a controllable API scheduler, and assertion-preserving minimisation
- **Model:** Muse Spark Open, called from the trusted backend only, never from inside the app sandbox
- **Sandboxes:** Modal VMs with memory, time and network limits for untrusted app runs

## Run the full app locally

Requires Node 22.14+ and Python 3.12 or 3.13 with [uv](https://docs.astral.sh/uv/).

```sh
npm ci --ignore-scripts
uv sync --extra dev --extra cloud
npx playwright install chromium
npm start
```

Open http://127.0.0.1:5173. The five cases and their evidence work without model credentials. Live model planning needs your own provider key; see `.env` settings in `backend/config.py`.

Checks:

```sh
npm run lint && npm run typecheck && npm run build
.venv/bin/pytest
npx playwright test tests/e2e/arcade.spec.ts tests/e2e/landing.spec.ts tests/e2e/gamification.spec.ts
```

## Scope

BugArcade supports small React and TypeScript apps that follow the [Starter v1 format](docs/STARTER.md): a buggy and fixed `App.tsx`, stable test IDs, a declared invariant and a controlled API schedule. Arbitrary repositories and live uploads are off for now. The two model jobs are real examples, not a success-rate claim.

More detail: [judge walkthrough](docs/JUDGE_GUIDE.md) · [release and provenance notes](docs/RELEASE_NOTES.md)

## License

[MIT](LICENSE)
