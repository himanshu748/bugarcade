import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { buildCartridge, validateHostedParentOrigin } from '../worker/cartridge.mjs';
import { ROOT } from '../worker/server.mjs';
import { buildPublicDemo } from '../scripts/build-public-demo.mjs';

const HOST = 'https://arcade.example.test';
const sha = value => createHash('sha256').update(value).digest('hex');
const tempRoot = async () => {
  await mkdir(path.join(ROOT, '.data'), { recursive: true });
  return mkdtemp(path.join(ROOT, '.data/public-cartridge-test-'));
};

async function fixtureManifest(root, entries) {
  await mkdir(root, { recursive: true });
  const files = {};
  for (const [name, raw] of Object.entries(entries)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), raw);
    files[name] = { bytes: Buffer.byteLength(raw), sha256: sha(raw) };
  }
  await writeFile(path.join(root, 'package-manifest.json'), JSON.stringify({ kind: 'current-publication-release-manifest', version: 2, files }));
}

test('hosted parent is an exact canonical HTTPS origin, never a URL pattern or app input', async () => {
  for (const origin of [HOST, 'https://himanshu748.github.io', 'https://arcade.example.test:8443']) assert.equal(validateHostedParentOrigin(origin), origin);
  for (const origin of [undefined, null, {}, '', '*', 'null', 'http://arcade.example.test', 'http://127.0.0.1:4185', 'https://*.example.test', 'https://arcade.example.test/', 'https://arcade.example.test/path', 'https://arcade.example.test?x=1', 'https://arcade.example.test#hash', 'https://user:secret@arcade.example.test', 'https://ARCADE.example.test', 'https://arcade..test', 'https://-arcade.test', 'https://arcade.example.test:443', 'javascript:alert(1)']) {
    assert.throws(() => validateHostedParentOrigin(origin));
  }
  await assert.rejects(buildCartridge({ challengeId: 'lost-note', variant: 'buggy', projectDir: path.join(ROOT, 'fixtures/lost-note'), parentOrigin: HOST }), /shipped seed/);
});

test('hosted cartridge binds its configured real HTTPS parent once and refuses foreign or loopback parents', { timeout: 40_000 }, async () => {
  const html = await buildCartridge({ challengeId: 'lost-note', variant: 'buggy', parentOrigin: HOST });
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    for (const origin of [HOST, 'https://foreign.example.test', 'http://127.0.0.1:4185']) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const network = [];
      await page.route('**/*', route => {
        network.push(route.request().url());
        return route.request().url() === `${origin}/parent`
          ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }) : route.abort();
      });
      await page.goto(`${origin}/parent`);
      await page.evaluate(html => {
        const frame = document.createElement('iframe'); frame.id = 'cartridge'; frame.sandbox = 'allow-scripts'; frame.srcdoc = html;
        window.states = []; window.addEventListener('message', event => { if (event.source === frame.contentWindow) window.states.push(event.data); });
        document.body.append(frame);
      }, html);
      const child = page.frames().find(frame => frame.parentFrame() !== null);
      await child.waitForLoadState('load');
      await child.locator('#app-root').waitFor({ state: 'attached' });
      await child.evaluate(host => {
        window.dispatchEvent(new MessageEvent('message', { source: window, origin: host, data: { type: 'bugarcade:bind-parent' } }));
        window.parentBindObserved = new Promise(resolve => {
          const seen = event => { if (event.source === window.parent && event.data?.type === 'bugarcade:bind-parent') { window.removeEventListener('message', seen); resolve(); } };
          window.addEventListener('message', seen);
        });
      }, HOST);
      assert.equal(await child.getByTestId('sync').count(), 0);
      await page.evaluate(() => document.getElementById('cartridge').contentWindow.postMessage({ type: 'bugarcade:bind-parent' }, '*'));
      await child.evaluate(() => window.parentBindObserved);
      if (origin === HOST) {
        await child.getByTestId('sync').click();
        await expect.poll(() => page.evaluate(() => window.states.some(state => state.ready && state.moves === 1))).toBe(true);
        assert.equal(await child.evaluate(() => window.__BUGARCADE_CONFIG__.parentOrigin), HOST);
        await child.evaluate(() => window.dispatchEvent(new MessageEvent('message', { source: window.parent, origin: 'https://foreign.example.test', data: { type: 'bugarcade:bind-parent' } })));
        assert.equal(await child.evaluate(() => window.__BUGARCADE_CONFIG__.parentOrigin), HOST);
      } else assert.equal(await child.getByTestId('sync').count(), 0);
      assert.deepEqual(network, [`${origin}/parent`]);
      await context.close();
    }
  } finally { await browser.close(); }
});

test('the existing standalone cartridge still mounts on HTTPS without a parent handshake', { timeout: 20_000 }, async () => {
  const html = await buildCartridge({ challengeId: 'lost-note', variant: 'buggy' });
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    const page = await browser.newPage();
    await page.route(`${HOST}/standalone`, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(`${HOST}/standalone`);
    await page.getByTestId('sync').click();
    await page.getByTestId('add-note').click();
    await page.getByTestId('release-save-1').click();
    await expect(page.getByTestId('notes')).not.toContainText('Book the demo slot');
  } finally { await browser.close(); }
});

test('public builder emits ten hash-bound cartridges and copies only reviewed public assets', { timeout: 40_000 }, async () => {
  const root = await tempRoot();
  try {
    const evidence = path.join(root, 'reviewed');
    const out = path.join(root, 'site');
    await mkdir(path.join(out, 'assets'), { recursive: true });
    await writeFile(path.join(out, 'assets/app.js'), 'existing Vite asset');
    await fixtureManifest(evidence, {
      'proof/index.html': '<!doctype html><p>Explicit synthetic packaging fixture</p>',
      'proof/heldout/index.html': '<p>Packaging fixture only</p>',
      'docs/JUDGE_GUIDE.md': '# Packaging fixture',
      'third-party/react/LICENSE': 'Test license placeholder',
      'evidence/seeds/lost-note/summary.json': '{"syntheticPackagingFixture":true}',
      'LICENSE': 'Test license placeholder',
      'transformation-receipt.json': '{}',
      'backend/private.txt': 'excluded non-public root',
      '.data/private.txt': 'excluded workspace root',
    });
    await writeFile(path.join(evidence, 'package-audit.json'), '{"kind":"synthetic-test-audit"}');
    const catalog = await buildPublicDemo({ outDir: out, parentOrigin: HOST, evidenceRoot: evidence });
    assert.equal(catalog.kind, 'static-seed-playback'); assert.equal(catalog.parentOrigin, HOST); assert.equal(catalog.modelCalls, 0);
    assert.equal(catalog.challenges.length, 5); assert.equal(Object.keys(catalog.fixtures).length, 5);
    for (const [id, variants] of Object.entries(catalog.fixtures)) for (const variant of ['buggy', 'fixed']) {
      const record = variants[variant]; const raw = await readFile(path.join(out, record.url));
      assert.equal(record.sha256, sha(raw));
      assert.equal(record.sourceSha256, sha(await readFile(path.join(ROOT, 'fixtures', id, variant, 'App.tsx'))));
    }
    for (const name of ['proof/index.html', 'docs/JUDGE_GUIDE.md', 'third-party/react/LICENSE', 'LICENSE', 'package-manifest.json', 'package-audit.json', 'transformation-receipt.json']) {
      assert.deepEqual(await readFile(path.join(out, name)), await readFile(path.join(evidence, name)));
    }
    assert.deepEqual(await readFile(path.join(out, '_demo/evidence/seeds/lost-note/summary.json')), await readFile(path.join(evidence, 'evidence/seeds/lost-note/summary.json')));
    await assert.rejects(readFile(path.join(out, 'backend/private.txt')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(out, '.data/private.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(out, 'assets/app.js'), 'utf8'), 'existing Vite asset');
    assert.equal((await readFile(path.join(out, '.nojekyll'))).length, 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(out, '_demo/catalog.json'), 'utf8')), catalog);
    assert.ok((await readFile(path.join(out, '_demo/catalog.json'))).byteLength <= 64000);
    const index = await readFile(path.join(out, catalog.artifactIndex.url));
    assert.equal(sha(index), catalog.artifactIndex.sha256);
    assert.equal(JSON.parse(index).files['proof/index.html'].sha256, sha(await readFile(path.join(out, 'proof/index.html'))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('public builder fails closed on missing authorization, unsafe metadata, changed bytes and symlinks', { timeout: 30_000 }, async () => {
  const root = await tempRoot();
  try {
    const out = path.join(root, 'site');
    await assert.rejects(buildPublicDemo({ outDir: out }), /exact HTTPS parent/);
    await assert.rejects(buildPublicDemo({ outDir: ROOT, devLoopback: true }), /generated directory/);
    await assert.rejects(buildPublicDemo({ outDir: out, devLoopback: true, parentOrigin: HOST }), /Choose/);
    const evidence = path.join(root, 'reviewed');
    await fixtureManifest(evidence, { 'proof/index.html': 'reviewed bytes' });
    await writeFile(path.join(evidence, 'proof/index.html'), 'changed bytes');
    await assert.rejects(buildPublicDemo({ outDir: out, parentOrigin: HOST, evidenceRoot: evidence }), /hash changed/);
    await fixtureManifest(evidence, { 'proof/index.html': 'reviewed bytes' });
    const manifestPath = path.join(evidence, 'package-manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.files['proof/../../private.txt'] = { bytes: 0, sha256: sha('') };
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(buildPublicDemo({ outDir: out, parentOrigin: HOST, evidenceRoot: evidence }), /Unsafe public artifact/);
    await fixtureManifest(evidence, { 'proof/index.html': 'reviewed bytes' });
    await rm(path.join(evidence, 'proof/index.html'));
    await writeFile(path.join(root, 'outside.txt'), 'reviewed bytes');
    await symlink(path.join(root, 'outside.txt'), path.join(evidence, 'proof/index.html'));
    await assert.rejects(buildPublicDemo({ outDir: out, parentOrigin: HOST, evidenceRoot: evidence }), /without symlinks/);
    const symlinkOut = path.join(root, 'linked-output');
    await mkdir(path.join(root, 'other')); await symlink(path.join(root, 'other'), symlinkOut);
    await assert.rejects(buildPublicDemo({ outDir: symlinkOut, devLoopback: true }), /symlinks/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
