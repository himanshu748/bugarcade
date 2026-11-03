import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.BUGARCADE_ROOT??process.cwd();
const {runChallenge}=await import(pathToFileURL(path.join(root,'worker/executor.mjs')).href);
// Run from the BugArcade repository. VARIANT=buggy must fail; VARIANT=fixed must pass.
// This test executes the exact captured sequence; infrastructure errors also fail the test.
test("The undo from the past — intended invariant",async()=>{
 const variant=process.env.VARIANT??'fixed';
 const result=await runChallenge({challengeId:"rollback",variant,actions:[{"type":"click","target":"rename-weekend"},{"type":"click","target":"rename-launch"},{"type":"release","request":"rename-2"},{"type":"release","request":"rename-1"}],assertionHash:"fb659c01403c03fb9127fe29f5a8105416c48c1fc1c56d50c12a0fd219f37bac",artifactDir:path.join(root,'evidence','regression-runs',"rollback",variant),recordVideo:false});
 assert.equal(result.status,'passed',JSON.stringify({status:result.status,assertion:result.assertion,error:result.error}));
});
