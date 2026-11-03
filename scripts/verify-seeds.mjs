import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { getChallenges, ROOT } from '../worker/server.mjs';
import { runChallenge } from '../worker/executor.mjs';
import { minimizeActions } from '../worker/minimizer.mjs';
import { captureRecordingFrames } from './capture-recording.mjs';
import { hash, assertionHash } from '../worker/validation.mjs';

const started=performance.now(), manifests=await getChallenges(), all=[];
const packageJson=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
const lock=await readFile(path.join(ROOT,'package-lock.json'));
const selected=process.argv.slice(2);
const execNode=(script,env)=>new Promise((resolve,reject)=>{const proc=spawn(process.execPath,['--test',script],{cwd:ROOT,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});let output='';proc.stdout.on('data',d=>{if(output.length<200000)output+=d;});proc.stderr.on('data',d=>{if(output.length<200000)output+=d;});proc.on('error',reject);proc.on('close',code=>resolve({exitCode:code,output}));});
for(const manifest of manifests.filter(m=>!selected.length||selected.includes(m.id))){
  const seedStarted=performance.now(),dir=path.join(ROOT,'evidence','seeds',manifest.id);await mkdir(dir,{recursive:true});
  process.stdout.write(`${manifest.id}: executing authored initial sequence\n`);
  const initial={};
  for(const variant of ['buggy','fixed'])initial[variant]=await runChallenge({challengeId:manifest.id,variant,actions:manifest.initialActions,artifactDir:path.join(dir,'initial',variant)});
  if(initial.buggy.status!=='failed'||initial.fixed.status!=='passed')throw new Error(`${manifest.id}: initial sequence invalid: ${JSON.stringify(initial)}`);
  const minimized=await minimizeActions({manifest,actions:manifest.initialActions,maxProbes:20,run:async(variant,actions,probe)=>runChallenge({challengeId:manifest.id,variant,actions,artifactDir:path.join(dir,'minimization',`probe-${probe}-${variant}`),recordVideo:false})});
  await writeFile(path.join(dir,'minimization.json'),JSON.stringify(minimized,null,2));
  process.stdout.write(`${manifest.id}: ${minimized.initialCount} → ${minimized.minimizedCount} actions; verifying 3 buggy + 3 fixed\n`);
  const repetitions={buggy:[],fixed:[]};
  for(const variant of ['buggy','fixed'])for(let i=0;i<3;i++){
    const result=await runChallenge({challengeId:manifest.id,variant,actions:minimized.actions,artifactDir:path.join(dir,`${variant}-${i+1}`),recordVideo:i===0});
    repetitions[variant].push({status:result.status,elapsedMs:result.elapsedMs,result:`${variant}-${i+1}/result.json`,actual:result.assertion?.actual,error:result.error});
    if(result.status!==(variant==='buggy'?'failed':'passed'))throw new Error(`${manifest.id} ${variant} repetition ${i+1}: ${JSON.stringify(result)}`);
  }
  const sourceHashes={};for(const variant of ['buggy','fixed'])sourceHashes[variant]=hash(await readFile(path.join(ROOT,'fixtures',manifest.id,variant,'App.tsx')));
  const regression=`import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport path from 'node:path';\nimport {pathToFileURL} from 'node:url';\nconst root=process.env.BUGARCADE_ROOT??process.cwd();\nconst {runChallenge}=await import(pathToFileURL(path.join(root,'worker/executor.mjs')).href);\n// Run from the BugArcade repository. VARIANT=buggy must fail; VARIANT=fixed must pass.\n// This test executes the exact captured sequence; infrastructure errors also fail the test.\ntest(${JSON.stringify(manifest.title+' — intended invariant')},async()=>{\n const variant=process.env.VARIANT??'fixed';\n const result=await runChallenge({challengeId:${JSON.stringify(manifest.id)},variant,actions:${JSON.stringify(minimized.actions)},assertionHash:${JSON.stringify(assertionHash(manifest))},artifactDir:path.join(root,'evidence','regression-runs',${JSON.stringify(manifest.id)},variant),recordVideo:false});\n assert.equal(result.status,'passed',JSON.stringify({status:result.status,assertion:result.assertion,error:result.error}));\n});\n`;
  await writeFile(path.join(dir,'regression.test.mjs'),regression);
  const regressionResults={};
  for(const variant of ['buggy','fixed']){const result=await execNode(path.join(dir,'regression.test.mjs'),{VARIANT:variant});regressionResults[variant]={exitCode:result.exitCode,log:`regression-${variant}.txt`};await writeFile(path.join(dir,`regression-${variant}.txt`),result.output);if(result.exitCode!==(variant==='buggy'?1:0))throw new Error(`${manifest.id}: exported regression ${variant} unexpected exit ${result.exitCode}`);const outcome=JSON.parse(await readFile(path.join(ROOT,'evidence','regression-runs',manifest.id,variant,'result.json'),'utf8'));if(outcome.status!==(variant==='buggy'?'failed':'passed')||outcome.assertion?.hash!==assertionHash(manifest))throw new Error(`${manifest.id}: exported regression ${variant} did not verify frozen invariant`);regressionResults[variant].status=outcome.status;regressionResults[variant].assertionHash=outcome.assertion.hash;}
  await captureRecordingFrames(manifest.id);
  const finalResult=JSON.parse(await readFile(path.join(dir,'buggy-1','result.json'),'utf8'));
  const summary={schemaVersion:1,id:manifest.id,title:manifest.title,verified:true,evidenceKind:'captured-local-browser',mode:'recorded',provenance:{planner:'authored-seed-plan',liveModel:false,model:null,modelCalls:0,promptTokens:0,completionTokens:0,estimatedCostUsd:0,note:'Authored initial plans, real browser capture. No live Meta call was made.'},seed:0,sourceHashes,manifestHash:hash(manifest),lockfileHash:hash(lock),dependencies:{...packageJson.dependencies,...packageJson.devDependencies},browserVersion:finalResult.browserVersion,assertion:{...manifest.assertion,hash:assertionHash(manifest)},completion:manifest.completion,schedule:manifest.schedule,initialActions:manifest.initialActions,actions:minimized.actions,initialActionCount:minimized.initialCount,minimizedActionCount:minimized.minimizedCount,minimality:minimized.minimality,repetitions,reproductionRate:{failures:3,attempts:3,rate:1},fixedPassRate:{passes:3,attempts:3,rate:1},initialResults:{buggy:initial.buggy.status,fixed:initial.fixed.status},regressionResults,elapsedMs:Math.round(performance.now()-seedStarted),artifacts:{regression:'regression.test.mjs',recording:'recording.json',buggyTrace:'buggy-1/trace.zip',fixedTrace:'fixed-1/trace.zip',buggyScreenshot:'buggy-1/final.png',fixedScreenshot:'fixed-1/final.png',minimization:'minimization.json'},limits:'Three repetitions under one controlled schedule establish repeatability for this seed only. No held-out/generalization or live-provider evidence.'};
  await writeFile(path.join(dir,'summary.json'),JSON.stringify(summary,null,2));all.push(summary);
  process.stdout.write(`${manifest.id}: VERIFIED; regression exits buggy=1, fixed=0\n`);
}
await writeFile(path.join(ROOT,'evidence','seed-verification.json'),JSON.stringify({generatedAt:new Date().toISOString(),elapsedMs:Math.round(performance.now()-started),seeds:all.map(s=>({id:s.id,verified:s.verified,actions:s.minimizedActionCount,initial:s.initialActionCount,reproductionRate:s.reproductionRate,fixedPassRate:s.fixedPassRate,summary:`seeds/${s.id}/summary.json`})),scope:'Known seed fixtures; not a held-out evaluation',liveModelCalls:0,cloudExecutions:0},null,2));
process.stdout.write(`Verified ${all.length} seeds in ${Math.round((performance.now()-started)/1000)}s\n`);
