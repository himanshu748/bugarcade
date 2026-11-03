import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const root=process.env.BUGARCADE_ROOT??process.cwd();
const {runChallenge}=await import(pathToFileURL(path.join(root,'worker/executor.mjs')).href);
// Run from the BugArcade repository. VARIANT=buggy must fail; VARIANT=fixed must pass.
// This test executes the exact captured sequence; infrastructure errors also fail the test.
test("One click too many — intended invariant",async()=>{
 const variant=process.env.VARIANT??'fixed';
 const result=await runChallenge({challengeId:"duplicate",variant,actions:[{"type":"click","target":"place-order"},{"type":"click","target":"place-order"},{"type":"release","request":"order-1"}],assertionHash:"e7fbe057c2911678d872a1233fae38d817cce5c7b8c5a1027e7ec2cd50721e4e",artifactDir:path.join(root,'evidence','regression-runs',"duplicate",variant),recordVideo:false});
 assert.equal(result.status,'passed',JSON.stringify({status:result.status,assertion:result.assertion,error:result.error}));
});
