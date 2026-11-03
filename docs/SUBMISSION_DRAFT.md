# BugArcade — submission copy

**Can you make this app lose your note in three moves?**

Prepared for the Indie Developer track, Build for Your World.

Public source: [himanshu748/bugarcade](https://github.com/himanshu748/bugarcade) · [Demo video](https://github.com/himanshu748/bugarcade/blob/main/proof/demo.mp4)

## Project description

Can you make this app lose your note in three moves? BugArcade turns a real React bug into a playable challenge, a reproducible replay and a regression test that proves the fix.

A screen recording shows what broke, but rarely captures the exact actions and response order needed to reproduce it. Catch the bug yourself, reveal the minimal timeline and cause, then run the same actions against the fixed app. Keep the executable test, browser trace, screenshots and deterministic API schedule. Five playable cases cover lost state, optimistic rollback, stale search, duplicate submission and cleanup races. Stars reward catching the bug, meeting the move target and checking the fix.

For supported uploaded React/TypeScript starters, Meta Muse Spark Open interprets source and timestamped recording frames and proposes browser actions. Those actions drive Playwright in Modal; an independent verifier decides success. In a captured known-note investigation, four proposed actions became three. A separate first-party coupon case supplied no plan or hints: three actions became two. Both produced three buggy failures and three fixed passes; each exact exported test independently failed buggy and passed fixed. The five gallery plans are authored and separately labeled.

Built during the hackathon, October 28–November 3, 2026: the React arcade, five buggy/fixed apps, FastAPI job pipeline, recording extraction, structured planner, bounded execution, assertion-preserving minimizer, artifact packaging, regression verifier and guarded Modal runtime. All five current-runtime seed pairs passed their 3+3 checks. The creator supports small React/TypeScript apps through a documented starter. Public MIT source, setup, captured proof and demo are in the repository.

## Use of Meta products

Muse Spark Open plans BugArcade's browser investigations. It reads the buggy React source and timestamped frames from the user's recording, then proposes actions and a failure assertion. The backend validates the proposal and executes its actions in Playwright. Browser results guide reproduction, minimization and the final buggy/fixed check.

We ran Muse Spark Open through Modal's Shared Endpoint. In the note investigation, its four proposed actions became a three-move replay. For a separate coupon app, Muse received no witness plan or reproduction hints; its three proposed actions became two. Both investigations produced three buggy failures and three fixed passes, followed by the exact exported regression test failing buggy and passing fixed.

The implementation connects each accepted model proposal to executed actions, screenshots, traces and test results. The intended assertion stays fixed throughout, and model calls run in the trusted backend outside the submitted app's sandbox.

## Why Meta matters

The difficult step is translating incomplete recording evidence and unfamiliar stateful code into a browser experiment worth running. Muse Spark Open reasons over both source and sampled visual evidence, proposes concrete actions and explains a plausible failure. That turns a bug report into an executable hypothesis.

BugArcade closes the loop with evidence: execute the hypothesis, reject infrastructure errors, reproduce it repeatedly, remove unnecessary moves and run the unchanged assertion against the fix. The captured coupon case demonstrates a decision beyond the authored gallery: the model chose coupon actions without receiving the witness plan. Meta's reasoning enables the investigation; deterministic verification makes the result inspectable.

## Partner technology feedback

Modal let us use the same provider for Muse Spark Open inference and isolated Playwright execution. Its OpenAI-compatible endpoint fit our structured planner, while prebuilt sandbox images kept browser dependencies reproducible. The most demanding integration work was reliable lifecycle handling: readiness failures, cancellation, timeouts and distinguishing a genuine workload OOM from manual termination. Explicit cleanup and a protected runtime observer made those outcomes inspectable. Clearer end-to-end examples covering endpoint authentication and sandbox failure attribution would have shortened setup.

## Entry details

- Team: BugArcade; solo entrant Himanshu Kumar (himanshu748).
- Required product-opinion answers: Somewhat likely / Somewhat favorable, selected by the entrant.
- Optional personal surveys and X promotion link are left blank.
- Submission status: prepared; final portal confirmation is pending.
