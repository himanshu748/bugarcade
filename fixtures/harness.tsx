import { createRoot } from 'react-dom/client';
import type { ComponentType } from 'react';
import type { Transport } from './cartridge-transport';

type Action = { type: 'click' | 'fill' | 'wait'; target: string; value?: string } | { type: 'release'; request: string };
type Manifest = { id: string; allowedTargets: string[]; actions: Action[]; assertion: { target: string; operator: 'equals' | 'contains' | 'count'; expected: string | number }; completion: { target: string; value: string }; schedule: {id:string;key:string;status:number}[] };
type Network = { pending: string[]; events: {type:string;id:string;atMs:number}[]; completed: string[] };
type Config = { manifest: Manifest; session: string; variant: string; origin: string; parentOrigin: string; mode?: 'offline-cartridge' };
type Harness = { ready: boolean; release: (id:string)=>Promise<void>; snapshot: ()=>unknown; settle: ()=>Promise<void> };
declare global { interface Window { __BUGARCADE_CONFIG__: Config; __BUGARCADE_HARNESS__: Harness } }

export function mountHarness(App: ComponentType<{api:{request:(key:string,payload?:unknown)=>Promise<unknown>}}>, transport:Transport=(url,init)=>fetch(url,init)) {
  const config = window.__BUGARCADE_CONFIG__, manifest = config.manifest;
  const appRoot = document.getElementById('app-root')!, harnessRoot = document.getElementById('harness-root')!;
  const apiUrl = `${config.origin}/mock/${config.session}`;
  let moves = 0, network: Network = {pending:[],events:[],completed:[]}, replaying = false, stopped = false, error = '', ready = false;
  const actions: Action[] = [];
  const observedReleases=new Set<string>();
  function ingestNetwork(next:Network){
    if(next.events.length<network.events.length)return;
    network=next;
    for(const event of next.events){if(event.type==='release'&&!observedReleases.has(event.id)){observedReleases.add(event.id);moves++;actions.push({type:'release',request:event.id});}}
  }
  const waiting = new Set<()=>void>();
  const settle = async () => { await new Promise<void>(resolve => requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))); };
  const target = (id:string) => appRoot.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const read = (id:string) => { const el=target(id);return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el?.textContent?.trim() ?? null; };
  function assertion() {
    const rule=manifest.assertion, completed=read(manifest.completion.target)===manifest.completion.value;
    const actual = rule.operator==='count' ? appRoot.querySelectorAll(`[data-testid="${rule.target}"]`).length : read(rule.target);
    return { completed, observed:actual, assertionPassed:!completed?null:rule.operator==='contains'?String(actual).includes(String(rule.expected)):actual===rule.expected };
  }
  const snapshot = () => ({type:'bugarcade:state',challengeId:manifest.id,variant:config.variant,moves,pending:network.pending,ready,replaying,error: error || null,actions:[...actions],...assertion()});
  function emit() { if (window.parent !== window) window.parent.postMessage(snapshot(), config.parentOrigin); }
  function renderRack() {
    const active=document.activeElement as HTMLElement|null;
    const restoreFocus=!!active && harnessRoot.contains(active);
    const activeTestId=active?.dataset.testid;
    harnessRoot.replaceChildren();
    const rack=document.createElement('section');rack.className='network-rack';rack.setAttribute('aria-label','Network controls');
    const heading=document.createElement('div');heading.className='network-heading';
    const title=document.createElement('h2');title.textContent='NETWORK RACK';title.tabIndex=-1;
    const status=document.createElement('span');status.textContent=`${network.pending.length} pending · ${moves} moves`;
    heading.append(title,status);rack.append(heading);
    const description=document.createElement('p');description.textContent='You control when responses arrive. Release a request to let the app continue.';rack.append(description);
    const queue=document.createElement('div');queue.className='network-queue';
    for (const id of network.pending) {
      const entry=manifest.schedule.find(item=>item.id===id)!;
      const row=document.createElement('div');row.className='network-request';
      const label=document.createElement('div'),code=document.createElement('code'), detail=document.createElement('small');code.textContent=id;detail.textContent=entry.status>=400?`Will return ${entry.status} · failed request`:`Will return ${entry.status} · success`;label.append(code,detail);
      const button=document.createElement('button');button.type='button';button.textContent=`Release ${id} →`;button.dataset.testid=`release-${id}`;button.disabled=replaying;
      button.addEventListener('click',()=>{void release(id).catch(showError);});row.append(label,button);queue.append(row);
    }
    if(!network.pending.length){const empty=document.createElement('div');empty.className='network-empty';empty.textContent='No requests waiting. Interact with the app above.';queue.append(empty);}
    rack.append(queue);
    if(config.mode==='offline-cartridge'){
      const notice=document.createElement('p');notice.textContent='Offline cartridge · simulated network · UI feedback only. Captured browser evidence is the verification record.';rack.append(notice);
      const controls=document.createElement('div');controls.className='input-row';
      const replayButton=document.createElement('button');replayButton.textContent='Replay captured actions';replayButton.dataset.testid='cartridge-replay';replayButton.disabled=replaying||moves>0;replayButton.addEventListener('click',()=>{if(validPlan(manifest.actions))void replay(manifest.actions);});
      const resetButton=document.createElement('button');resetButton.textContent='Reset cartridge';resetButton.dataset.testid='cartridge-reset';resetButton.addEventListener('click',()=>{stopped=true;void transport(`${apiUrl}/reset`,{method:'POST'}).finally(()=>location.reload());});
      controls.append(replayButton,resetButton);rack.append(controls);
    }
    if(replaying){const status=document.createElement('p');status.className='fixture-replay-state';status.textContent='Replaying recorded actions…';rack.append(status);}
    if(error){const message=document.createElement('p');message.className='network-error';message.setAttribute('role','alert');message.textContent=error;rack.append(message);}
    harnessRoot.append(rack);
    if(restoreFocus){const next=activeTestId?harnessRoot.querySelector<HTMLElement>(`[data-testid="${CSS.escape(activeTestId)}"]`):null;(next??title).focus({preventScroll:true});}
    emit();
  }
  function showError(cause:unknown) {error=cause instanceof Error?cause.message:String(cause);renderRack();}
  async function refresh() {const response=await transport(`${apiUrl}/state`);if(!response.ok)throw new Error('Network session unavailable. Reset the challenge.');ingestNetwork(await response.json() as Network);for(const fn of waiting)fn();renderRack();}
  async function waitUntil(predicate:()=>boolean, message:string) {
    if(predicate())return;
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{waiting.delete(check);reject(new Error(message));},2500);
      const check=()=>{if(predicate()){clearTimeout(timer);waiting.delete(check);resolve();}};waiting.add(check);check();
    });
  }
  async function release(id:string) {
    if(!manifest.schedule.some(entry=>entry.id===id))throw new Error('Unknown scheduled request');
    await refresh();
    await waitUntil(()=>network.pending.includes(id),`Request ${id} did not arrive`);
    
    const response=await transport(`${apiUrl}/release`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({request:id})});
    if(!response.ok)throw new Error('This request is no longer pending. Reset to try again.');
    await settle();await refresh();emit();
  }
  const api=Object.freeze({request:async(key:string,payload?:unknown)=>{
    const response=await transport(`${apiUrl}/request`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key,payload})});
    const data:unknown=await response.json();
    if(!response.ok)throw new Error(`Mock API ${response.status}`);
    return data;
  }});
  appRoot.addEventListener('click',event=>{
    const node=(event.target as Element).closest<HTMLElement>('[data-testid]');
    if(node && node.tagName==='BUTTON' && manifest.allowedTargets.includes(node.dataset.testid!)){moves++;actions.push({type:'click',target:node.dataset.testid!});renderRack();}
  },true);
  appRoot.addEventListener('change',event=>{
    const node=event.target;
    if(node instanceof HTMLInputElement && manifest.allowedTargets.includes(node.dataset.testid ?? '')){moves++;actions.push({type:'fill',target:node.dataset.testid!,value:node.value});renderRack();}
  });
  const observer=new MutationObserver(()=>{for(const fn of waiting)fn();emit();});observer.observe(appRoot,{subtree:true,childList:true,characterData:true,attributes:true});
  async function watchNetwork() {
    while(!stopped){
      const response=await transport(`${apiUrl}/state?watch=1&after=${network.events.length}`);
      if(!response.ok)throw new Error('Network session expired. Reset the challenge.');
      ingestNetwork(await response.json() as Network);for(const fn of waiting)fn();renderRack();
    }
  }
  const root=createRoot(appRoot);root.render(<App api={api}/>);
  window.__BUGARCADE_HARNESS__={ready:false,release:id=>release(id),snapshot,settle};
  void settle().then(()=>{ready=true;window.__BUGARCADE_HARNESS__.ready=true;renderRack();return watchNetwork();}).catch(showError);
  function validPlan(plan:unknown):plan is Action[] {
    if(!Array.isArray(plan)||plan.length>12)return false;
    return plan.every((action:Action)=>action && typeof action==='object' && (
      action.type==='release'?Object.keys(action).every(k=>['type','request'].includes(k)) && manifest.schedule.some(entry=>entry.id===action.request):
      ['click','fill','wait'].includes(action.type) && manifest.allowedTargets.includes(action.target) && Object.keys(action).every(k=>['type','target','value'].includes(k)) && (action.type==='click'||typeof action.value==='string' && action.value.length<=1000)
    ));
  }
  async function replay(plan:Action[]){
    if(replaying)return;replaying=true;error='';renderRack();
    try{for(const action of plan){
      if(action.type==='release'){await release(action.request);continue;}
      const el=target(action.target);if(!el)throw new Error(`Target ${action.target} is unavailable`);
      if(action.type==='click')el.click();
      if(action.type==='fill'){
        if(!(el instanceof HTMLInputElement))throw new Error('This target is not an input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(el,action.value);
        el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
      }
      if(action.type==='wait')await waitUntil(()=>read(action.target)===action.value,'Expected app state did not arrive');
      await settle();
    }}catch(cause){showError(cause);}finally{replaying=false;renderRack();emit();}
  }
  window.addEventListener('message',event=>{
    if(event.source!==window.parent || event.origin!==config.parentOrigin || window.parent===window || !event.data || typeof event.data!=='object')return;
    if(event.data.type==='bugarcade:reset'){stopped=true;void transport(`${apiUrl}/reset`,{method:'POST'}).finally(()=>location.reload());}
    if(event.data.type==='bugarcade:replay' && validPlan(event.data.actions))void replay(event.data.actions);
  });
  window.addEventListener('pagehide',()=>{stopped=true;observer.disconnect();void transport(`${apiUrl}/reset`,{method:'POST',keepalive:true}).catch(()=>{});});
}
