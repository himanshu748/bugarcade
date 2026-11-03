# What has been verified

BugArcade separates authored challenge content, captured model investigations and deterministic browser verdicts. This page is a map to inspectable evidence, not a claim of broad agent reliability.

## Five playable seed cases

Each seed has a real buggy/fixed React pair, an authored initial action plan, a controlled response schedule and a frozen assertion. The local capture includes three consecutive buggy failures and three fixed passes, plus the exported regression failing buggy and passing fixed.

| Case | Defect | Captured local evidence |
| --- | --- | --- |
| Disappearing note | A stale state snapshot overwrites a note added during sync | [Summary](../evidence/seeds/lost-note/summary.json) |
| Optimistic rollback | An older failed request overwrites a newer successful rename | [Summary](../evidence/seeds/rollback/summary.json) |
| Search responses | An older response replaces results for the current query | [Summary](../evidence/seeds/search/summary.json) |
| Duplicate submission | A second click is accepted while the first order is pending | [Summary](../evidence/seeds/duplicate/summary.json) |
| Effect cleanup | A response from the previous project updates the next view | [Summary](../evidence/seeds/cleanup/summary.json) |

These plans are labeled `authored-seed-plan`, with zero model calls. They are useful teaching fixtures and a deterministic baseline, not model discovery evidence.

The same five source pairs were also verified on the guarded Modal VM runtime: 30 runs, 15 buggy assertion failures and 15 fixed passes. [Runtime summary](../proof/runtime-summary.json).

## Two genuine Muse investigations

Meta Muse Spark Open proposals actually drove these browser runs through the user-selected Modal Shared Endpoint. Each record connects input frame hashes and timestamps, source hashes, model configuration, proposed actions, executed actions and observed assertions.

| Measurement | Known-note investigation | Separate coupon investigation |
| --- | --- | --- |
| Scope | One known gallery seed through upload intake | One first-party app frozen outside gallery/planner examples |
| Actions, initial → minimized | 4 → 3 | 3 → 2 |
| Final buggy outcomes | 3 assertion failures / 3 trials | 3 assertion failures / 3 trials |
| Final fixed outcomes | 3 passes / 3 trials | 3 passes / 3 trials |
| Browser executions including probes | 16 | 14 |
| Elapsed pipeline time | 276.552 seconds | 270.751 seconds |
| Model calls | 1 | 1 |
| Input / output tokens | 1,918 / 921 | 2,164 / 1,799 |
| Estimated model cost | $0.00631175 | $0.01035075 |
| Explore | [Playable proof](../proof/index.html), [summary](../proof/live/summary.public.json), [provenance](../proof/live/provenance.public.json) | [Playable proof](../proof/heldout/index.html), [summary](../proof/heldout/summary.public.json), [provenance](../proof/heldout/provenance.public.json) |

Costs are model-only estimates from reported tokens and configured rates, not invoices or total sandbox costs. Final 3/3 rates describe the accepted schedule after minimization. They are not the success rate of every attempt, probe or possible response order. The summaries retain rejected/infrastructure outcomes separately; timeouts and incomplete workflows never count as successful reproductions.

The coupon input contained no action plan, hints or explanation. It was held out from this pipeline's gallery examples, not from model training, and is not an independent external benchmark. Two successful investigations do not establish generalization to arbitrary apps.

The minimized trace is a bounded deletion result, not proof of a globally shortest sequence. The assertion and completion checkpoint remain unchanged throughout minimization.

## Exact regression tests

For both live investigations, the identical exported test failed against the buggy source and passed against the fixed source in further Modal sandboxes:

- Note: [test](../proof/live/regression.test.mjs), [buggy output](../proof/live/regression-buggy.tap), [fixed output](../proof/live/regression-fixed.tap).
- Coupon: [test](../proof/heldout/regression.test.mjs), [buggy output](../proof/heldout/regression-buggy.tap), [fixed output](../proof/heldout/regression-fixed.tap).

Uploaded-app tests require the authorized sandbox and explicit submitted-project directory; they do not silently fall back to a seed. Do not remove those guards to run untrusted source on the host.

The current guarded-runtime cohort independently verified the exact exported regression with buggy exit 1 and fixed exit 0. [Runtime summary](../proof/runtime-summary.json).

## Runtime boundaries

Six live controls passed: attributed workload memory exhaustion, manual-kill negative control, timeout negative control, readiness failure, cancellation and provider TTL. Memory attribution combines exact kernel memcg/leaf/victim identity with local OOM counters and a surviving protected observer. All 38 VMs in the verified cohort have terminal evidence.

An earlier inconclusive outer-memory exit, failed cleanup attempt and metadata timeout remain preserved as unsuccessful historical attempts. Recovery reused completed browser results under a separately bound manifest and ran only the remaining trials. The public [runtime derivative](../proof/runtime-summary.json) contains bindings, source hashes, schedules, result hashes and limitations while omitting private account identifiers.

## Local test coverage

The public checkout was installed into fresh Node and Python dependency directories and checked on November 3, 2026:

| Check | Result |
| --- | --- |
| Python | 360 passed |
| Worker | 16 passed |
| Progress and evidence contracts | 33 passed |
| Portable browser suite | 39 passed |
| Lint, TypeScript and production build | Passed |

[Validation details](../proof/local-checks.json) · [Python output](../proof/fresh-python.txt) · [Worker output](../proof/fresh-worker.txt) · [Logic output](../proof/fresh-logic.txt) · [Browser output](../proof/fresh-browser.txt) · [Build output](../proof/fresh-build.txt).

The browser suite covers the player journey, real local recorded jobs, duplicate requests, cancellation, uploads, failed startup, missing evidence, keyboard interaction, mobile layouts and reduced motion. The private-capture investigation UI test remains a maintainer-only check; it is excluded from the documented portable command. Offline evidence-contract tests use sanitized captures included in `tests/fixtures`.

These checks made no model or cloud requests. The original staged Python receipt remains available as [a dated source-bound record](../proof/staged-core-tests.public.json). [Run the checks yourself](GETTING_STARTED.md#run-checks).

## Static arcade verification

The hosted build passed nine browser checks at a local project prefix and nine with its intended HTTPS origin simulated from local files. All five cases produced three buggy failures and three fixed passes in each environment. The local run also verified an actual downloaded regression file. The HTTPS simulation checked those bytes with browser fetch; the public download is checked after deployment.

Local workflow and motion coverage passed 40 checks, worker and cartridge coverage passed 21, and logic coverage passed 36. No model or cloud calls were made. [Source-bound results and logs](../proof/hosted/verification.json) · [Hosted setup and boundaries](HOSTED_DEMO.md). These are preparation checks; they do not establish a deployed URL.

## How to interpret the demo and package

The [three-minute demo](../proof/demo.mp4) edits actual browser captures with Deepgram narration and authored chapter captions. It is neither a continuous recording nor a new live model run. The first 87 seconds preserve the original narration, with a visible correction to the historical spoken status. The remaining caption-led tour shows model actions, regression results and the current guarded runtime. [Video notes](../proof/demo-README.md) describe the edit.

`package-manifest.json` hashes the current public payload; it excludes itself and `package-audit.json` to avoid circular hashes. Dated review manifests under `review-snapshot/` describe the earlier review ZIP. Public-safe derivatives retain original artifact hashes where private endpoint/account data was removed. See the root transformation receipts for the exact release changes.

The browser verifier decides whether a bug reproduced and a fix passed. Captured playback, model rationale, personal stars and screenshots alone do not make that decision.
