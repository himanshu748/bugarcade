import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { bundleReactApp } from './react-bundler.mjs';
import { LIMITS, validateManifest } from './validation.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function getChallenges() { return JSON.parse(await readFile(path.join(ROOT, 'shared/challenges.json'), 'utf8')); }
export async function getManifest(challengeId, projectDir) {
  if (projectDir) {
    if (process.env.BUGARCADE_SANDBOX !== '1') throw new Error('Submitted projects require the Modal sandbox runner');
    const manifest = JSON.parse(await readFile(path.join(projectDir, 'manifest.json'), 'utf8'));
    return validateManifest({ ...manifest, id: challengeId });
  }
  const found = (await getChallenges()).find(item => item.id === challengeId);
  if (!found) throw new Error('Unknown challenge');
  return validateManifest(found);
}
const escapeHtml = text => text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
async function jsonBody(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('Request too large'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
export async function createFixtureServer({ port = 0, projectDir, challengeId: projectId } = {}) {
  const sessions = new Map(), bundles = new Map();
  const css = await readFile(path.join(ROOT, 'fixtures/app.css'));
  let origin;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? '/', origin ?? 'http://127.0.0.1');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type':'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (url.pathname === '/health') { send(200, { ready: true }); return; }
      if (url.pathname === '/app.css') { res.writeHead(200, { 'Content-Type':'text/css' }); res.end(css); return; }
      const fixtureMatch = url.pathname.match(/^\/fixture\/([a-zA-Z0-9_-]+)\/(buggy|fixed)$/);
      if (fixtureMatch) {
        const [, id, variant] = fixtureMatch;
        if (projectId && id !== projectId) throw new Error('Wrong project');
        const manifest = await getManifest(id, projectDir);
        let parentOrigin = url.searchParams.get('parentOrigin') ?? 'http://127.0.0.1:5173';
        const parentUrl = new URL(parentOrigin);
        if (!['127.0.0.1','localhost'].includes(parentUrl.hostname) || parentUrl.protocol !== 'http:' || parentUrl.origin !== parentOrigin) throw new Error('Invalid parent origin');
        for (const [key, s] of sessions) if (Date.now() - s.created > 300_000) { dispose(s); sessions.delete(key); }
        if (sessions.size >= LIMITS.sessions) throw new Error('Too many fixture sessions');
        const session = randomUUID();
        sessions.set(session, { manifest, created: Date.now(), pending: new Map(), used: new Set(), events: [], watchers: new Set(), eventsEmitter:new EventEmitter(), actionCount: 0 });
        const bundleKey = `${id}-${variant}`;
        if (!bundles.has(bundleKey)) {
          const appPath = path.join(projectDir ?? path.join(ROOT, 'fixtures', id), variant, 'App.tsx');
          if ((await readFile(appPath)).byteLength > LIMITS.sourceBytes) throw new Error('App source too large');
          const entry = `import App from ${JSON.stringify(appPath)}; import {mountHarness} from ${JSON.stringify(path.join(ROOT,'fixtures/harness.tsx'))}; mountHarness(App);`;
          const result = await bundleReactApp({ appPath, entry });
          bundles.set(bundleKey, result.outputFiles[0].contents);
        }
        const nonce = randomBytes(16).toString('base64');
        const config = JSON.stringify({ manifest, session, variant, origin, parentOrigin }).replaceAll('<','\\u003c');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'self'; connect-src ${origin}; img-src data:; base-uri 'none'; form-action 'none'; object-src 'none'; frame-ancestors http://127.0.0.1:* http://localhost:*`);
        res.writeHead(200, { 'Content-Type':'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(manifest.title)} · ${variant}</title><link rel="stylesheet" href="/app.css"></head><body><div id="app-root"></div><div id="harness-root"></div><script nonce="${nonce}">window.__BUGARCADE_CONFIG__=${config}</script><script src="/bundle/${bundleKey}.js" crossorigin="anonymous"></script></body></html>`);
        return;
      }
      const bundle = url.pathname.match(/^\/bundle\/([a-zA-Z0-9_-]+)\.js$/);
      if (bundle && bundles.has(bundle[1])) { res.writeHead(200, {'Content-Type':'text/javascript'}); res.end(bundles.get(bundle[1])); return; }
      const mock = url.pathname.match(/^\/mock\/([a-f0-9-]{36})\/(request|state|release|reset)$/);
      if (mock) {
        const [, id, op] = mock, session = sessions.get(id);
        if (!session) { send(404,{error:'Session expired. Reset the challenge.'}); return; }
        const snapshot = () => ({ pending:[...session.pending.keys()], events:session.events, completed:session.events.filter(e=>e.type==='release').map(e=>e.id) });
        const notify = () => { session.eventsEmitter.emit('change'); for (const fn of session.watchers) fn(snapshot()); session.watchers.clear(); };
        if (op === 'request' && req.method === 'POST') {
          const body = await jsonBody(req);
          const entry = session.manifest.schedule.find(e => e.key === body.key && !session.used.has(e.id));
          if (!entry || session.used.size >= LIMITS.requests) { send(422,{error:'No scheduled response for request'}); return; }
          session.used.add(entry.id);
          session.events.push({type:'request',id:entry.id,key:entry.key,payload:body.payload ?? null,atMs:Date.now()-session.created});
          session.pending.set(entry.id, { response:res, entry }); notify();
          req.on('close', () => { if (!res.writableEnded) { session.events.push({type:'connection-closed',id:entry.id,atMs:Date.now()-session.created}); } });
          return;
        }
        if (op === 'release' && req.method === 'POST') {
          const { request } = await jsonBody(req);
          const pending = session.pending.get(request);
          if (!pending) { send(409,{error:'Request has not arrived or was already released'}); return; }
          session.pending.delete(request);
          session.events.push({type:'release',id:request,status:pending.entry.status,response:pending.entry.response,atMs:Date.now()-session.created});
          pending.response.writeHead(pending.entry.status, {'Content-Type':'application/json'}); pending.response.end(JSON.stringify(pending.entry.response));
          notify(); send(200,snapshot()); return;
        }
        if (op === 'state') {
          const after = Number(url.searchParams.get('after') ?? '-1');
          if (after === session.events.length && url.searchParams.get('watch') === '1') {
            const timer = setTimeout(()=>{session.watchers.delete(finish);send(200,snapshot());}, 20_000);
            const finish = data => { clearTimeout(timer);send(200,data); };
            session.watchers.add(finish); req.on('close',()=>{clearTimeout(timer);session.watchers.delete(finish);});
          } else send(200,snapshot());
          return;
        }
        if (op === 'reset' && req.method === 'POST') { dispose(session);sessions.delete(id);send(200,{reset:true});return; }
      }
      send(404,{error:'Not found'});
    } catch (error) { if (!res.headersSent) send(400,{error:String(error.message).slice(0,200)}); else res.end(); }
  });
  function dispose(session) {
    for (const { response } of session.pending.values()) { if (!response.writableEnded) { response.writeHead(410,{'Content-Type':'application/json'});response.end('{"error":"Session reset"}'); } }
    for (const watcher of session.watchers) watcher({pending:[],events:[],completed:[]});
    session.watchers.clear();session.pending.clear();
  }
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, sessions, close:async()=>{for(const s of sessions.values())dispose(s);server.closeAllConnections();await new Promise(resolve=>server.close(resolve));} };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const instance = await createFixtureServer({ port:Number(process.env.FIXTURE_PORT ?? 4174) });
  process.stdout.write(`Fixture server ready at ${instance.origin}\n`);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{void instance.close().then(()=>process.exit(0));});
}
