import { assertionHash } from './validation.mjs';

export async function minimizeActions({manifest, actions, run, maxProbes=20}) {
  const locked=assertionHash(manifest), original=structuredClone(actions), probes=[];
  let candidate=structuredClone(actions),index=0;
  while(index<candidate.length && probes.length<maxProbes){
    if(assertionHash(manifest)!==locked)throw new Error('Assertion changed during minimization');
    const next=candidate.filter((_,i)=>i!==index);
    const buggy=await run('buggy',next,probes.length),fixed=buggy.status==='failed'?await run('fixed',next,probes.length):null;
    const accepted=buggy.status==='failed' && fixed?.status==='passed';
    probes.push({removedIndex:index,actions:next,buggy:buggy.status,fixed:fixed?.status??'not-run',accepted});
    if(accepted){candidate=next;index=0;}else index++;
  }
  return {initialActions:original,actions:candidate,initialCount:original.length,minimizedCount:candidate.length,assertionHash:locked,probes,method:'greedy single-action deletion with frozen invariant and completion; requires buggy failure + fixed pass',minimality:index>=candidate.length?'1-minimal for single-action deletion under this schedule':'probe-budget-exhausted'};
}
