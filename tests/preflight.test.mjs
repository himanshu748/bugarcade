import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleReactApp } from '../worker/react-bundler.mjs';
import { ROOT, getManifest } from '../worker/server.mjs';

test('known trusted seed compiles outside repository using pinned React, without executing it', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bugarcade-build-check-'));
  try {
    const appPath = path.join(directory, 'App.tsx');
    // Shipped source only: no submitted or user-private code is executed or compiled here.
    await writeFile(appPath, await readFile(path.join(ROOT, 'fixtures/lost-note/buggy/App.tsx')));
    const entry = `import App from ${JSON.stringify(appPath)}; export {App};`;
    for (const options of [{}, { minify: true, sourcemap: false }]) {
      const bundle = await bundleReactApp({ appPath, entry, ...options });
      assert.ok(bundle.outputFiles[0].contents.length > 1000);
    }
    await writeFile(appPath, "import fs from 'node:fs'; export default fs;");
    await assert.rejects(() => bundleReactApp({ appPath, entry }), /Only React imports/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('external project compilation still requires the sandbox loader guard', async () => {
  const before = process.env.BUGARCADE_SANDBOX;
  delete process.env.BUGARCADE_SANDBOX;
  try { await assert.rejects(() => getManifest('upload', '/tmp/project'), /Modal sandbox/); }
  finally { if (before !== undefined) process.env.BUGARCADE_SANDBOX = before; }
});
