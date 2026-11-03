/** Build trusted-seed playback assets. This script never deploys or calls a provider. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildCartridge, validateHostedParentOrigin } from '../worker/cartridge.mjs';
import { getChallenges, ROOT } from '../worker/server.mjs';
import { assertionHash, hash } from '../worker/validation.mjs';

const IDS = ['lost-note', 'rollback', 'search', 'duplicate', 'cleanup'];
const MAX_FILE = 16 * 1024 ** 2;
const MAX_TOTAL = 350 * 1024 ** 2;
const FORBIDDEN = new Set(['.data', '.git', '.venv', 'node_modules', '__pycache__', '.cache', '.design-tools']);
const ROOT_ARTIFACTS = new Set(['LICENSE', 'transformation-receipt.json', 'release-transformations.json']);
const sha = value => createHash('sha256').update(value).digest('hex');
const inside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
};

function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || path.posix.isAbsolute(name)
      || path.posix.normalize(name) !== name || name.split('/').some(part => !part || part === '.' || part === '..' || FORBIDDEN.has(part) || part.startsWith('.env'))) {
    throw new Error('Unsafe public artifact path');
  }
  return name;
}

async function outputDirectory(outDir) {
  if (typeof outDir !== 'string' || !outDir) throw new Error('An explicit output directory is required');
  const resolved = path.resolve(ROOT, outDir);
  const relative = path.relative(ROOT, resolved);
  const protectedRoots = new Set(['backend', 'frontend', 'worker', 'fixtures', 'shared', 'scripts', 'tests', 'public', 'docs', 'evidence', 'evaluation', 'node_modules', '.venv', '.git', 'dist-submission']);
  if (!inside(ROOT, resolved) || protectedRoots.has(relative.split(path.sep)[0])) throw new Error('Public output must be a generated directory inside the repository');
  let current = ROOT;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Public output cannot contain symlinks or files in its directory path');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

async function regularFile(root, name, maxBytes = MAX_FILE) {
  safeRelative(name);
  const candidate = path.join(root, ...name.split('/'));
  const info = await lstat(candidate);
  if (!inside(root, candidate) || !info.isFile() || info.isSymbolicLink() || await realpath(candidate) !== candidate || info.size > maxBytes) {
    throw new Error('Reviewed public artifacts must be bounded regular files without symlinks');
  }
  return { raw: await readFile(candidate), size: info.size };
}

async function writeOutput(output, name, raw) {
  const target = path.join(output, ...safeRelative(name).split('/'));
  await outputDirectory(path.dirname(target));
  await mkdir(path.dirname(target), { recursive: true });
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error('Public output files cannot be symlinks, hardlinks or non-files');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(target, raw);
}

async function approvedArtifacts(evidenceRoot, output) {
  if (evidenceRoot === undefined) return { files: [], manifestSha256: null };
  if (typeof evidenceRoot !== 'string' || !evidenceRoot) throw new Error('A reviewed evidence directory is required');
  const resolved = path.resolve(ROOT, evidenceRoot);
  const source = await realpath(resolved);
  if (resolved !== source) throw new Error('Reviewed evidence root cannot be a symlink');
  if (source === output || inside(output, source)) throw new Error('Evidence source must be separate from the generated output');
  const { raw: manifestRaw } = await regularFile(source, 'package-manifest.json', 2 * 1024 ** 2);
  const manifest = JSON.parse(manifestRaw);
  if (manifest.kind !== 'current-publication-release-manifest' || !manifest.files || typeof manifest.files !== 'object'
      || Array.isArray(manifest.files) || !Object.hasOwn(manifest.files, 'proof/index.html')) {
    throw new Error('An explicit reviewed public manifest and proof/index.html are required');
  }
  const selected = Object.entries(manifest.files).filter(([name]) => name.startsWith('proof/') || name.startsWith('docs/')
    || name.startsWith('third-party/') || ROOT_ARTIFACTS.has(name) || IDS.some(id => name.startsWith(`evidence/seeds/${id}/`)));
  if (!selected.length || selected.length > 2000) throw new Error('Public artifact member limit exceeded');
  const files = [];
  let total = 0;
  for (const [name, record] of selected) {
    if (!record || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || record.bytes > MAX_FILE || !/^[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error('Public artifact metadata is invalid');
    }
    const { raw, size } = await regularFile(source, name);
    total += size;
    if (total > MAX_TOTAL) throw new Error('Public artifact byte limit exceeded');
    if (size !== record.bytes || sha(raw) !== record.sha256) throw new Error('Reviewed public artifact hash changed');
    files.push({ name: name.startsWith('evidence/') ? `_demo/${name}` : name, raw });
  }
  // These two source-release metadata files intentionally exclude their own hashes.
  files.push({ name: 'package-manifest.json', raw: manifestRaw });
  const auditPath = path.join(source, 'package-audit.json');
  try {
    await lstat(auditPath);
    const { raw } = await regularFile(source, 'package-audit.json', 2 * 1024 ** 2);
    files.push({ name: 'package-audit.json', raw });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { files, manifestSha256: sha(manifestRaw) };
}

export async function buildPublicDemo({ outDir, parentOrigin, devLoopback = false, evidenceRoot } = {}) {
  if (devLoopback && parentOrigin !== undefined) throw new Error('Choose the exact hosted origin or explicit loopback development mode');
  if (typeof devLoopback !== 'boolean') throw new Error('Invalid loopback development option');
  if (!devLoopback && parentOrigin === undefined) throw new Error('Public builds require an exact HTTPS parent origin; use --dev-loopback only for local preview');
  const hostedParent = devLoopback ? undefined : validateHostedParentOrigin(parentOrigin);
  const output = await outputDirectory(outDir);
  const approved = await approvedArtifacts(evidenceRoot, output);
  const challenges = await getChallenges();
  if (!Array.isArray(challenges) || challenges.length !== IDS.length || IDS.some(id => challenges.filter(item => item.id === id).length !== 1)) {
    throw new Error('Public playback supports exactly the five shipped seed apps');
  }
  const files = [...approved.files];
  const fixtures = {};
  for (const id of IDS) {
    const manifest = challenges.find(item => item.id === id);
    fixtures[id] = {};
    for (const variant of ['buggy', 'fixed']) {
      const html = await buildCartridge({ challengeId: id, variant, parentOrigin: hostedParent });
      const name = `_demo/fixtures/${id}/${variant}.html`;
      const raw = Buffer.from(html);
      const source = await readFile(path.join(ROOT, 'fixtures', id, variant, 'App.tsx'));
      fixtures[id][variant] = { url: name, sha256: sha(raw), sourceSha256: sha(source), manifestSha256: hash(manifest), assertionHash: assertionHash(manifest) };
      files.push({ name, raw });
    }
  }
  const artifactIndex = Buffer.from(JSON.stringify({
    kind: 'static-artifact-index',
    files: Object.fromEntries(files.map(({ name, raw }) => [name, { bytes: raw.byteLength, sha256: sha(raw) }])),
  }, null, 2) + '\n');
  files.push({ name: '_demo/artifacts.json', raw: artifactIndex });
  const catalog = {
    version: 1, kind: 'static-seed-playback', parentOrigin: hostedParent ?? null,
    evidenceKind: 'client-playback-only', modelCalls: 0, challenges, fixtures,
    publicEvidenceManifestSha256: approved.manifestSha256,
    artifactIndex: { url: '_demo/artifacts.json', sha256: sha(artifactIndex) },
  };
  const catalogRaw = Buffer.from(JSON.stringify(catalog, null, 2) + '\n');
  if (catalogRaw.byteLength > 64000) throw new Error('Playable catalog exceeds the browser loader limit');
  files.push({ name: '.nojekyll', raw: Buffer.alloc(0) });
  // Vite's existing assets are left intact. Only this builder's explicit files are written.
  for (const { name, raw } of files) await writeOutput(output, name, raw);
  await writeOutput(output, '_demo/catalog.json', catalogRaw);
  return catalog;
}

function options(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dev-loopback') {
      if (Object.hasOwn(result, 'devLoopback')) throw new Error('Duplicate loopback option');
      result.devLoopback = true;
      continue;
    }
    const key = { '--out': 'outDir', '--out-dir': 'outDir', '--parent-origin': 'parentOrigin', '--evidence-root': 'evidenceRoot' }[arg];
    if (!key || Object.hasOwn(result, key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Unsupported or incomplete public build option');
    result[key] = args[++index];
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const catalog = await buildPublicDemo(options(process.argv.slice(2)));
    process.stdout.write(JSON.stringify({ status: 'built-locally', kind: catalog.kind, challenges: catalog.challenges.length, cartridges: Object.keys(catalog.fixtures).length * 2, parentOrigin: catalog.parentOrigin, providerCalls: 0, deployed: false }) + '\n');
  } catch (error) {
    process.stderr.write(`Public demo build failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
