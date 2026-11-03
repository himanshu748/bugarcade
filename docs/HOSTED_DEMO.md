# Hosted arcade

The static arcade lets players explore all five real bugs, reveal each sequence, replay the same actions against the fix and download the captured regression evidence. It uses the same React apps, personal stars and response controls as the local arcade.

The online version accepts no uploads and starts no investigation jobs or model calls. **Create a challenge** opens the local creator setup. **Inspect the Meta case** opens the portable record of an actual Muse investigation.

## Build

Use a reviewed public source checkout containing `proof/index.html` and a current `package-manifest.json`. The evidence builder verifies the allowlisted files against that manifest before copying them.

```sh
VITE_PUBLIC_DEMO=true BUGARCADE_PUBLIC_BASE=/bugarcade/ npm run build
node scripts/build-public-demo.mjs --out dist-hosted --parent-origin https://himanshu748.github.io --evidence-root .
```

`dist-hosted/` contains the static site, ten prebuilt buggy/fixed cartridges, captured evidence, portable proof pages and `.nojekyll`. It is separate from the normal `dist/` output. Neither command publishes anything.

For a local preview at the same project prefix:

```sh
VITE_PUBLIC_DEMO=true BUGARCADE_PUBLIC_BASE=/bugarcade/ npm run build -- --outDir .data/hosted-preview/bugarcade
node scripts/build-public-demo.mjs --out .data/hosted-preview/bugarcade --dev-loopback --evidence-root .
python3 -m http.server 4185 --bind 127.0.0.1 --directory .data/hosted-preview
```

Open `http://127.0.0.1:4185/bugarcade/`. The preview needs no API server or proxy.

## Boundaries

Each app runs in a scripts-only iframe with an in-memory API simulator and outbound connections disabled by its CSP. A hosted cartridge accepts only its configured HTTPS parent origin. The local preview preserves the existing loopback binding. Browser playback provides immediate game feedback; the independent captured worker assertions remain the verification record.

Only the five trusted prebuilt fixtures are included. This mode does not execute submitted code or provide Modal sandbox isolation. Source, frozen assertions, exported tests and captured traces remain available in the evidence downloads.

GitHub Pages is the proposed destination for the existing public repository. It supports static sites in public repositories on GitHub Free ([official documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)). Deployment and adding the URL to the saved entry require the user's explicit authorization.

## Verification

With the static preview running:

```sh
BUGARCADE_EXISTING_SERVERS=1 BUGARCADE_HOSTED_DEMO=1 BUGARCADE_BASE_URL=http://127.0.0.1:4185/bugarcade/ npx playwright test tests/e2e/hosted.spec.ts
```

The same suite can verify a deployed URL. For pre-deployment HTTPS checks, `BUGARCADE_STATIC_ARTIFACT_DIR` serves a local artifact through intercepted browser requests at the configured origin. Those checks are labeled origin simulation; they do not establish that a public deployment exists.

## Acceptance

- [x] Five actual buggy/fixed pairs play correctly under their recorded schedules. [30 real playback trials per environment](../proof/hosted/verification.json).
- [x] Reset, replay, hints, personal scoring and navigation remain usable. [Static browser checks](../proof/hosted/static-browser.txt) and [local workflow checks](../proof/hosted/local-workflows.txt).
- [x] Desktop, mobile, keyboard and reduced-motion browser checks pass. [Static browser checks](../proof/hosted/static-browser.txt), [motion checks](../proof/hosted/motion.txt) and [mobile capture](../proof/hosted/mobile.png).
- [x] A project base path resolves all images, cartridges and evidence downloads. [Static browser checks at /bugarcade/](../proof/hosted/static-browser.txt).
- [x] Create/job routes explain the local workflow and issue no API writes. [Read-only route and network checks](../proof/hosted/static-browser.txt).
- [x] Captured Meta proof and exported tests remain accessible and unchanged. [Proof playback and exact downloaded-test hash checks](../proof/hosted/static-browser.txt).
- [x] Exact HTTPS parent binding passes; foreign and rebind attempts fail. [Worker checks](../proof/hosted/worker.txt) and [simulated HTTPS UI checks](../proof/hosted/https-origin-simulation.txt).
- [x] Existing local app and worker regression checks still pass. [40 local browser checks](../proof/hosted/verification.json) and [21 worker checks](../proof/hosted/worker.txt).
- [x] Output contains no secrets, backend processes, upload API or provider requests. [Prepared artifact scan](../proof/hosted/artifact-review.json) and [static network checks](../proof/hosted/static-browser.txt); scan limits are recorded.
- [ ] BLOCKED: deployment needs explicit authorization for the tested build.
- [ ] NOT TESTED: public URL and submission-link readback require deployment.

Checks cite actual commands, browser captures or artifacts. The original implementation checklist is a separate record.
