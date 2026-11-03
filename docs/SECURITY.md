# Security boundaries and operating limits

BugArcade is a loopback, single-user developer workbench for explicitly authorized small React apps. It is not a public multi-tenant service. Keep FastAPI on `127.0.0.1`, run one backend worker, and use non-sensitive examples. Host and Origin checks are defense in depth, not authentication against other local software.

## Input boundary

The [Starter v1 contract](STARTER.md) accepts only `manifest.json`, `buggy/App.tsx`, `fixed/App.tsx` and optional `README.md`. The ZIP adapter rejects traversal, absolute paths, backslashes, symlinks, encryption, duplicates, unknown files and excessive expansion before writing source. Archive limits are 256 KiB compressed and 400 KiB expanded; each component is at most 64 KiB.

Recordings are MP4/WebM, at most 20 MiB and 30 seconds, with one video stream and maximum 3840×2160 dimensions. The total HTTP body ceiling is 21 MiB. A separate bounded PyAV process decodes four small frames using a restricted file/pipe protocol set. Linux adds address-space/process bounds; those two limits are not claimed on macOS. Native media decoding remains an attack surface.

Only React imports are supported. Submitted package scripts, dependency installs and arbitrary repositories are outside the interface. Import checks are compatibility gates; runtime confinement is the security boundary.

## Execution boundary

Uploaded source executes in Modal, never in the local development runner. Dependencies are pinned and prebuilt. Sandboxes receive no provider secrets, host mounts, user cookies, production accounts or unrelated repositories. External egress is disabled; the browser may reach only its app and controlled mock API on sandbox loopback. Service workers, WebSockets and downloads are blocked by the worker.

The verified guarded VM configuration uses an outer 2 GiB Modal VM and a private 1 GiB workload cgroup with swap disabled. A root-owned observer stays outside the workload; execution uses a non-root UID, no capabilities and no-new-privileges. A handshake checks membership and denial of cgroup escape, protected receipt access and kernel-log writes before processing source. Immutable inputs and resource receipts bind results to the reviewed guard.

| Control | Reviewed bound or behavior |
| --- | --- |
| CPU | 1 physical core requested, 2 maximum by provider soft throttling; separate 40 CPU-seconds per-process limit |
| Memory | 1 GiB workload cgroup inside a 2 GiB VM, swap disabled |
| Processes | Hard 256-task limit; EAGAIN mechanism verified with a lower soft limit |
| Sandbox lifetime | 45 seconds per run; bounded termination in `finally` paths |
| Output | 1 MiB stdout; 8 MiB per file; bounded evidence inventory and 24 MiB expanded export |
| Network | External egress disabled; sandbox app/simulator loopback only |

Six live boundary controls cover attributed memory exhaustion, manual kill, timeout, failed readiness, cancellation and provider TTL. The [public runtime summary](../proof/runtime-summary.json) records the exact configuration and terminal evidence for the 38-VM verified cohort. The older ambiguous exit 137 and failed orchestration attempts remain historical failures, not memory-proof successes.

These trials do not constitute a sandbox security certification. No per-directory disk quota, full 256-process saturation trial or general arbitrary-code safety guarantee is claimed. A provider outage or backend crash can prevent immediate cleanup confirmation; provider TTL is a fallback, not confirmation that termination already succeeded.

## Model and credential boundary

All provider calls run in the trusted backend. Baseten keys and Modal SDK/proxy tokens must never use a `VITE_` prefix or enter source, prompts, browser state, sandbox images or regression tests. Source, recordings, hints and model output are untrusted data. Strict schemas allow only declared targets and the supported action vocabulary; model text is never evaluated as code.

Live execution starts disabled. It additionally requires existing credentials, an immutable prebuilt image, approved budget, conservative rates and explicit environment switches. The backend limits calls, tokens, concurrency and runtime, and persists reservations before dispatch. Provider pricing, billing granularity, other workloads and unknown timeout usage prevent those controls from being a hard invoice cap. Credits are not a spending cap.

## Evidence, playback and privacy

SQLite and `.data/` retain local uploads and job state. Traces, screenshots and recordings may reveal source or entered content. Retention is manual. Review the entire export before publication; never upload personal data or credentials as a bug example.

Artifacts are served from fixed roots with extension restrictions, attachment disposition and a restrictive CSP. Transfer validation rejects unsafe archive members and verifies bounded inventory, sizes and hashes before installation. Hashes establish transport integrity, not a bug verdict.

Embedded cartridges use a scripts-only opaque iframe and restrictive document CSP. This protects the parent browsing context but is not equivalent to process or network isolation; browser self-frame navigation may still be possible. Player feedback and editable browser-local stars are not security attestations. Client-side hints and fixes are visible to inspection; spoiler management is not secrecy.

A dishonest app can render the expected DOM without performing its claimed operation. The verifier tests the declared observable assertion, not the semantic honesty of adversarial source. Three repetitions under one response schedule establish repeatability only for that schedule.

## Before running a new live investigation

Confirm authorization to execute the source and send source/frames to the selected provider. Review the starter manifest, frozen assertion, provider/model identity, prebuilt image and limits. Keep credentials in the trusted backend, use non-sensitive data and a finite approved budget, and check termination receipts afterward. The default arcade experience needs none of these live-provider steps.

## Development toolchain

The pinned ESLint toolchain inherits the moderate [minimatch glob-pattern denial-of-service advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249). `npm audit` reports the affected development dependency chain; `npm ls minimatch --omit=dev` is empty. Keep linting limited to reviewed project files. Dependency upgrades require a deliberate compatibility check; avoid `npm audit fix --force` on the pinned verification environment.
