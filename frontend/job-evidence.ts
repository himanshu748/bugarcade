import type { Action } from './types';

export interface JobEvidenceExpectation {
  jobId: string;
  mode: 'live' | 'recorded';
  challengeId: string;
  assertion: { target: string; operator: string; expected: string | number };
  completion: { target: string; value: string };
  actions: Action[];
  schedule: unknown[];
}

export interface JobEvidenceTraceEntry { index: number; action: Action; atMs: number; elapsedMs: number }
export interface JobValidationRun {
  variant: 'buggy' | 'fixed'; ordinal: 1 | 2 | 3;
  actual: string | number; expected: string | number; passed: boolean;
  elapsedMs: number; artifactDirectory: string;
}
export interface JobProposalEvidence {
  proposalId: string; provider: 'modal' | 'baseten'; model: string; endpoint: string;
  attemptedAt: number; finishedAt: number; proposedActions: Action[];
  frames: { timestampMs: number; sha256: string }[];
  inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number | null;
}
export interface JobEvidence {
  mode: 'live' | 'recorded'; runner: 'modal-sandbox' | 'local-trusted-seeds';
  modelCalls: number; elapsedMs: number; browserVersion: string; invariantHash: string;
  sourceHashes: { buggy: string; fixed: string };
  initialActions: Action[]; actions: Action[]; initialTrace: JobEvidenceTraceEntry[];
  validationRuns: JobValidationRun[]; excludedErrors: number; proposal: JobProposalEvidence | null;
}

type Data = Record<string, unknown>;
type Assertion = JobEvidenceExpectation['assertion'];
type Completion = JobEvidenceExpectation['completion'];
type ScheduleEntry = { id: string; key: string; response: unknown; status: number; optional: boolean };
type Run = { data: Data; result: Data; phase: 'initial' | 'minimize' | 'validation'; variant: 'buggy' | 'fixed'; actions: Action[]; proposalId: string; directory: string };
const SHA = /^[a-f0-9]{64}$/;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, maximum = 64): Data {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'The evidence record is incomplete.');
  const prototype = Object.getPrototypeOf(value);
  requireThat(prototype === Object.prototype || prototype === null, 'Evidence must contain plain data.');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  requireThat(keys.length <= maximum && keys.every(key => typeof key === 'string' && key.length <= 128), 'The evidence record exceeds its field limit.');
  requireThat(keys.every(key => Object.hasOwn(descriptors[key as string], 'value')), 'Evidence cannot contain accessor fields.');
  return Object.fromEntries(keys.map(key => [key, descriptors[key as string].value]));
}
function keys(value: Data, allowed: string[], required = allowed) {
  requireThat(Object.keys(value).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key)), 'An evidence field has an unsupported shape.');
}
function array(value: unknown, maximum: number): unknown[] {
  requireThat(Array.isArray(value) && value.length <= maximum, 'The captured evidence exceeds its item limit.');
  return value;
}
function text(value: unknown, maximum: number, empty = false): string {
  requireThat(typeof value === 'string' && value.length <= maximum && (empty || value.length > 0), 'An evidence text field is missing or too large.');
  return value;
}
function identifier(value: unknown): string { const result = text(value, 64); requireThat(ID.test(result), 'An evidence identifier is invalid.'); return result; }
function hash(value: unknown): string { const result = text(value, 64); requireThat(SHA.test(result), 'An evidence hash is invalid.'); return result; }
function number(value: unknown, maximum: number, integer = false, minimum = 0): number {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= maximum && (!integer || Number.isSafeInteger(value)), 'An evidence number is invalid or outside its limit.');
  return value;
}
function json(value: unknown, depth = 0): unknown {
  requireThat(depth <= 8, 'The controlled schedule exceeds its nesting limit.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return text(value, 16000, true);
  if (typeof value === 'number') { requireThat(Number.isFinite(value), 'The schedule contains a non-finite number.'); return value; }
  if (Array.isArray(value)) return array(value, 256).map(item => json(item, depth + 1));
  const data = object(value, 256);
  return Object.fromEntries(Object.keys(data).sort().map(key => [key, json(data[key], depth + 1)]));
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(json(left)) === JSON.stringify(json(right)); }
function assertion(value: unknown): Assertion {
  const data = object(value); keys(data, ['target', 'operator', 'expected']);
  const target = identifier(data.target), operator = text(data.operator, 8);
  requireThat(['contains', 'equals', 'count'].includes(operator), 'The assertion operator is unsupported.');
  const expected = operator === 'count' ? number(data.expected, Number.MAX_SAFE_INTEGER, true) : text(data.expected, 500, true);
  return { target, operator, expected };
}
function completion(value: unknown): Completion {
  const data = object(value); keys(data, ['target', 'value']);
  return { target: identifier(data.target), value: text(data.value, 500, true) };
}
function schedule(value: unknown): ScheduleEntry[] {
  const entries = array(value, 12).map(item => {
    const data = object(item); keys(data, ['id', 'key', 'response', 'status', 'optional'], ['id', 'key', 'response', 'status']);
    const response = json(data.response);
    requireThat(JSON.stringify(response).length <= 16000, 'A controlled response exceeds its size limit.');
    requireThat(data.optional === undefined || typeof data.optional === 'boolean', 'The schedule optional flag is invalid.');
    return { id: identifier(data.id), key: identifier(data.key), response, status: number(data.status, 599, true, 200), optional: data.optional === true };
  });
  requireThat(new Set(entries.map(item => item.id)).size === entries.length, 'Controlled request IDs must be unique.');
  return entries;
}
function actions(value: unknown, requests: Set<string>): Action[] {
  return array(value, 12).map(item => {
    const data = object(item), type = text(data.type, 8);
    if (type === 'release') {
      keys(data, ['type', 'request']); const request = identifier(data.request);
      requireThat(requests.has(request), 'An action references an undeclared controlled request.');
      return { type, request };
    }
    requireThat(type === 'click' || type === 'fill' || type === 'wait', 'The captured action vocabulary is unsupported.');
    keys(data, type === 'click' ? ['type', 'target'] : ['type', 'target', 'value']);
    const target = identifier(data.target);
    return type === 'click' ? { type, target } : { type, target, value: text(data.value, 500, true) };
  });
}
function trace(result: Data, expected: Action[], requests: Set<string>): JobEvidenceTraceEntry[] {
  const entries = array(result.actions, 12);
  requireThat(entries.length === expected.length, 'The executed action trace is incomplete.');
  let previousEnd = 0;
  return entries.map((item, index) => {
    const data = object(item);
    requireThat(data.index === index && data.status === 'executed', 'Every captured action must have executed in order.');
    const action = actions([data.action], requests)[0];
    requireThat(same(action, expected[index]), 'The requested and executed actions do not match.');
    const atMs = number(data.atMs, 300000), elapsedMs = number(data.elapsedMs, 300000);
    requireThat(atMs >= previousEnd, 'The action trace timestamps are out of order.');
    previousEnd = atMs + elapsedMs;
    return { index, action, atMs, elapsedMs };
  });
}
function observed(value: unknown, operator: string): string | number {
  return operator === 'count' ? number(value, Number.MAX_SAFE_INTEGER, true) : text(value, 16000, true);
}
function outcome(run: Run, expectedActions: Action[], locked: Assertion, checkpoint: Completion, invariant: string,
  controlled: ScheduleEntry[], seed: number, version: string, challengeId: string, requests: Set<string>) {
  const result = run.result, rule = object(result.assertion);
  const passed = run.variant === 'fixed';
  requireThat(result.status === (passed ? 'passed' : 'failed') && result.error === null, 'A timeout or execution error cannot count as reproduced or fixed.');
  requireThat(result.variant === run.variant && result.challengeId === challengeId && result.seed === seed && result.browserVersion === version,
    'The browser run identity differs from the captured challenge.');
  requireThat(same(run.actions, expectedActions) && same(schedule(result.schedule), controlled), 'The repeated run changed its actions or controlled schedule.');
  requireThat(rule.hash === invariant && rule.target === locked.target && rule.operator === locked.operator && rule.expected === locked.expected
    && same(completion(rule.completion), checkpoint), 'The assertion or completion checkpoint drifted between runs.');
  const actual = observed(rule.actual, locked.operator);
  const recomputed = locked.operator === 'contains' ? String(actual).includes(String(locked.expected)) : actual === locked.expected;
  requireThat(rule.pass === recomputed && recomputed === passed, 'The observed value does not support the recorded assertion verdict.');
  return { actual, passed, elapsedMs: number(result.elapsedMs, 300000), trace: trace(result, expectedActions, requests) };
}

/** Checks coherent captured evidence for display; it does not execute or certify app code. */
export function validateJobEvidence(value: unknown, expected: JobEvidenceExpectation): JobEvidence {
  requireThat(/^[a-f0-9]{32}$/.test(expected.jobId), 'The job ID is invalid.');
  requireThat(expected.mode === 'live' || expected.mode === 'recorded', 'The expected run mode is invalid.');
  const data = object(value), controlled = schedule(data.schedule), expectedSchedule = schedule(expected.schedule);
  const locked = assertion(data.assertion), declared = assertion(expected.assertion), checkpoint = completion(data.completion);
  const requests = new Set(controlled.map(item => item.id));
  const minimized = actions(data.actions, requests), initial = actions(data.initialActions, requests);
  let retained = 0;
  for (const action of initial) if (retained < minimized.length && same(action, minimized[retained])) retained++;
  requireThat(retained === minimized.length, 'Minimization inserted or reordered actions instead of deleting them.');
  const invariant = hash(data.invariantHash), challengeId = identifier(data.challengeId);
  const runner = expected.mode === 'live' ? 'modal-sandbox' : 'local-trusted-seeds';
  requireThat(data.verified === true && data.mode === expected.mode && data.runner === runner && challengeId === expected.challengeId,
    'The job has not met its declared verification mode and identity.');
  requireThat(same(locked, declared) && same(checkpoint, completion(expected.completion)) && same(controlled, expectedSchedule)
    && same(minimized, actions(expected.actions, requests)), 'Captured proof does not match the declared challenge promise.');
  requireThat(data.initialActionCount === initial.length && data.minimizedActionCount === minimized.length
    && data.buggyFailures === 3 && data.fixedPasses === 3 && data.validationRuns === 6, 'The captured verification counts are inconsistent.');
  const seed = number(data.seed, Number.MAX_SAFE_INTEGER, true, -Number.MAX_SAFE_INTEGER);
  const elapsedMs = number(data.elapsedMs, 300000);
  const hashes = object(data.sourceHashes, 6);
  const names = ['buggy', 'fixed', 'buggy/App.tsx', 'fixed/App.tsx', 'manifest.json', 'README.md'];
  requireThat(Object.keys(hashes).every(name => names.includes(name)), 'The source inventory is unsupported.');
  for (const candidate of Object.values(hashes)) hash(candidate);
  const sourceHashes = { buggy: hash(hashes.buggy ?? hashes['buggy/App.tsx']), fixed: hash(hashes.fixed ?? hashes['fixed/App.tsx']) };
  requireThat((hashes.buggy === undefined || hashes['buggy/App.tsx'] === undefined || hashes.buggy === hashes['buggy/App.tsx'])
    && (hashes.fixed === undefined || hashes['fixed/App.tsx'] === undefined || hashes.fixed === hashes['fixed/App.tsx']), 'Source hash aliases disagree.');
  const directories = new Set<string>();
  const runs: Run[] = array(data.runs, 64).map(item => {
    const entry = object(item), result = object(entry.result), phase = entry.phase, variant = entry.variant;
    requireThat(phase === 'initial' || phase === 'minimize' || phase === 'validation', 'A browser run phase is unsupported.');
    requireThat(variant === 'buggy' || variant === 'fixed', 'A browser variant is unsupported.');
    requireThat(entry.invariantHash === invariant && ['failed', 'passed', 'error'].includes(String(result.status)), 'A run changed the frozen assertion or status.');
    const fullDirectory = text(entry.artifactDirectory, 128);
    const match = new RegExp(`^jobs/${expected.jobId}/([0-9]{2}-${phase}-${variant})$`).exec(fullDirectory);
    requireThat(match && !directories.has(match[1]), 'A browser artifact path is unsafe, duplicated or belongs to another job.');
    directories.add(match[1]);
    return { data: entry, result, phase, variant, actions: actions(entry.actions, requests), proposalId: hash(entry.proposalId), directory: match[1] };
  });
  const final = runs.slice(-6);
  requireThat(final.length === 6 && final.every((run, index) => run.phase === 'validation' && run.variant === (index % 2 ? 'fixed' : 'buggy'))
    && runs.filter(run => run.phase === 'validation').length === 6, 'Six final alternating buggy/fixed validation runs are required.');
  const browserVersion = text(final[0].result.browserVersion, 80);
  const proposalId = final[0].proposalId;
  requireThat(final.every(run => run.proposalId === proposalId), 'Final browser runs do not belong to one accepted proposal.');
  const validationRuns = final.map((run, index): JobValidationRun => {
    const checked = outcome(run, minimized, locked, checkpoint, invariant, controlled, seed, browserVersion, challengeId, requests);
    return { variant: run.variant, ordinal: (Math.floor(index / 2) + 1) as 1 | 2 | 3,
      actual: checked.actual, expected: locked.expected, passed: checked.passed, elapsedMs: checked.elapsedMs, artifactDirectory: run.directory };
  });
  const first = runs.find(run => run.phase === 'initial' && run.variant === 'buggy' && run.proposalId === proposalId && same(run.actions, initial));
  const firstFixed = runs.find(run => run.phase === 'initial' && run.variant === 'fixed' && run.proposalId === proposalId && same(run.actions, initial));
  requireThat(first && firstFixed, 'The accepted proposal is missing its initial buggy/fixed execution pair.');
  const initialTrace = outcome(first, initial, locked, checkpoint, invariant, controlled, seed, browserVersion, challengeId, requests).trace;
  outcome(firstFixed, initial, locked, checkpoint, invariant, controlled, seed, browserVersion, challengeId, requests);
  const excludedErrors = runs.filter(run => run.result.status === 'error').length;
  requireThat(data.browserRuns === runs.length && data.infrastructureErrors === excludedErrors, 'The browser and excluded-error totals are inconsistent.');
  number(data.minimizationProbes, 20, true);
  const provenance = array(data.provenance, 4).map(item => object(item));
  const accepted = provenance.filter(item => item.proposalId === proposalId);
  requireThat(accepted.length === 1 && accepted[0].invariantHash === invariant
    && same(actions(accepted[0].proposedActions, requests), initial)
    && same(actions(accepted[0].executedActions, requests), initial), 'The accepted plan is not connected to its actual initial action trace.');
  const modelCalls = number(data.modelCalls, 2, true);
  let proposal: JobProposalEvidence | null = null;
  if (expected.mode === 'recorded') {
    requireThat(modelCalls === 0 && provenance.every(item => item.origin === 'authored-seed-plan' && item.model === null && item.modelCalls === 0),
      'Authored evidence cannot be presented as a live model run.');
  } else {
    const item = accepted[0], provider = item.provider;
    requireThat(modelCalls >= 1 && provenance.filter(entry => entry.providerCallAttempted === true).length === modelCalls
      && item.origin === 'live-model' && item.providerCallAttempted === true && item.outcome === 'proposed', 'The accepted model call has no live provenance.');
    requireThat(provider === 'modal' || provider === 'baseten', 'The model provider is unsupported.');
    const endpoint = text(item.endpoint, 256), model = text(item.model, 256);
    requireThat(endpoint === (provider === 'modal' ? 'https://inference.us-west.modal.direct/v1/chat/completions' : 'https://inference.baseten.co/v1/chat/completions')
      && data.modelProvider === provider && data.model === model, 'Model routing differs from the recorded provider configuration.');
    requireThat(provider !== 'modal' || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.us-west\.modal\.direct$/.test(model), 'The Modal model hostname is invalid.');
    const candidate = object(item.proposal);
    requireThat(same(actions(candidate.actions, requests), initial) && same(assertion(candidate.candidateAssertion), locked), 'The model proposed a different action plan or assertion.');
    const usage = object(item.usage), inputTokens = number(usage.prompt_tokens, 24000, true), outputTokens = number(usage.completion_tokens, 2048, true);
    const totalTokens = number(usage.total_tokens, 26048, true);
    requireThat(totalTokens === inputTokens + outputTokens, 'The model token totals are inconsistent.');
    const frames = array(item.frames, 8).map(frame => {
      const data = object(frame); keys(data, ['timestampMs', 'sha256']);
      return { timestampMs: number(data.timestampMs, 30000), sha256: hash(data.sha256) };
    });
    requireThat(frames.length > 0 && frames.every((frame, index) => index === 0 || frame.timestampMs > frames[index - 1].timestampMs), 'The sampled recording frames are missing or out of order.');
    const attemptedAt = number(item.attemptedAt, 1e11), finishedAt = number(item.finishedAt, 1e11);
    requireThat(finishedAt >= attemptedAt, 'The model call timestamps are out of order.');
    const configuration = object(item.configuration); number(configuration.maxOutputTokens, 2048, true, 1);
    proposal = { proposalId, provider, model, endpoint, attemptedAt, finishedAt, proposedActions: initial.map(action => ({ ...action })), frames,
      inputTokens, outputTokens, totalTokens, estimatedCostUsd: item.estimatedModelCostUsd == null ? null : number(item.estimatedModelCostUsd, 1e6) };
  }
  return { mode: expected.mode, runner, modelCalls, elapsedMs, browserVersion, invariantHash: invariant, sourceHashes,
    initialActions: initial, actions: minimized, initialTrace, validationRuns, excludedErrors, proposal };
}
