import test from 'node:test';
import assert from 'node:assert/strict';
import { assetUrl, staticApiUrl } from '../frontend/public-demo.ts';

test('static assets and captured evidence keep the project base path', () => {
  assert.equal(assetUrl('/product/lost-note.png', '/bugarcade/'), '/bugarcade/product/lost-note.png');
  assert.equal(staticApiUrl('/api/challenges/lost-note/evidence', '/bugarcade/'), '/bugarcade/_demo/evidence/seeds/lost-note/summary.json');
  assert.equal(staticApiUrl('/api/artifacts/search/fixed-1/trace.zip', '/bugarcade/'), '/bugarcade/_demo/evidence/seeds/search/fixed-1/trace.zip');
});
test('only shipped seed evidence can become a static request', () => {
  for (const url of ['/api/health', '/api/jobs', '/api/jobs/fake', '/api/projects', '/api/challenges/uploaded/evidence', '/api/artifacts/uploaded/source.zip']) assert.throws(() => staticApiUrl(url));
});
test('encoded, absolute and traversal asset paths cannot escape the static root', () => {
  for (const path of ['../secret', 'proof/../../secret', 'proof//secret', 'proof/%2e%2e/secret', 'https://example.invalid/file', 'proof\\secret']) assert.throws(() => assetUrl(path));
  for (const base of ['https://example.invalid/', '//example.invalid/', '/bugarcade/../', '/bugarcade']) assert.throws(() => assetUrl('proof/index.html', base));
  assert.throws(() => staticApiUrl('/api/artifacts/lost-note/../secret'));
});
