import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateJobEvidence } from '../frontend/job-evidence.ts';

const liveId = '6d18b3f942ea45698c972d6763ce3383';
const recordedId = '8201bb48771d4760ad8aee993b7c9107';
const read = id => JSON.parse(fs.readFileSync(new URL(`../evidence/jobs/${id}/summary.json`, import.meta.url)));
const live = read(liveId), recorded = read(recordedId);
const seed = JSON.parse(fs.readFileSync(new URL('../shared/challenges.json', import.meta.url)))[0];
const expected = (mode = 'live') => ({ jobId: mode === 'live' ? liveId : recordedId, mode,
  challengeId: seed.id, assertion: structuredClone(seed.assertion), completion: structuredClone(seed.completion),
  actions: structuredClone(seed.actions), schedule: structuredClone(seed.schedule) });
const validation = data => data.runs.filter(run => run.phase === 'validation');
const altered = mutate => { const data = structuredClone(live); mutate(data); return data; };
const rejects = mutate => assert.throws(() => validateJobEvidence(altered(mutate), expected()));

test('genuine live proposal, actual initial trace and six final outcomes stay connected', () => {
  const result = validateJobEvidence(live, expected());
  assert.equal(result.mode, 'live'); assert.equal(result.runner, 'modal-sandbox');
  assert.equal(result.modelCalls, 1); assert.equal(result.initialActions.length, 4); assert.equal(result.actions.length, 3);
  assert.equal(result.proposal.provider, 'modal'); assert.equal(result.proposal.totalTokens, 2839);
  assert.equal(result.proposal.estimatedCostUsd, 0.00631175); assert.equal(result.proposal.frames.length, 4);
  assert.deepEqual(result.initialTrace.map(row => row.action), result.proposal.proposedActions);
  assert.deepEqual(result.validationRuns.map(row => [row.variant, row.ordinal, row.passed]), [
    ['buggy', 1, false], ['fixed', 1, true], ['buggy', 2, false], ['fixed', 2, true], ['buggy', 3, false], ['fixed', 3, true],
  ]);
  assert.equal(result.validationRuns[0].actual, 'Ship the rough cut');
  assert.equal(result.validationRuns[1].actual, 'Ship the rough cutBook the demo slot');
  assert.equal(result.validationRuns[0].artifactDirectory, '10-validation-buggy');
  assert.equal(result.excludedErrors, 6);
});

test('genuine recorded capture stays authored with zero calls and normalized source hashes', () => {
  const result = validateJobEvidence(recorded, expected('recorded'));
  assert.equal(result.proposal, null); assert.equal(result.modelCalls, 0); assert.equal(result.excludedErrors, 3);
  assert.equal(result.runner, 'local-trusted-seeds');
  assert.deepEqual(result.sourceHashes, { buggy: live.sourceHashes['buggy/App.tsx'], fixed: live.sourceHashes['fixed/App.tsx'] });
});

test('schema key ordering and omitted optional:false do not invent a schedule mismatch', () => {
  const data = structuredClone(live);
  data.schedule = data.schedule.map(({ optional: _optional, ...entry }) => Object.fromEntries(Object.entries(entry).reverse()));
  for (const run of data.runs) run.result.schedule = structuredClone(data.schedule);
  assert.equal(validateJobEvidence(data, expected()).validationRuns.length, 6);
});

test('a caller-mode or runner mismatch cannot turn a recorded run into a model run', () => {
  assert.throws(() => validateJobEvidence(recorded, { ...expected('recorded'), mode: 'live' }));
  rejects(data => { data.runner = 'local-trusted-seeds'; });
  rejects(data => { data.mode = 'recorded'; });
});

test('missing verification and fabricated repeated counts fail closed', () => {
  rejects(data => { data.verified = false; });
  rejects(data => { data.buggyFailures = 2; });
  rejects(data => { data.fixedPasses = 4; });
  rejects(data => { data.validationRuns = 5; });
  rejects(data => { data.browserRuns++; });
  rejects(data => { data.infrastructureErrors = 0; });
});

test('weakened declared assertions and completion checkpoints are rejected', () => {
  rejects(data => { data.assertion.expected = 'Ship the rough cut'; });
  rejects(data => { data.completion.value = 'Anything'; });
  rejects(data => { validation(data)[0].result.assertion.expected = 'Ship the rough cut'; });
  rejects(data => { validation(data)[0].result.assertion.completion.value = 'Anything'; });
  rejects(data => { validation(data)[0].invariantHash = 'a'.repeat(64); });
  rejects(data => { validation(data)[0].result.assertion.hash = 'a'.repeat(64); });
});

test('actual observations decide pass/fail rather than labels or self-reported flags', () => {
  rejects(data => { validation(data)[0].result.assertion.actual = 'Book the demo slot'; });
  rejects(data => { validation(data)[1].result.assertion.actual = 'Ship the rough cut'; });
  rejects(data => { validation(data)[0].result.assertion.pass = true; });
  rejects(data => { validation(data)[1].result.status = 'failed'; });
});

test('timeouts, infrastructure errors and missing deterministic results cannot count', () => {
  rejects(data => { const run = validation(data)[0]; run.result.status = 'error'; run.result.error = { code: 'TIMEOUT' }; });
  rejects(data => { validation(data)[1].result.error = { code: 'CAPTURE_ERROR' }; });
  rejects(data => { delete validation(data)[0].result.assertion; });
  rejects(data => { validation(data)[0].result.assertion.actual = null; });
});

test('final validation must contain three distinct alternating pairs with one seed and schedule', () => {
  rejects(data => { data.runs.pop(); });
  rejects(data => { data.runs.push(structuredClone(data.runs.at(-1))); });
  rejects(data => { const runs = validation(data); [runs[0].variant, runs[1].variant] = [runs[1].variant, runs[0].variant]; });
  rejects(data => { validation(data)[0].result.seed++; });
  rejects(data => { validation(data)[0].result.schedule[0].response.saved = false; });
  rejects(data => { data.schedule[0].optional = true; });
});

test('unsafe, duplicate and foreign-job artifact paths never reach the display contract', () => {
  rejects(data => { validation(data)[0].artifactDirectory = `jobs/${liveId}/../final.png`; });
  rejects(data => { validation(data)[0].artifactDirectory = `jobs/${recordedId}/10-validation-buggy`; });
  rejects(data => { validation(data)[2].artifactDirectory = validation(data)[0].artifactDirectory; });
  rejects(data => { validation(data)[0].artifactDirectory = 'https://example.invalid/final.png'; });
});

test('an unsupported action or incomplete executed trace is rejected', () => {
  rejects(data => { data.initialActions[0] = { type: 'evaluate', script: 'anything' }; });
  rejects(data => { data.initialActions[0].unexpected = 'field'; });
  rejects(data => { data.initialActions[2].request = 'other-request'; });
  rejects(data => { validation(data)[0].result.actions.pop(); });
  rejects(data => { validation(data)[0].result.actions[0].status = 'planned'; });
  rejects(data => { validation(data)[0].result.actions[0].action.target = 'other-target'; });
  rejects(data => { validation(data)[0].result.actions[1].atMs = 0; });
});

test('minimization may delete steps but cannot insert or reorder them', () => {
  const data = structuredClone(live), promise = expected();
  [data.actions[0], data.actions[1]] = [data.actions[1], data.actions[0]];
  promise.actions = structuredClone(data.actions);
  assert.throws(() => validateJobEvidence(data, promise), /inserted or reordered/);
});

test('the accepted proposal must match its actual initial pair and final proposal correlation', () => {
  rejects(data => { data.provenance[0].proposedActions[0].target = 'other-target'; });
  rejects(data => { data.provenance[0].executedActions[0].target = 'other-target'; });
  rejects(data => { data.provenance[0].proposal.actions.pop(); });
  rejects(data => { data.provenance[0].proposal.candidateAssertion.expected = 'Other text'; });
  rejects(data => { validation(data)[0].proposalId = 'a'.repeat(64); });
  rejects(data => { data.runs[0].proposalId = 'a'.repeat(64); });
  rejects(data => { data.provenance.push(structuredClone(data.provenance[0])); });
});

test('provider identity and the fixed endpoint allowlist remain consistent', () => {
  rejects(data => { data.provenance[0].provider = 'unknown'; });
  rejects(data => { data.provenance[0].endpoint = 'http://127.0.0.1:8000'; });
  rejects(data => { data.model = 'different-model'; });
  rejects(data => { data.provenance[0].model = data.model = 'https://example.invalid/model'; });
  rejects(data => { data.provenance[0].providerCallAttempted = false; });
  rejects(data => { data.modelCalls = 0; });
});

test('valid configurable Baseten routing does not masquerade as a Modal endpoint', () => {
  const data = structuredClone(live);
  data.modelProvider = data.provenance[0].provider = 'baseten';
  data.model = data.provenance[0].model = 'meta-models/grant-specific-muse';
  data.provenance[0].endpoint = 'https://inference.baseten.co/v1/chat/completions';
  assert.equal(validateJobEvidence(data, expected()).proposal.provider, 'baseten');
});

test('recording samples and model usage are bounded and internally consistent', () => {
  rejects(data => { data.provenance[0].frames[0].sha256 = 'not-a-hash'; });
  rejects(data => { data.provenance[0].frames = []; });
  rejects(data => { data.provenance[0].frames[1].timestampMs = 0; });
  rejects(data => { data.provenance[0].usage.prompt_tokens = 24001; });
  rejects(data => { data.provenance[0].usage.completion_tokens = 2049; });
  rejects(data => { data.provenance[0].usage.total_tokens++; });
  rejects(data => { data.provenance[0].finishedAt = data.provenance[0].attemptedAt - 1; });
});

test('absent estimated cost stays unknown instead of becoming a zero-cost claim', () => {
  const data = structuredClone(live); delete data.provenance[0].estimatedModelCostUsd;
  assert.equal(validateJobEvidence(data, expected()).proposal.estimatedCostUsd, null);
  rejects(data => { data.provenance[0].estimatedModelCostUsd = Infinity; });
});

test('source inventories and aliases cannot contradict each other', () => {
  rejects(data => { data.sourceHashes['buggy/App.tsx'] = 'bad'; });
  rejects(data => { data.sourceHashes.buggy = 'a'.repeat(64); });
  rejects(data => { data.sourceHashes['../../secret'] = 'a'.repeat(64); });
});

test('oversized arrays and strings are rejected before iteration', () => {
  rejects(data => { data.runs = new Array(1000000); });
  rejects(data => { data.actions = new Array(1000000); });
  rejects(data => { data.provenance[0].frames = new Array(1000000); });
  rejects(data => { data.provenance[0].model = 'x'.repeat(10000); });
  rejects(data => { data.schedule[0].response = { note: 'x'.repeat(16001) }; });
});

test('accessor fields and nonplain objects cannot silently supply evidence', () => {
  const data = structuredClone(live); let called = false;
  Object.defineProperty(data, 'verified', { enumerable: true, get() { called = true; return true; } });
  assert.throws(() => validateJobEvidence(data, expected())); assert.equal(called, false);
  assert.throws(() => validateJobEvidence(new Date(), expected()));
});

test('the returned display data does not mutate or alias the captured source', () => {
  const data = structuredClone(live), before = JSON.stringify(data);
  const result = validateJobEvidence(data, expected());
  result.actions[0].target = 'display-only'; result.proposal.frames[0].timestampMs = 123;
  assert.equal(JSON.stringify(data), before);
});
