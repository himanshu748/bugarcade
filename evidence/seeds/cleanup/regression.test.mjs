import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.BUGARCADE_ROOT??process.cwd();
const {runChallenge}=await import(pathToFileURL(path.join(root,'worker/executor.mjs')).href);
// Run from the BugArcade repository. VARIANT=buggy must fail; VARIANT=fixed must pass.
// This test executes the exact captured sequence; infrastructure errors also fail the test.
test("The ghost of a screen — intended invariant",async()=>{
 const variant=process.env.VARIANT??'fixed';
 const result=await runChallenge({challengeId:"cleanup",variant,actions:[{"type":"click","target":"nav-b"},{"type":"release","request":"project-b-1"},{"type":"release","request":"project-a-1"}],assertionHash:"fcb7af4901690860827c995983cc702306bb3ec1ea839ce5a21798b677e8339c",artifactDir:path.join(root,'evidence','regression-runs',"cleanup",variant),recordVideo:false});
 assert.equal(result.status,'passed',JSON.stringify({status:result.status,assertion:result.assertion,error:result.error}));
});
