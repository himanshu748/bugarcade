# BugArcade — submission copy

Indie Developer Track · Build for Your World

- Live arcade: [himanshu748.github.io/bugarcade](https://himanshu748.github.io/bugarcade/)
- Repository: [himanshu748/bugarcade](https://github.com/himanshu748/bugarcade)
- Three-minute demo: [Watch on YouTube](https://youtu.be/RnbcI01d7oE)

## Two-sentence pitch

Can you make this app lose your note in three moves? BugArcade turns real React bugs into playable challenges with a reproducible replay and a regression test that proves the fix.

## How Muse Spark Open is used

Muse Spark Open reads supported React/TypeScript source and timestamped recording frames, then proposes browser actions and a candidate failure assertion. The trusted backend validates those proposals and runs the actions through Playwright in Modal; the deterministic verifier decides whether the bug reproduces and the fix passes. Captured note and coupon investigations connect the model's proposals to executed actions, traces and regression results. We used Muse Spark Open through Modal's Shared Endpoint. The public arcade plays five authored seed cases and captured evidence without making new model calls.
