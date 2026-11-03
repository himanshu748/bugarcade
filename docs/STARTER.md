# Starter v1 contract

BugArcade accepts explicitly authorized small React/TypeScript apps. It does not clone or inspect arbitrary repositories. The ZIP is declarative input; no submitted build scripts, package manifests or installs execute.

Download `http://127.0.0.1:8000/api/starter` while the backend is running. The generated example uses the actual lost-note pair. ZIP structure:

```text
manifest.json
buggy/App.tsx
fixed/App.tsx
README.md             # optional
```

Directory entries for `buggy/` and `fixed/` are optional. Rejects traversal, absolute paths, Windows separators, symlinks, encrypted ZIPs, duplicate/unknown files, unsupported imports and excessive compression ratios. ZIP limit 256 KiB; expanded total 400 KiB. Recording is a separate upload (MP4/WebM, 20 MiB, at most 30 seconds). The aggregate HTTP body ceiling is 21 MiB.

## App interface

```tsx
import { useState } from 'react';
type API = { request(key: string, payload?: unknown): Promise<unknown> };
export default function App({ api }: { api: API }) {
  const [message, setMessage] = useState('Idle');
  async function save() {
    setMessage('Pending');
    await api.request('save', { value: 'example' });
    setMessage('Saved');
  }
  return <>
    <button data-testid="save" onClick={save}>Save</button>
    <p data-testid="status">{message}</p>
  </>;
}
```

Use React imports only (`react`, `react/jsx-runtime`). The worker bundles both variants using preinstalled esbuild and React. CSS is the bundled starter stylesheet. Custom assets, imports, relative modules, app routing requiring a server, external dependencies and SSR are outside v1.

## Manifest

The generated sample is the authoritative schema example. Fields:

- `id`, `title`, `goal`: bounded identifying text.
- `allowedTargets`: stable unique `data-testid` strings for controls/observables.
- `actions`, optional `initialActions`: known replay for seed mode; for new live investigations the model proposes the actions.
- `assertion`: `{target, operator: 'equals'|'contains'|'count', expected}` describing correct behavior.
- `completion`: `{target,value}` that proves the relevant workflow completed before evaluation. It must not require the same value as the invariant; otherwise a bug could never reach the checkpoint.
- `schedule`: ordered entries `{id,key,status,response}`. Each request consumes the next unused entry matching its key. Release order is explicit in browser actions and may differ from request order.

Supported actions:

```json
[
  {"type":"fill","target":"query","value":"react"},
  {"type":"click","target":"save"},
  {"type":"release","request":"save-1"},
  {"type":"wait","target":"status","value":"Saved"}
]
```

A click/fill targets a declared test ID. A release names a scheduled request. A wait synchronizes with observable state. No custom JavaScript, shell, network URLs, navigation or raw selectors are accepted. The verifier evaluates the frozen invariant after completion and records the exact schedule and executed actions. Removing a necessary action produces an invalid candidate, never a reproduced bug.

## Trust and limits

Authorization must cover execution and sending source/recording frames to the configured provider. Do not upload credentials, personal data or unrelated source. Uploaded apps run only in the configured Modal Sandbox, never on the local runner. The creator supplies the fixed counterpart; BugArcade tests it but does not claim that three runs prove all possible interleavings safe. A deliberately dishonest app can render misleading DOM; the tool tests observable behavior, not the honesty of submitted code.
