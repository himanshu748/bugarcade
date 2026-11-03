import challenges from '../shared/challenges.json' with { type: 'json' };

export const PUBLIC_DEMO = import.meta.env?.VITE_PUBLIC_DEMO === 'true';
const base = import.meta.env?.BASE_URL || '/';
const seedIds = new Set(challenges.map(challenge => challenge.id));

export function assetUrl(path: string, prefix = base): string {
  const relative = path.replace(/^\/+/, '');
  if (!/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(prefix) || !relative
    || !/^[a-zA-Z0-9_./-]+$/.test(relative)
    || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsupported static asset path.');
  }
  return prefix + relative;
}

export function staticApiUrl(url: string, prefix = base): string {
  const summary = /^\/api\/challenges\/([a-z0-9-]+)\/evidence$/.exec(url);
  if (summary && seedIds.has(summary[1])) return assetUrl(`_demo/evidence/seeds/${summary[1]}/summary.json`, prefix);
  const artifact = /^\/api\/artifacts\/([a-z0-9-]+)\/([a-zA-Z0-9_./-]+)$/.exec(url);
  if (artifact && seedIds.has(artifact[1])) return assetUrl(`_demo/evidence/seeds/${artifact[1]}/${artifact[2]}`, prefix);
  throw new Error('This workflow runs in the local creator. The hosted arcade serves the five included cases and captured evidence.');
}

export const apiUrl = (url: string): string => PUBLIC_DEMO ? staticApiUrl(url) : url;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The playable app catalog is invalid.');
  return value as Record<string, unknown>;
}

export async function loadHostedCartridge(id: string, variant: 'buggy' | 'fixed', signal: AbortSignal): Promise<string> {
  if (!seedIds.has(id)) throw new Error('This case is not included in the hosted arcade.');
  const response = await fetch(assetUrl('_demo/catalog.json'), { signal });
  if (!response.ok) throw new Error('The playable app catalog is unavailable. Reset to try again.');
  const raw = await response.text();
  if (raw.length > 64000) throw new Error('The playable app catalog exceeds its size limit.');
  const catalog = object(JSON.parse(raw));
  if (catalog.version !== 1 || catalog.kind !== 'static-seed-playback') throw new Error('The playable app catalog has an unsupported format.');
  if (catalog.parentOrigin === null) {
    if (location.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('This build is configured for a local preview.');
  } else if (catalog.parentOrigin !== location.origin || !location.origin.startsWith('https://')) {
    throw new Error('This playable build belongs to a different site.');
  }
  const item = object(object(object(catalog.fixtures)[id])[variant]);
  const path = `_demo/fixtures/${id}/${variant}.html`;
  if (item.url !== path || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
    || typeof item.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sourceSha256)) {
    throw new Error('The playable app record is invalid.');
  }
  const cartridge = await fetch(assetUrl(path), { signal });
  if (!cartridge.ok) throw new Error('The playable app is unavailable. Reset to try again.');
  const html = await cartridge.text();
  if (html.length > 8 * 1024 * 1024) throw new Error('The playable app exceeds its size limit.');
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html));
  const actual = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== item.sha256) throw new Error('The playable app did not match its build record. Reset to try again.');
  return html;
}
