import { chromium } from 'playwright';
import { expect } from '@playwright/test';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFixtureServer, getManifest, ROOT } from './server.mjs';
import { buildCartridge } from './cartridge.mjs';
import { validateActions, assertionHash, LIMITS } from './validation.mjs';

async function observed(page, target) {
  return (await page.getByTestId(target).textContent()).trim();
}
export async function runChallenge(request) {
  const started=performance.now(), {challengeId,variant,projectDir}=request;
  const actionEvents=[],consoleEvents=[],screenshots=[];
  let server,browser,context,page,manifest,artifactDir,video,sessionId;
  let result={status:'error',actions:[],schedule:[],browserVersion:null,elapsedMs:0,artifacts:{},error:null};
  let timedOut=false,outputLimited=false,networkRequests=0,consoleMessages=0;
  const timeout=setTimeout(()=>{timedOut=true;void browser?.close();},Math.min(Number(request.timeoutMs) || LIMITS.runMs,LIMITS.runMs));
  try {
    if(!['buggy','fixed'].includes(variant))throw new Error('Unsupported variant');
    manifest=await getManifest(challengeId,projectDir);
    const actions=validateActions(request.actions ?? manifest.actions,manifest);
    if(request.assertionHash && request.assertionHash!==assertionHash(manifest))throw new Error('Frozen assertion hash mismatch');
    const allowedRoot=process.env.BUGARCADE_SANDBOX==='1'?'/tmp/evidence':path.join(ROOT,'evidence');
    const candidateDir=path.resolve(request.artifactDir ?? path.join(allowedRoot,'runs',randomUUID()));
    if(candidateDir!==allowedRoot && !candidateDir.startsWith(path.resolve(allowedRoot)+path.sep))throw new Error('Artifact directory is outside evidence root');
    artifactDir=candidateDir;
    await mkdir(artifactDir,{recursive:true});
    server=await createFixtureServer({projectDir,challengeId});
    browser=await chromium.launch({headless:true,channel:'chromium',args:['--disable-dev-shm-usage'],...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    if(timedOut)throw new Error('Run deadline exceeded before browser became ready');
    result.browserVersion=browser.version();
    context=await browser.newContext({viewport:{width:920,height:740},serviceWorkers:'block',acceptDownloads:false,recordVideo:request.recordVideo===false?undefined:{dir:path.join(artifactDir,'video'),size:{width:920,height:740}}});
    await context.addInitScript(({seed})=>{
      let state=seed>>>0;
      Math.random=()=>{state+=0x6D2B79F5;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return ((value^(value>>>14))>>>0)/4294967296;};
    },{seed:manifest.seed??0});
    await context.route('**/*',route=>{
      if(++networkRequests>128){outputLimited=true;void browser.close();return route.abort('blockedbyclient');}
      const url=new URL(route.request().url());
      if(url.origin===server.origin && /^\/(fixture\/|bundle\/|app\.css$|mock\/)/.test(url.pathname))return route.continue();
      if(consoleEvents.length<100)consoleEvents.push({type:'blocked-network',url:`${url.protocol}//${url.hostname}`,atMs:Math.round(performance.now()-started)});
      return route.abort('blockedbyclient');
    });
    if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
    await context.tracing.start({screenshots:true,snapshots:true,sources:true});
    page=await context.newPage();
    page.on('console',message=>{if(++consoleMessages>200){outputLimited=true;void browser.close();return;}if(consoleEvents.length<100)consoleEvents.push({type:message.type(),text:message.text().slice(0,1000),atMs:Math.round(performance.now()-started)});});
    page.on('pageerror',error=>{if(consoleEvents.length<100)consoleEvents.push({type:'pageerror',text:error.message.slice(0,1000),atMs:Math.round(performance.now()-started)});});
    page.setDefaultTimeout(LIMITS.actionMs);
    await page.goto(`${server.origin}/fixture/${challengeId}/${variant}`,{waitUntil:'domcontentloaded',timeout:8000});
    sessionId=[...server.sessions.keys()][0];
    if(!sessionId)throw new Error('Fixture session was not created');
    await page.getByTestId(manifest.completion.target).waitFor({state:'attached',timeout:8000});
    video=page.video();
    await page.screenshot({path:path.join(artifactDir,'frame-00.png')});screenshots.push({timestampMs:Math.round(performance.now()-started),path:'frame-00.png',actionIndex:-1});
    for(let index=0;index<actions.length;index++){
      const action=actions[index],before=performance.now();
      if(action.type==='click')await page.getByTestId(action.target).click();
      else if(action.type==='fill'){await page.getByTestId(action.target).fill(action.value);await page.getByTestId(action.target).dispatchEvent('change');}
      else if(action.type==='release'){
        const session=server.sessions.get(sessionId);
        if(!session.pending.has(action.request))await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>{session.eventsEmitter.off('change',check);reject(new Error('Scheduled request did not arrive: '+action.request));},LIMITS.actionMs);
          const check=()=>{if(session.pending.has(action.request)){clearTimeout(timer);session.eventsEmitter.off('change',check);resolve();}};session.eventsEmitter.on('change',check);check();
        });
        const response=await fetch(`${server.origin}/mock/${sessionId}/release`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:action.request})});
        if(!response.ok)throw new Error('Authoritative simulator release failed');
      }
      else if(action.type==='wait')await expect(page.getByTestId(action.target)).toHaveText(action.value,{timeout:LIMITS.actionMs});
        actionEvents.push({index,action,atMs:Math.round(before-started),elapsedMs:Math.round(performance.now()-before),status:'executed'});
      const frameName=`frame-${String(index+1).padStart(2,'0')}.png`;
      await page.screenshot({path:path.join(artifactDir,frameName)});screenshots.push({timestampMs:Math.round(performance.now()-started),path:frameName,actionIndex:index});
    }
    await expect(page.getByTestId(manifest.completion.target)).toHaveText(manifest.completion.value,{timeout:LIMITS.actionMs});
    if(consoleEvents.some(event=>event.type==='pageerror'))throw new Error('App emitted an uncaught exception; no reproduction verdict');
    if(timedOut)throw new Error('Run deadline exceeded');
    const rule=manifest.assertion;
    const actual=rule.operator==='count'?await page.getByTestId(rule.target).count():await observed(page,rule.target);
    const pass=rule.operator==='contains'?String(actual).includes(String(rule.expected)):actual===rule.expected;
    const network=await (await fetch(`${server.origin}/mock/${sessionId}/state`)).json();
    const plannedReleases=actions.filter(action=>action.type==='release').map(action=>action.request);
    const observedReleases=network.events.filter(event=>event.type==='release').map(event=>event.id);
    if(JSON.stringify(plannedReleases)!==JSON.stringify(observedReleases))throw new Error('Network release provenance differs from executed plan');
    result={...result,status:pass?'passed':'failed',assertion:{...rule,actual,pass,hash:assertionHash(manifest),completion:manifest.completion},actions:actionEvents,schedule:manifest.schedule,network:network.events,seed:manifest.seed??0,rngPolicy:'Seeded Math.random; real wall clock; controlled request schedule',variant,challengeId,error:null};
    await page.screenshot({path:path.join(artifactDir,'final.png'),fullPage:false});
    const player=await buildCartridge({challengeId,variant,projectDir,actions});
    await writeFile(path.join(artifactDir,'player.html'),player);
  } catch(error) {
    result={...result,status:'error',error:{code:timedOut?'RUN_TIMEOUT':outputLimited?'OUTPUT_LIMIT':'EXECUTION_ERROR',message:String(error.message).slice(0,600)},actions:actionEvents};
    if(page && !page.isClosed() && artifactDir)await page.screenshot({path:path.join(artifactDir,'error.png')}).catch(()=>{});
  } finally {
    clearTimeout(timeout);
    if(context){
      if(artifactDir)await context.tracing.stop({path:path.join(artifactDir,'trace.zip')}).catch(()=>{});
      await context.close().catch(()=>{});
      if(video && artifactDir)await video.saveAs(path.join(artifactDir,'recording.webm')).catch(()=>{});
    }
    if(browser)await browser.close().catch(()=>{});
    if(server)await server.close().catch(()=>{});
    result.elapsedMs=Math.round(performance.now()-started);
    if(artifactDir){
      await writeFile(path.join(artifactDir,'actions.json'),JSON.stringify(actionEvents,null,2));
      await writeFile(path.join(artifactDir,'console.json'),JSON.stringify(consoleEvents,null,2));
      await writeFile(path.join(artifactDir,'network.json'),JSON.stringify({schedule:manifest?.schedule??[],events:result.network??[]},null,2));
      await writeFile(path.join(artifactDir,'frames.json'),JSON.stringify({kind:'captured-browser-screenshots',frames:screenshots,warning:'Frames are sampled after actions. Trace contains event ordering; fast interactions can occur between frames.'},null,2));
      const candidates={actions:'actions.json',console:'console.json',schedule:'network.json',trace:'trace.zip',screenshot:result.status==='error'?'error.png':'final.png',frames:'frames.json'};
      if(request.recordVideo!==false)candidates.recording='recording.webm';
      if(result.status!=='error')candidates.player='player.html';
      const artifacts={result:'result.json'};let artifactBytes=0;
      for(const [kind,name] of Object.entries(candidates)){
        try{const info=await stat(path.join(artifactDir,name));if(info.size===0)throw new Error('Empty artifact');if(info.size>8*1024*1024)throw new Error('Artifact exceeds 8 MiB');artifactBytes+=info.size;artifacts[kind]=name;}
        catch(cause){if(result.status!=='error')result={...result,status:'error',error:{code:'CAPTURE_ERROR',message:`Required ${kind} artifact unavailable: ${cause.message}`}};}
      }
      if(artifactBytes>32*1024*1024)result={...result,status:'error',error:{code:'OUTPUT_LIMIT',message:'Captured artifacts exceed 32 MiB'}};
      result.artifacts=artifacts;
      await writeFile(path.join(artifactDir,'result.json'),JSON.stringify(result,null,2));
    }
  }
  return result;
}
