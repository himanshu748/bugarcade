# Release and provenance notes

The previous README, preserved verbatim so the main README can focus on the project.

---

## Original README: BugArcade

A debugging game for React developers. Trigger a real bug, reveal the replay, then check the fix and keep its regression test.

This source release is licensed under [MIT](LICENSE), copyright 2026 Himanshu Kumar (himanshu748). Publication to `himanshu748/bugarcade` was explicitly authorized on November 3, 2026. This preparation does not deploy the app or submit the hackathon entry. Original proof pages and the 87-second narrated cut retain their dated prepublication review context; their evidence bytes are unchanged.

Open `proof/index.html` for the offline playable cartridges, real captured Meta decisions and separate known-note/first-party-held-out coupon outcomes. No credentials or dependency install is needed for that review. Read `docs/JUDGE_GUIDE.md` and `docs/SUBMISSION_DRAFT.md` for the walkthrough, exact scope and draft narrative.

## Run the complete local app

Use Node 22.14+ and Python 3.12/3.13 with uv. Dependency versions are pinned. In this extracted directory:

```sh
npm ci --ignore-scripts
uv sync --extra dev --extra cloud
npx playwright install chromium
npm start
```

Open http://127.0.0.1:5173. If occupied, preserve that service and run the UI with `npm run dev -- --port 4173`, plus `npm run dev:fixtures` and `.venv/bin/uvicorn backend.main:app --host 127.0.0.1 --port 8000` in separate terminals. All services bind loopback. Dependency/browser installation needs network once; execution never installs submitted dependencies. No cloud access is enabled by these commands.

The five shipped seeds and their evidence work without model credentials. The private completed-job database is deliberately absent, so the app's historical Meta link shows an explicit unavailable state. Use the independent `proof/index.html` public record instead; this is not a fabricated live API response. No personal browser progress is included.

Checks: `npm run lint`, `npm run typecheck`, `npm run build`, `.venv/bin/pytest`, `.venv/bin/ruff check backend tests scripts`, `npm run test:worker`, `node --experimental-strip-types --test tests/arcade-progress.test.mjs tests/job-evidence.test.mjs`. Browser tests need the three local services and can create genuine local recorded jobs; set `BUGARCADE_BASE_URL` and `BUGARCADE_EXISTING_SERVERS=1` when using an alternate UI port. The historical 45-test result belongs to the maintainer’s original workspace. `investigation-proof.spec.ts` depends on private completed-job state deliberately excluded here; those private-route cases cannot pass in this clean public install. Use the independent offline proof for that captured Meta record. The portable browser suite is:

```sh
npx playwright test tests/e2e/arcade.spec.ts tests/e2e/focus.spec.ts tests/e2e/gamification.spec.ts tests/e2e/hallmark.spec.ts tests/e2e/job-status.spec.ts tests/e2e/landing.spec.ts tests/e2e/motion.spec.ts
```

This command is supplied for reproduction; the package receipt records actual offline proof checks, not a claim that the entire portable suite has been freshly run from a new install.

The guarded-runtime evidence verifies six boundary controls, all five 3+3 seed pairs and the identical failing/passing regression, with all 38 cohort VMs terminal; see proof/runtime-summary.json. General live API execution remains off by policy. The coupon case is a separately labeled first-party pipeline-held-out example, not broad generalization evidence. The local runner is a development convenience for trusted seeds, not security isolation. No production-readiness, arbitrary-repository support, broad generalization or entry-submission claim is made. The organizer requires an open-source GitHub repository; the owner has authorized this public source release under MIT. Deployment and hackathon submission remain separate actions.

Verify the current `package-manifest.json` against this release tree. `package-audit.json` records release preparation checks; `release-transformations.json` lists the approved documentation/license changes from the original review ZIP. The root manifest excludes itself and the audit to avoid circular hashes. Original review manifests/audits are preserved under `review-snapshot/2026-11-03/` and explicitly refer to the original ZIP, whose SHA-256 is recorded there. The unchanged `transformation-receipt.json` documents the earlier evidence privacy derivatives, not the later license/publication edits. Installed dependencies and credentials are excluded; React, React DOM and Scheduler retain their notices under `third-party/`.
