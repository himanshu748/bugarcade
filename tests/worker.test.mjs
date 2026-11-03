import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { getChallenges, createFixtureServer, getManifest, ROOT } from '../worker/server.mjs';
import { validateActions, validateManifest, assertionHash } from '../worker/validation.mjs';
import { minimizeActions } from '../worker/minimizer.mjs';
import { runChallenge } from '../worker/executor.mjs';

const manifests=await getChallenges();
test('all five seed contracts have valid bounded actions and immutable completion checkpoints',()=>{
  assert.equal(manifests.length,5);
  for(const manifest of manifests){validateManifest(manifest);validateActions(manifest.initialActions,manifest);assert.match(assertionHash(manifest),/^[a-f0-9]{64}$/);}
});
test('rejects arbitrary action code, unknown targets, overlong input and excessive actions',()=>{
  const manifest=manifests[0];
  for(const plan of [[{type:'evaluate',code:'fetch(\"https://evil.test\")'}],[{type:'click',target:'body'}],[{type:'click',target:'sync',code:'alert(1)'}],[{type:'fill',target:'draft',value:'a'.repeat(1001)}],Array.from({length:13},()=>({type:'click',target:'sync'})),[{type:'release',request:'not-scheduled'}]])assert.throws(()=>validateActions(plan,manifest));
});
test('rejects unsupported variants, external artifact paths and changed assertions as errors',async()=>{
  for(const request of [{challengeId:'lost-note',variant:'escape'},{challengeId:'lost-note',variant:'buggy',artifactDir:'/tmp/stolen'},{challengeId:'lost-note',variant:'buggy',assertionHash:'changed'}]){
    const result=await runChallenge(request);assert.equal(result.status,'error');
  }
});
test('uploaded projects cannot be executed by local development worker',async()=>{
  const previous=process.env.BUGARCADE_SANDBOX;delete process.env.BUGARCADE_SANDBOX;
  try{await assert.rejects(()=>getManifest('upload','/tmp/project'),/Modal sandbox/);}finally{if(previous)process.env.BUGARCADE_SANDBOX=previous;}
});
test('minimizer rejects vacuous failure if fixed also fails and holds assertion constant',async()=>{
  const manifest=manifests[0];
  const result=await minimizeActions({manifest,actions:manifest.initialActions,run:async(variant,actions)=>({status:actions.some(a=>a.type==='click'&&a.target==='add-note')?(variant==='buggy'?'failed':'passed'):'failed'})});
  assert.ok(result.actions.some(a=>a.type==='click'&&a.target==='add-note'));assert.equal(result.assertionHash,assertionHash(manifest));
  assert.ok(result.probes.some(p=>p.fixed==='failed'&&!p.accepted));
});
test('minimizer does not treat infra failure as reproduced',async()=>{
  const result=await minimizeActions({manifest:manifests[0],actions:manifests[0].actions,run:async()=>({status:'error'})});
  assert.deepEqual(result.actions,manifests[0].actions);
});
test('real simulator holds requests until explicit release and records ordering',async()=>{
  const server=await createFixtureServer();
  try{
    const html=await(await fetch(server.origin+'/fixture/lost-note/buggy')).text();
    const session=JSON.parse(html.match(/window\.__BUGARCADE_CONFIG__=(.*?)<\/script>/)[1]).session;
    const request=fetch(`${server.origin}/mock/${session}/request`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:'save',payload:{notes:['x']}})});
    let state;
    for(let attempt=0;attempt<10;attempt++){state=await(await fetch(`${server.origin}/mock/${session}/state?watch=1&after=0`)).json();if(state.pending.includes('save-1'))break;}
    assert.deepEqual(state.pending,['save-1']);
    const released=await fetch(`${server.origin}/mock/${session}/release`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:'save-1'})});assert.equal(released.status,200);
    assert.deepEqual(await(await request).json(),{saved:true});
    const log=await released.json();assert.deepEqual(log.events.map(e=>e.type),['request','release']);
    const duplicate=await fetch(`${server.origin}/mock/${session}/release`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:'save-1'})});assert.equal(duplicate.status,409);
  }finally{await server.close();}
});
test('real buggy and fixed lost-note app differ under identical schedule', {timeout:60_000},async()=>{
  const base=path.join(ROOT,'evidence','worker-tests');
  const buggy=await runChallenge({challengeId:'lost-note',variant:'buggy',artifactDir:path.join(base,'buggy')});
  const fixed=await runChallenge({challengeId:'lost-note',variant:'fixed',artifactDir:path.join(base,'fixed')});
  assert.equal(buggy.status,'failed',JSON.stringify(buggy.error));assert.equal(fixed.status,'passed',JSON.stringify(fixed.error));
  assert.equal(buggy.assertion.hash,fixed.assertion.hash);assert.deepEqual(buggy.schedule,fixed.schedule);
});
test('missing completion is execution error, never reproduced', {timeout:30_000},async()=>{
  const result=await runChallenge({challengeId:'lost-note',variant:'buggy',actions:[],artifactDir:path.join(ROOT,'evidence','worker-tests','incomplete'),recordVideo:false});
  assert.equal(result.status,'error');assert.equal(result.assertion,undefined);
});
test('deadline before browser readiness cannot produce a positive reproduction', {timeout:30_000},async()=>{
 const result=await runChallenge({challengeId:'lost-note',variant:'buggy',timeoutMs:1,artifactDir:path.join(ROOT,'evidence','worker-tests','deadline'),recordVideo:false});
 assert.equal(result.status,'error');assert.equal(result.error.code,'RUN_TIMEOUT');assert.equal(result.artifacts.recording,undefined);
});
test('capture without video never advertises a nonexistent recording', {timeout:30_000},async()=>{
 const result=await runChallenge({challengeId:'lost-note',variant:'fixed',artifactDir:path.join(ROOT,'evidence','worker-tests','no-video'),recordVideo:false});
 assert.equal(result.status,'passed');assert.equal(result.artifacts.recording,undefined);assert.equal(result.artifacts.trace,'trace.zip');
});
test('main-world prototype and harness tampering cannot forge driver reads or simulator releases', {timeout:30_000},async()=>{
 const {chromium}=await import('playwright');const {expect}=await import('@playwright/test');
 const server=await createFixtureServer();let browser;
 try{
  browser=await chromium.launch({headless:true,channel:'chromium'});const page=await browser.newPage();
  await page.goto(server.origin+'/fixture/lost-note/buggy');await page.getByTestId('sync').waitFor();
  await page.evaluate(()=>{
    window.__BUGARCADE_HARNESS__.release=async()=>{throw new Error('Untrusted harness override must never run');};
    Document.prototype.querySelector=function(){return null;};
    const descriptor=Object.getOwnPropertyDescriptor(Node.prototype,'textContent');
    Object.defineProperty(Node.prototype,'textContent',{...descriptor,get(){return 'forged expected value';}});
  });
  await page.getByTestId('sync').click();await page.getByTestId('add-note').click();
  const sessionId=[...server.sessions.keys()][0],session=server.sessions.get(sessionId);
  if(!session.pending.has('save-1'))await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Request failed to arrive')),2500);
    const check=()=>{if(session.pending.has('save-1')){clearTimeout(timeout);session.eventsEmitter.off('change',check);resolve();}};
    session.eventsEmitter.on('change',check);check();
  });
  const response=await fetch(`${server.origin}/mock/${sessionId}/release`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:'save-1'})});assert.equal(response.status,200);
  await expect(page.getByTestId('sync-state')).toHaveText('Synced · 1 added');
  assert.equal((await page.getByTestId('notes').textContent()).trim(),'Ship the rough cut');
  assert.equal(await page.evaluate(()=>document.getElementById('app-root').textContent),'forged expected value');
  assert.equal(await page.evaluate(()=>document.querySelector('body')),null);
  assert.deepEqual(session.events.filter(event=>event.type==='release').map(event=>event.id),['save-1']);
 }finally{await browser?.close();await server.close();}
});
test('offline cartridge refuses submitted compilation outside Modal',async()=>{
 const {buildCartridge}=await import('../worker/cartridge.mjs');const previous=process.env.BUGARCADE_SANDBOX;delete process.env.BUGARCADE_SANDBOX;
 try{await assert.rejects(()=>buildCartridge({challengeId:'submitted-app',variant:'buggy',projectDir:'/tmp/project'}),/Modal sandbox/);}finally{if(previous)process.env.BUGARCADE_SANDBOX=previous;}
});
test('all ten offline seed cartridges replay in opaque scripts-only iframe with expected outcomes', {timeout:120_000},async()=>{
 const {buildCartridge}=await import('../worker/cartridge.mjs');const {chromium}=await import('playwright');const {expect}=await import('@playwright/test');const {mkdir,writeFile}=await import('node:fs/promises');
 const browser=await chromium.launch({headless:true,channel:'chromium'}),results=[];
 try{for(const manifest of manifests)for(const variant of ['buggy','fixed']){
  const html=await buildCartridge({challengeId:manifest.id,variant}),context=await browser.newContext({viewport:{width:950,height:820}}),page=await context.newPage();
  await page.route('http://127.0.0.1:5173/cartridge-verification',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><head><title>Cartridge verification</title></head><body></body></html>'}));
  await page.goto('http://127.0.0.1:5173/cartridge-verification');
  await page.evaluate(html=>{const frame=document.createElement('iframe');frame.id='cartridge';frame.setAttribute('sandbox','allow-scripts');frame.style.cssText='width:920px;height:780px;border:0';window.addEventListener('message',event=>{if(event.source===frame.contentWindow)window.cartridgeState=event.data;});frame.onload=()=>frame.contentWindow.postMessage({type:'bugarcade:bind-parent'},'*');frame.srcdoc=html;document.body.append(frame);},html);
  const frame=page.frameLocator('#cartridge');await frame.getByTestId(manifest.completion.target).waitFor();
  await page.evaluate(actions=>document.getElementById('cartridge').contentWindow.postMessage({type:'bugarcade:replay',actions},'*'),manifest.actions);
  await expect(frame.getByTestId(manifest.completion.target)).toHaveText(manifest.completion.value,{timeout:8000});
  const actual=(await frame.getByTestId(manifest.assertion.target).textContent()).trim();
  const pass=manifest.assertion.operator==='contains'?actual.includes(manifest.assertion.expected):actual===manifest.assertion.expected;
  assert.equal(pass,variant==='fixed',`${manifest.id} ${variant}: ${actual}`);
  await expect(frame.getByText('Offline cartridge · simulated network · UI feedback only. Captured browser evidence is the verification record.')).toBeVisible();
  const dir=path.join(ROOT,'evidence','cartridges',manifest.id,variant);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,'player.html'),html);await page.screenshot({path:path.join(dir,'playback.png')});
  results.push({id:manifest.id,variant,expectedPass:variant==='fixed',observedPass:pass,actual,bytes:Buffer.byteLength(html),screenshot:`${manifest.id}/${variant}/playback.png`});await context.close();
 }}finally{await browser.close();}
 await writeFile(path.join(ROOT,'evidence','cartridges','verification.json'),JSON.stringify({kind:'offline-browser-playback',notAuthoritativeRegressionEvidence:true,results},null,2));
});
test('offline cartridge manual play and reset work; connect CSP and source checks block foreign requests', {timeout:30_000},async()=>{
 const {buildCartridge}=await import('../worker/cartridge.mjs');const {chromium}=await import('playwright');const {expect}=await import('@playwright/test');
 const html=await buildCartridge({challengeId:'lost-note',variant:'buggy'}),browser=await chromium.launch({headless:true,channel:'chromium'});const external=[];
 try{
  const page=await browser.newPage();page.on('request',request=>{if(request.url().startsWith('https://example.com'))external.push(request.url());});
  await page.route('http://127.0.0.1:5173/cartridge-verification',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto('http://127.0.0.1:5173/cartridge-verification');
  await page.evaluate(html=>{const frame=document.createElement('iframe');frame.id='cartridge';frame.setAttribute('sandbox','allow-scripts');frame.style.cssText='width:920px;height:780px';frame.onload=()=>frame.contentWindow.postMessage({type:'bugarcade:bind-parent'},'*');frame.srcdoc=html;document.body.append(frame);},html);
  const frame=page.frameLocator('#cartridge');await frame.getByTestId('sync').waitFor();const child=page.frames().find(item=>item.parentFrame()!==null);
  await child.evaluate(()=>{
   window.postMessage({type:'bugarcade:replay',actions:[{type:'click',target:'sync'}]},'*');
   window.dispatchEvent(new MessageEvent('message',{origin:'https://foreign.invalid',source:window.parent,data:{type:'bugarcade:replay',actions:[{type:'click',target:'sync'}]}}));
  });
  await expect(frame.getByTestId('sync-state')).toHaveText('All changes local · 0 added');
  assert.equal(await child.evaluate(async()=>{try{await fetch('https://example.com/');return false;}catch{return true;}}),true);assert.equal(external.length,0);
  await frame.getByTestId('sync').click();await frame.getByTestId('add-note').click();await frame.getByTestId('release-save-1').click();
  await expect(frame.getByTestId('sync-state')).toHaveText('Synced · 1 added');await expect(frame.getByTestId('notes')).toHaveText('Ship the rough cut');
  await frame.getByTestId('cartridge-reset').click();await expect(frame.getByTestId('sync-state')).toHaveText('All changes local · 0 added');
  await frame.getByTestId('cartridge-replay').click();await expect(frame.getByTestId('sync-state')).toHaveText('Synced · 1 added');
 }finally{await browser.close();}
});

test('cartridge binds only its loopback parent once and supports both UI ports', {timeout:40_000},async()=>{
 const {buildCartridge}=await import('../worker/cartridge.mjs');const {chromium}=await import('playwright');const {expect}=await import('@playwright/test');
 const {writeFile}=await import('node:fs/promises');const browser=await chromium.launch({headless:true,channel:'chromium'});const results=[];
 try{for(const origin of ['http://127.0.0.1:5173','http://127.0.0.1:4173','https://foreign.invalid']){
  const context=await browser.newContext(),page=await context.newPage();
  await page.route(`${origin}/binding-test`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body></body></html>'}));await page.goto(`${origin}/binding-test`);
  const html=await buildCartridge({challengeId:'lost-note',variant:'buggy'});
  await page.evaluate(html=>{const f=document.createElement('iframe');f.id='cartridge';f.sandbox='allow-scripts';f.style.cssText='width:920px;height:780px';f.srcdoc=html;window.states=[];window.addEventListener('message',e=>{if(e.source===f.contentWindow)window.states.push(e.data);});document.body.append(f);},html);
  const child=page.frames().find(frame=>frame.parentFrame()!==null);await child.waitForLoadState('load');await child.locator('#app-root').waitFor({state:'attached'});
  await child.evaluate(async()=>{
   await new Promise(resolve=>{const seen=event=>{if(event.source===window&&event.data?.type==='bugarcade:bind-parent'){window.removeEventListener('message',seen);resolve();}};window.addEventListener('message',seen);window.postMessage({type:'bugarcade:bind-parent'},'*');});
   window.dispatchEvent(new MessageEvent('message',{source:window.parent,origin:'https://foreign.invalid',data:{type:'bugarcade:bind-parent'}}));
   window.parentBindObserved=new Promise(resolve=>{const seen=event=>{if(event.source===window.parent&&event.data?.type==='bugarcade:bind-parent'){window.removeEventListener('message',seen);resolve();}};window.addEventListener('message',seen);});
  });
  assert.equal(await child.getByTestId('sync').count(),0);
  await page.evaluate(()=>document.getElementById('cartridge').contentWindow.postMessage({type:'bugarcade:bind-parent'},'*'));
  await child.evaluate(()=>window.parentBindObserved);
  if(origin.startsWith('https:')){
   assert.equal(await child.getByTestId('sync').count(),0);results.push({origin,bound:false});
  }else{
   await child.getByTestId('sync').click();
   await expect.poll(()=>page.evaluate(()=>window.states.some(state=>state.ready&&state.moves===1))).toBe(true);
   assert.equal(await child.evaluate(()=>window.__BUGARCADE_CONFIG__.parentOrigin),origin);
   await child.evaluate(()=>window.dispatchEvent(new MessageEvent('message',{source:window.parent,origin:'http://localhost:9999',data:{type:'bugarcade:bind-parent'}})));
   assert.equal(await child.evaluate(()=>window.__BUGARCADE_CONFIG__.parentOrigin),origin);results.push({origin,bound:true,parentReceivedMoves:1,rebindRejected:true});
  }
  await context.close();
 }}finally{await browser.close();}
 await writeFile(path.join(ROOT,'evidence/regression-preflight/origin-handshake.json'),JSON.stringify({mode:'real-local-browser',results},null,2));
});
