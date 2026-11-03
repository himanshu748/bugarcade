import { createHash } from 'node:crypto';

export const LIMITS = Object.freeze({ actions: 12, actionMs: 2500, runMs: 45000, outputBytes: 2_000_000, sourceBytes: 65_536, sessions: 32, requests: 24 });
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonical(value)).digest('hex');
export const assertionHash = manifest => hash({ assertion: manifest.assertion, completion: manifest.completion });
export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !identifier.test(manifest.id)) throw new Error('Invalid challenge ID');
  if (!Array.isArray(manifest.allowedTargets) || !manifest.allowedTargets.length || manifest.allowedTargets.length > 64 || manifest.allowedTargets.some(t => typeof t !== 'string' || !identifier.test(t))) throw new Error('Invalid allowedTargets');
  const assertion = manifest.assertion;
  if (!assertion || !manifest.allowedTargets.includes(assertion.target) || !['equals','contains','count'].includes(assertion.operator) || !['string','number'].includes(typeof assertion.expected)) throw new Error('Invalid assertion');
  if (String(assertion.expected).length > 1000 || (assertion.operator === 'count' && (!Number.isInteger(assertion.expected) || assertion.expected < 0))) throw new Error('Invalid expected value');
  if (!manifest.completion || !manifest.allowedTargets.includes(manifest.completion.target) || typeof manifest.completion.value !== 'string' || manifest.completion.value.length > 1000) throw new Error('A fixed completion checkpoint is required');
  if (!Array.isArray(manifest.schedule) || manifest.schedule.length > 16) throw new Error('Invalid network schedule');
  const ids = new Set();
  for (const entry of manifest.schedule) {
    if (!identifier.test(entry.id) || !identifier.test(entry.key) || ids.has(entry.id) || !Number.isInteger(entry.status) || entry.status < 200 || entry.status > 599 || canonical(entry.response).length > 16000) throw new Error('Invalid schedule entry');
    ids.add(entry.id);
  }
  validateActions(manifest.actions ?? [], manifest);
  return manifest;
}
export function validateActions(actions, manifest) {
  if (!Array.isArray(actions) || actions.length > LIMITS.actions) throw new Error('Plan exceeds 12 actions');
  for (const action of actions) {
    if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Invalid action');
    const fields = { click: ['type','target'], fill: ['type','target','value'], wait: ['type','target','value'], release: ['type','request'] }[action.type];
    if (!fields || Object.keys(action).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(action, key))) throw new Error('Unsupported action or fields');
    if (action.type === 'release') {
      if (!manifest.schedule.some(entry => entry.id === action.request)) throw new Error('Unknown scheduled request');
    } else {
      if (!manifest.allowedTargets.includes(action.target) || !identifier.test(action.target)) throw new Error('Unknown action target');
      if (['fill','wait'].includes(action.type) && (typeof action.value !== 'string' || action.value.length > 1000)) throw new Error('Invalid action value');
    }
  }
  return actions;
}
