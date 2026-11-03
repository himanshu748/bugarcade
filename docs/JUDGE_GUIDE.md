# Experience BugArcade

**Can you make this app lose your note in three moves?**

BugArcade turns a frustrating bug report into something you can play, understand and prevent. A developer brings a small React app and a short recording. Meta Muse Spark Open proposes an experiment; the browser executes it; BugArcade packages the reproducible failure as a challenge, replay and regression test.

## Start with the disappearing note

Run the app using the [setup guide](GETTING_STARTED.md), or download the repository and open [the portable note investigation](../proof/view.html) locally in your browser.

1. Play Papertrail and try to lose the newly added note in three moves.
2. Reveal the cause and minimal action timeline.
3. Run the same moves against the fixed app. The note survives.
4. Inspect the exported regression test and its buggy/fixed output.

The five-case gallery also covers optimistic rollback, stale search, duplicate submission and cleanup races. Hints and reset make the cases approachable; stars reward the catch, move target and fix check.

## See where Meta made a decision

The [note investigation](../proof/view.html) connects Muse's actual proposal to executed actions. Four actions became three after browser-verified minimization. Three buggy failures and three fixed passes followed; the exact exported test also failed buggy and passed fixed.

The [separate coupon investigation](../proof/heldout/view.html) shows the planner working without an authored action sequence or hints in its input. Muse chose three actions; minimization retained two. A successful coupon response left the buggy total at $48.00, while the fixed app showed $43.20. Its regression test captures that difference.

The gallery uses authored plans. These two investigations show accepted model proposals driving the executor. The assertion remains fixed, and a deterministic verifier decides the outcome. [Technical evidence and evaluation scope](EVIDENCE.md).

## Watch the demo

[Watch the three-minute walkthrough](../proof/demo.mp4). It leads with the player catching the note bug, then follows the replay, Meta proposal, failing test, fix and passing test. A caption-led evidence tour shows the separate coupon case and the guarded runtime. The original Deepgram narration and actual browser captures are identified in the [video notes](../proof/demo-README.md).

## What was built during the hackathon

Between October 28 and November 3, 2026, the project added the React arcade and five buggy/fixed fixtures, recording extraction, Muse planner, Playwright executor, controllable API, immutable assertion engine, minimizer, persistent job orchestration, challenge packaging and guarded Modal runtime. These are the original contributions presented in the demo. React, Playwright, FastAPI and other dependencies retain their licenses and attribution.

## Why this workflow matters

A recording is a clue. A reproducible test is something a developer can act on. BugArcade connects the two while making the investigation useful to both the developer fixing the bug and the player learning how it happened.

- **For developers:** an exact action sequence, controlled response order and executable regression test.
- **For learners:** a small app they can break, inspect and compare with the fix.
- **For reviewers:** model decisions linked to browser actions, observations and source hashes.

## Scope

The creator supports explicitly authorized Starter v1 React/TypeScript apps, with a supplied fixed counterpart and controlled API schedule. Live execution needs trusted backend credentials and a finite configured budget; the included arcade and portable proof work without them. [Starter interface](STARTER.md) · [Architecture](ARCHITECTURE.md) · [Security](SECURITY.md).
