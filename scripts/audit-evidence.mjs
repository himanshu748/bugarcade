import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getChallenges, ROOT } from '../worker/server.mjs';
import { hash, assertionHash, canonical } from '../worker/validation.mjs';
const packages = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const lockfile = await readFile(path.join(ROOT, 'package-lock.json'));
const results = [];
for (const manifest of await getChallenges()) {
  const root = path.join(ROOT, 'evidence', 'seeds', manifest.id);
  const summary = JSON.parse(await readFile(path.join(root, 'summary.json'), 'utf8'));
  assert.equal(summary.verified, true);
  assert.equal(summary.lockfileHash, hash(lockfile));
  for (const [name, version] of Object.entries({ ...packages.dependencies, ...packages.devDependencies })) assert.equal(summary.dependencies[name], version);
  for (const variant of ['buggy', 'fixed']) assert.equal(summary.sourceHashes[variant], hash(await readFile(path.join(ROOT, 'fixtures', manifest.id, variant, 'App.tsx'))));
  assert.equal(summary.assertion.hash, assertionHash(manifest));
  let artifacts = 0;
  for (const variant of ['buggy', 'fixed']) {
    for (let count = 1; count <= 3; count++) {
      const runDir = path.join(root, `${variant}-${count}`);
      const run = JSON.parse(await readFile(path.join(runDir, 'result.json'), 'utf8'));
      assert.equal(run.status, variant === 'buggy' ? 'failed' : 'passed');
      assert.equal(run.assertion.hash, assertionHash(manifest));
      assert.equal(canonical(run.actions.map(event => event.action)), canonical(summary.actions));
      assert.equal(canonical(run.schedule), canonical(manifest.schedule));
      assert.equal(run.seed, manifest.seed ?? 0);
      for (const relative of Object.values(run.artifacts)) {
        if (typeof relative !== 'string') continue;
        const file = path.resolve(runDir, relative);
        assert.ok(file.startsWith(runDir + path.sep));
        const info = await stat(file); assert.ok(info.isFile() && info.size > 0 && info.size <= 8 * 1024 * 1024);
        artifacts++;
      }
    }
    const regression = JSON.parse(await readFile(path.join(ROOT, 'evidence', 'regression-runs', manifest.id, variant, 'result.json'), 'utf8'));
    assert.equal(regression.status, variant === 'buggy' ? 'failed' : 'passed');
    assert.equal(regression.assertion.hash, assertionHash(manifest));
    assert.equal(summary.regressionResults[variant].exitCode, variant === 'buggy' ? 1 : 0);
  }
  const recording = JSON.parse(await readFile(path.join(root, 'recording.json'), 'utf8'));
  assert.equal(recording.synthetic, false);
  for (const frame of recording.frames) {
    assert.ok(frame.timestampMs >= 0 && frame.timestampMs <= recording.durationMs);
    const bytes = await readFile(path.join(root, frame.path));
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
  }
  results.push({ id: manifest.id, buggyFailures: 3, fixedPasses: 3, regressionBuggy: 'failed', regressionFixed: 'passed', sourceHashesMatch: true, assertionHashMatches: true, artifactFilesChecked: artifacts, videoFrames: recording.frames.length, initialActions: summary.initialActionCount, minimizedActions: summary.minimizedActionCount, browserVersion: summary.browserVersion });
}
const audit = { status: 'passed', verifiedAt: new Date().toISOString(), seeds: results, scope: 'Known seed artifacts and hashes. No model or cloud execution.' };
await writeFile(path.join(ROOT, 'evidence', 'seed-evidence-audit.json'), JSON.stringify(audit, null, 2));
process.stdout.write(`Audited ${results.length} seed pairs and ${results.reduce((sum, value) => sum + value.artifactFilesChecked, 0)} linked run artifacts.\n`);
