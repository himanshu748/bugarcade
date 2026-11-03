import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.BUGARCADE_ROOT??process.cwd();
const {runChallenge}=await import(pathToFileURL(path.join(root,'worker/executor.mjs')).href);
// Run from the BugArcade repository. VARIANT=buggy must fail; VARIANT=fixed must pass.
// This test executes the exact captured sequence; infrastructure errors also fail the test.
test("The vanishing note — intended invariant",async()=>{
 const variant=process.env.VARIANT??'fixed';
 const result=await runChallenge({challengeId:"lost-note",variant,actions:[{"type":"click","target":"sync"},{"type":"click","target":"add-note"},{"type":"release","request":"save-1"}],assertionHash:"072beb8f5d60874ac281b2b3ae95148d9f2d46de456d55c8167751d4183c8951",artifactDir:path.join(root,'evidence','regression-runs',"lost-note",variant),recordVideo:false});
 assert.equal(result.status,'passed',JSON.stringify({status:result.status,assertion:result.assertion,error:result.error}));
});
