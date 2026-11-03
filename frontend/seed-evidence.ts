/** Small runtime boundary for marketing claims. Missing/invalid proof never becomes a success badge. */
export interface SeedEvidence {
  browserVersion: string;
  assertion: { target: string; operator: string; expected: string | number; hash: string };
  sourceHashes: { buggy: string; fixed: string };
  buggyFailures: number;
  fixedPasses: number;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The captured evidence record is incomplete.');
  return value as Record<string, unknown>;
}

export function validateSeedEvidence(value: unknown, runs: unknown[]): SeedEvidence {
  const data = record(value), repetitions = record(data.repetitions), assertion = record(data.assertion), hashes = record(data.sourceHashes);
  const hash = assertion.hash;
  if (data.verified !== true || data.mode !== 'recorded' || data.id !== 'lost-note'
    || typeof data.browserVersion !== 'string' || data.browserVersion.length > 80
    || typeof assertion.target !== 'string' || typeof assertion.operator !== 'string'
    || assertion.target !== 'notes' || assertion.operator !== 'contains' || assertion.expected !== 'Book the demo slot'
    || !['string', 'number'].includes(typeof assertion.expected)
    || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)
    || typeof hashes.buggy !== 'string' || !/^[a-f0-9]{64}$/.test(hashes.buggy)
    || typeof hashes.fixed !== 'string' || !/^[a-f0-9]{64}$/.test(hashes.fixed)) {
    throw new Error('The captured evidence record has not met the verification contract.');
  }
  const checked = (entries: unknown, variant: 'buggy' | 'fixed') => Array.isArray(entries) && entries.length === 3
    && entries.every((entry, index) => {
      const summary = record(entry), result = record(runs[(variant === 'buggy' ? 0 : 3) + index]), invariant = record(result.assertion);
      return summary.result === `${variant}-${index + 1}/result.json` && summary.error === null && result.error === null
        && summary.status === (variant === 'buggy' ? 'failed' : 'passed') && result.status === summary.status
        && result.challengeId === 'lost-note' && result.variant === variant && result.browserVersion === data.browserVersion
        && invariant.hash === hash && invariant.target === assertion.target && invariant.operator === assertion.operator
        && invariant.expected === assertion.expected && invariant.pass === (variant === 'fixed')
        && Array.isArray(data.schedule) && data.schedule.length > 0 && JSON.stringify(result.schedule) === JSON.stringify(data.schedule);
    });
  if (runs.length !== 6 || !checked(repetitions.buggy, 'buggy') || !checked(repetitions.fixed, 'fixed')) {
    throw new Error('Three matching buggy failures and fixed passes are required before showing verified evidence.');
  }
  return { browserVersion: data.browserVersion, assertion: assertion as unknown as SeedEvidence['assertion'],
    sourceHashes: { buggy: hashes.buggy, fixed: hashes.fixed }, buggyFailures: 3, fixedPasses: 3 };
}
