/** Personal play milestones only. This data never decides a verification result. */
export interface CaseProgress {
  bugFound: boolean;
  targetMet: boolean;
  fixedChecked: boolean;
  bestMoves: number | null;
}

export type ProgressRecord = Record<string, CaseProgress>;
export type ProgressEvent = { type: 'bug'; moves: number; target: number } | { type: 'fixed' };

export const STORAGE_KEY = 'bugarcade:progress:v1';
export const MAX_CASES = 200;
export const MAX_STORAGE_BYTES = 64 * 1024;
export const emptyCase: CaseProgress = Object.freeze({ bugFound: false, targetMet: false, fixedChecked: false, bestMoves: null });

const seeds = new Set(['lost-note', 'rollback', 'search', 'duplicate', 'cleanup']);
const fields = ['bugFound', 'targetMet', 'fixedChecked', 'bestMoves'];

function plainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataFields(value: unknown, names: string[]): value is Record<string, unknown> {
  if (!plainObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === names.length && keys.every(key => typeof key === 'string' && names.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.get === undefined
    && Object.getOwnPropertyDescriptor(value, key)?.set === undefined);
}

function caseKey(value: string): boolean {
  return /^job:[a-f0-9]{32}$/.test(value) || (value.startsWith('seed:') && seeds.has(value.slice(5)));
}

function validCase(value: unknown): value is CaseProgress {
  if (!dataFields(value, fields) || typeof value.bugFound !== 'boolean' || typeof value.targetMet !== 'boolean'
      || typeof value.fixedChecked !== 'boolean') return false;
  if (!value.bugFound) return value.bestMoves === null && !value.targetMet && !value.fixedChecked;
  return Number.isInteger(value.bestMoves) && Number(value.bestMoves) >= 1 && Number(value.bestMoves) <= 1000
    && (!value.targetMet || Number(value.bestMoves) <= 12);
}

function readRecord(value: unknown): ProgressRecord {
  if (!plainObject(value)) return {};
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_CASES) return {};
  const result: ProgressRecord = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !caseKey(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !validCase(descriptor.value)) continue;
    result[key] = { ...descriptor.value };
  }
  return result;
}

function sameCase(left: CaseProgress, right: CaseProgress): boolean {
  return left.bugFound === right.bugFound && left.targetMet === right.targetMet
    && left.fixedChecked === right.fixedChecked && left.bestMoves === right.bestMoves;
}

function sameRecord(left: unknown, right: ProgressRecord): left is ProgressRecord {
  if (!plainObject(left)) return false;
  const keys = Reflect.ownKeys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every(key => {
    if (typeof key !== 'string' || !Object.hasOwn(right, key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(left, key);
    return descriptor && 'value' in descriptor && validCase(descriptor.value) && sameCase(descriptor.value, right[key]);
  });
}

function boundedRecord(record: ProgressRecord): ProgressRecord {
  // Keep the five arcade cases before custom jobs; lexical job retention converges across tabs.
  const keys = Object.keys(record).sort((left, right) => {
    const kind = Number(right.startsWith('seed:')) - Number(left.startsWith('seed:'));
    return kind || (left < right ? -1 : left > right ? 1 : 0);
  }).slice(0, MAX_CASES);
  return Object.fromEntries(keys.map(key => [key, record[key]]));
}

export function parseProgress(raw: string | null): ProgressRecord {
  if (typeof raw !== 'string' || raw.length > MAX_STORAGE_BYTES) return {};
  if (new TextEncoder().encode(raw).byteLength > MAX_STORAGE_BYTES) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!dataFields(value, ['version', 'cases']) || value.version !== 1) return {};
    return readRecord(value.cases);
  } catch {
    return {};
  }
}

export function encodeProgress(record: ProgressRecord): string {
  return JSON.stringify({ version: 1, cases: readRecord(record) });
}

export function caseStars(progress: CaseProgress): number {
  return validCase(progress) ? Number(progress.bugFound) + Number(progress.targetMet) + Number(progress.fixedChecked) : 0;
}

export function mergeProgress(left: ProgressRecord, right: ProgressRecord): ProgressRecord {
  const merged = readRecord(left);
  for (const [key, value] of Object.entries(readRecord(right))) {
    const previous = merged[key];
    if (!previous) {
      merged[key] = value;
      continue;
    }
    merged[key] = {
      bugFound: previous.bugFound || value.bugFound,
      targetMet: previous.targetMet || value.targetMet,
      fixedChecked: previous.fixedChecked || value.fixedChecked,
      bestMoves: previous.bestMoves === null ? value.bestMoves : value.bestMoves === null ? previous.bestMoves : Math.min(previous.bestMoves, value.bestMoves),
    };
  }
  const result = boundedRecord(merged);
  return sameRecord(left, result) ? left : result;
}

export function updateProgress(record: ProgressRecord, key: string, event: ProgressEvent): ProgressRecord {
  if (typeof key !== 'string' || !caseKey(key)) return record;
  if (!plainObject(event)) return record;
  const descriptor = Object.getOwnPropertyDescriptor(event, 'type');
  const kind: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  if (kind !== 'bug' && kind !== 'fixed') return record;
  if (!dataFields(event, kind === 'bug' ? ['type', 'moves', 'target'] : ['type'])) return record;
  if (event.type === 'bug' && (!Number.isInteger(event.moves) || event.moves < 1 || event.moves > 1000
      || !Number.isInteger(event.target) || event.target < 1 || event.target > 12)) return record;
  const current = readRecord(record)[key] ?? emptyCase;
  if (event.type === 'fixed' && !current.bugFound) return record;
  const next: CaseProgress = event.type === 'fixed' ? { ...current, fixedChecked: true } : {
    ...current,
    bugFound: true,
    targetMet: current.targetMet || event.moves <= event.target,
    bestMoves: current.bestMoves === null ? event.moves : Math.min(current.bestMoves, event.moves),
  };
  return mergeProgress(record, { [key]: next });
}
