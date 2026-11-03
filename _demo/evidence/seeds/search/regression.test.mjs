import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.BUGARCADE_ROOT??process.cwd();
const {runChallenge}=await import(pathToFileURL(path.join(root,'worker/executor.mjs')).href);
// Run from the BugArcade repository. VARIANT=buggy must fail; VARIANT=fixed must pass.
// This test executes the exact captured sequence; infrastructure errors also fail the test.
test("Results from another time — intended invariant",async()=>{
 const variant=process.env.VARIANT??'fixed';
 const result=await runChallenge({challengeId:"search",variant,actions:[{"type":"fill","target":"query","value":"re"},{"type":"fill","target":"query","value":"react"},{"type":"release","request":"search-2"},{"type":"release","request":"search-1"}],assertionHash:"893c9cce37d2f1efa7f064e4d54cbd034ca544daba5a81bbb1eea8eca3a2a8a3",artifactDir:path.join(root,'evidence','regression-runs',"search",variant),recordVideo:false});
 assert.equal(result.status,'passed',JSON.stringify({status:result.status,assertion:result.assertion,error:result.error}));
});
