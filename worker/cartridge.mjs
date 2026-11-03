import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { bundleReactApp } from './react-bundler.mjs';
import { getManifest, ROOT } from './server.mjs';
import { validateActions, LIMITS, assertionHash } from './validation.mjs';

const escapeHtml=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export async function buildCartridge({challengeId,variant,projectDir,actions}){
  if(!['buggy','fixed'].includes(variant))throw new Error('Unsupported cartridge variant');
  // getManifest rejects submitted projectDir outside the Modal worker.
  const manifest=await getManifest(challengeId,projectDir);
  const plan=validateActions(actions??manifest.actions,manifest);
  const appPath=path.join(projectDir??path.join(ROOT,'fixtures',challengeId),variant,'App.tsx');
  if((await readFile(appPath)).byteLength>LIMITS.sourceBytes)throw new Error('App source exceeds 64 KiB');
  const source=`import App from ${JSON.stringify(appPath)};import {mountHarness} from ${JSON.stringify(path.join(ROOT,'fixtures/harness.tsx'))};import {createCartridgeTransport} from ${JSON.stringify(path.join(ROOT,'fixtures/cartridge-transport.ts'))};const config=window.__BUGARCADE_CONFIG__;let state=${Number(manifest.seed??0)>>>0};Math.random=()=>{state+=0x6D2B79F5;let v=state;v=Math.imul(v^(v>>>15),v|1);v^=v+Math.imul(v^(v>>>7),v|61);return ((v^(v>>>14))>>>0)/4294967296;};const mount=()=>mountHarness(App,createCartridgeTransport(config));if(window.parent===window){mount();}else{const bind=event=>{if(event.source!==window.parent||!event.data||event.data.type!=='bugarcade:bind-parent')return;let parent;try{parent=new URL(event.origin);}catch{return;}if(parent.protocol!=='http:'||!['127.0.0.1','localhost'].includes(parent.hostname)||parent.origin!==event.origin)return;config.parentOrigin=event.origin;window.removeEventListener('message',bind);mount();};window.addEventListener('message',bind);}`;
  const bundle=await bundleReactApp({appPath,entry:source,minify:true,sourcemap:false});
  const nonce=randomBytes(18).toString('base64');
  const config={manifest:{...manifest,actions:plan},session:'offline',variant,origin:'https://bugarcade.invalid',parentOrigin:'',mode:'offline-cartridge',evidenceKind:'client-playback-only',assertionHash:assertionHash(manifest)};
  const data=JSON.stringify(config).replaceAll('<','\\u003c');
  const script=bundle.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
  const css=(await readFile(path.join(ROOT,'fixtures/app.css'),'utf8')).replace(/<\/style/gi,'<\\/style');
  const csp=`default-src 'none'; connect-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'`;
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(manifest.title)} · ${variant} · BugArcade cartridge</title><style nonce="${nonce}">${css}</style></head><body><div id="app-root"></div><div id="harness-root"></div><script nonce="${nonce}">window.__BUGARCADE_CONFIG__=${data};\n${script}</script></body></html>`;
  if(Buffer.byteLength(html)>8*1024*1024)throw new Error('Offline cartridge exceeds 8 MiB');
  return html;
}
