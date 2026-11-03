# BugArcade: judge walkthrough

A bug recording tells a developer that something broke, but rarely gives them a replay or a test they can trust. BugArcade turns that investigation into a game: trigger a real bug in a small React app, reveal why it happened, then replay the same actions against the fix and keep a regression test.

Start with `proof/index.html` in the extracted review package. Watch the **87-second demo**, or open the standalone apps and play. The demo uses Deepgram narration over edited captures of actual browser states, with an authored pointer and chapter summaries. It is not a continuous screen recording or a new model run. The full spoken transcript and caption files are included.

The video was captured November 3, 2026, before final guarded-runtime verification. Its narration preserves the gate status at capture time. The current runtime result belongs to the proof page and supported-boundary section below; the historical narration is not a new gate verdict. `proof/demo-README.md` repeats that context beside the preserved spoken transcript.

## Experience the hook

1. Open the buggy Papertrail cartridge. Click **Sync notes**, **Add note**, then **Release save-1**. The new note disappears in three moves.
2. Reveal the cause: the delayed save acknowledgement restores an old notes array and overwrites the newer note.
3. Inspect the accepted Muse proposal and initial browser action trace. The model proposed four actions; bounded minimization removed the unnecessary wait.
4. Compare the exact exported test's captured failure and pass. Open the fixed cartridge and repeat the same three moves: the note survives.
5. Open the separate **held-out coupon case**. Apply the coupon and release its response. The buggy total stays at $48.00 despite a successful 10% saving; the fixed total becomes $43.20. Its own model proposal, six browser outcomes and exact-test output are packaged separately.

Standalone cartridges work offline immediately, with a bounded in-memory API schedule. Their UI feedback is exploration playback. The independent captured worker assertions are the verification evidence. The complete five-case arcade also runs locally after the pinned setup in the package README; those five gallery plans are authored, not five autonomous model discoveries.

## What makes it different

Meta's model makes decisions that actually drive the reproduction loop. Muse Spark Open receives buggy source and timestamped recording frames, then proposes browser actions and a candidate assertion. Those actions enter the executor. A deterministic verifier decides whether the bug occurred, whether deleting an action preserves it and whether the fixed version passes the unchanged assertion. Recording evidence guides investigation; it does not certify success, and the model cannot grade its own result.

| Captured successful job | Model contribution | Independent outcome |
| --- | --- | --- |
| Known-note example | One Muse call; 2,839 tokens; 4 actions minimized to 3; 276.552 seconds | 3 buggy failures / 3 fixed passes; identical exported test fails buggy and passes fixed |
| Pipeline-held-out coupon example | One Muse call; 3,963 tokens; 3 actions minimized to 2; 270.751 seconds | Its own 3 buggy failures / 3 fixed passes; identical exported test fails buggy and passes fixed |

The coupon app, source hashes, assertion and schedule were frozen before model use, outside the supplied planner examples and five-case gallery. Its submitted action lists, hints and explanation were empty. The authored witness was used only for baseline capture and was excluded from the model payload. It is a **first-party pipeline-held-out example**, not an independently sourced production bug, an external benchmark or a claim about model training data.

These successful records are examples, not an aggregate agent success-rate estimate. Six invalid minimization outcomes in the known-note job and four in the coupon job were rejected. Three repetitions under one controlled schedule demonstrate narrow repeatability, not broad reliability. Input frames can miss fast interactions; action/network/browser traces retain ordering.

## Evidence appendix

The proof pages include accepted proposals, executed actions, immutable assertions, source hashes, seeds, schedules, timestamped recording samples, six per-case browser observations, traces, screenshots and downloadable exact regression tests. Actual failing/passing Node test outputs are shown alongside each test hash. The tests ran in isolated Modal sandboxes; opening the proof pages does not rerun them.

The original known-note inference estimate is $0.00631175, and the coupon estimate is $0.01035075. These are inference estimates for the named successful jobs, not total provider bills or spending caps. Earlier failed attempts are retained privately and are not relabeled as successes.

Current local verification passed 360 Python tests, 106 evaluation tests, 16 worker tests and 33 progress/evidence-contract tests, plus lint, types and build. All 45 distinct browser scenarios have passing results across a 44-pass full run and one corrected focused check. The full run preserved a stale fixed-mode readiness-text expectation failure; only that assertion changed, with scoring checks and timeouts intact. This is not a fresh 45/45 full-suite pass. A clean public package intentionally excludes private completed-job state, so the private-capture UI tests are not portable. The README supplies the portable suite command; the independent packaged proof is separately browser-checked with networking disabled.

The staged public Python source separately passed **360 tests in 11.34 seconds**, with one dependency deprecation warning. It imported its own staged backend and required no private database or provider receipts. This used the maintainer's existing pinned environment, without a fresh dependency install or cloud call. `proof/staged-core-tests.public.json` binds the tested Python/configuration hashes; the builder rejects stale source, and the sanitized full output is included.

## Supported boundary and current limits

Starter v1 supports explicitly authorized small React/TypeScript apps with buggy/fixed `App.tsx`, stable test IDs, a declared invariant and a controlled API schedule. Arbitrary repositories and dependency installation are outside the interface. Model calls run in the trusted backend; submitted app/browser execution belongs in Modal. The local runner is a development convenience for trusted seeds, not security isolation.

**The guarded VM runtime is now verified.** Six boundary controls passed, all five unchanged seed cases each produced three buggy failures and three fixed passes in 30 guarded browser runs, and the identical exported test failed buggy and passed fixed in two additional VMs. All 38 VMs in this verified cohort have terminal evidence. The [public runtime summary](../proof/runtime-summary.json) binds source/invariant/result hashes and exact outcomes.

The memory proof is specific: an unprivileged workload reached its root-owned 1 GiB cgroup limit inside a 2 GiB Modal VM. The kernel identified the exact memcg, leaf and victim PID; local OOM counters agreed; the supervisor survived outside the leaf and cleaned it up. Manual-kill and timeout controls remained distinct. The old outer-memory exit137 remains inconclusive. A failed host TTL-cleanup attempt and a provider-metadata timeout are preserved. Recovery revalidated 27 completed browser runs and ran only the three remaining trials; it did not reclassify an infrastructure timeout as a bug.

General uploaded-app live execution remains **off by policy**. The two captured model jobs predate the guarded-runtime change; their model decisions and the new runtime cohort are separate evidence. Three repeats under one schedule are narrow repeatability, not broad reliability or a security certification. Personal stars are browser-local play progress, not verification attestations. Baseten support is implemented but has not been verified live; these captured Muse investigations used the selected Modal Shared Endpoint.

## Package privacy and verification

The builder copies explicit source roots/extensions and selected app-only evidence. Credentials, `.data`, environment files, private model/account screenshots, raw billing, Deepgram receipts, organizer messages, caches and installed dependencies are excluded. Only the three MIT license texts needed for the runtime embedded in the cartridges are copied from dependencies. Those third-party notices retain their original terms; the approved root MIT LICENSE now covers original BugArcade source.

Public derivatives redact workspace endpoint identifiers and personal paths. Fixture source, model proposal/action/assertion payloads, canonical result files and exact exported tests retain their hashes. `transformation-receipt.json` records source/staged hashes and reasons. The current root `package-manifest.json` binds release payload bytes; `package-audit.json` records safe paths/types/sizes and bounded known-pattern scanning. The original ZIP CRC/extraction/nested checks and original manifest are retained as dated records under `review-snapshot/2026-11-03/`. `release-transformations.json` distinguishes publication documentation/license changes from unchanged source/test/proof bytes. Exact explicitly synthetic token literals in two named test files are documented exceptions; other wk/ws-shaped tokens fail the scan. This is not a Git-history scan, unknown-secret-format guarantee or signed provider attestation. Media is visually reviewed, not OCR-scanned.

From the original maintainer workspace, rebuild with:

```sh
python3 scripts/package-submission.py \
  --demo evidence/submission-demo/bugarcade-demo.mp4
```

Rebuilding requires retained private original proof; the extracted public derivative alone is not that original evidence store. The proof pages and standalone apps work offline. The full app needs a one-time network dependency/browser install, with versions pinned.

## Submission status and organizer guidance

Participant acceptance was verified from an organizer approval dated October 20. A November 3 organizer update **requires an open-source GitHub repository** and emphasizes a **three-minute demo**. This package contains an 87-second cut; final field/format requirements should be confirmed in the participant's submission context. These organizer facts are paraphrased here; private messages, identifiers and personal details are not bundled.

The [public event page](https://dev.meta.ai/events/global-hackathon) lists Indie creativity, technical ambition and whether it works, and the published deadline November 4, 2026 at 9 PM Eastern / November 5 at 7:30 AM IST. No numeric project-judging weights or bonus criteria were found there. Application-selection weights are separate.

The original review ZIP predates publication authorization. On November 3, 2026, the owner explicitly approved a new public `himanshu748/bugarcade` repository under MIT, including the initial commit/push. The root LICENSE and current release manifest reflect that authorization; original proof/source/test bytes are preserved. This local preparation performs no Git/account action. Public deployment and actual entry submission remain unauthorized and have not been performed as part of this release preparation.
