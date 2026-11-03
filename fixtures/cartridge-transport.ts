/** In-browser playback only. This transport is not the trusted verification simulator. */
type Entry = { id:string; key:string; status:number; response:unknown };
type Event = { type:'request'|'release'; id:string; atMs:number; key?:string; payload?:unknown; status?:number; response?:unknown };
export type CartridgeConfig = { origin:string;session:string;manifest:{schedule:Entry[]} };
export type Transport = (url:string, init?:RequestInit)=>Promise<Response>;

export function createCartridgeTransport(config:CartridgeConfig):Transport {
  const started=performance.now(), used=new Set<string>(), events:Event[]=[], watchers=new Set<()=>void>();
  const pending=new Map<string,{entry:Entry;resolve:(response:Response)=>void}>();
  let calls=0,closed=false;
  const response=(status:number,data:unknown)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
  const snapshot=()=>({pending:[...pending.keys()],events:structuredClone(events),completed:events.filter(event=>event.type==='release').map(event=>event.id)});
  const notify=()=>{for(const watcher of watchers)watcher();watchers.clear();};
  return async(url,init)=>{
    if(++calls>256)return response(429,{error:'Cartridge request limit reached. Reset the challenge.'});
    const parsed=new URL(url);
    if(parsed.origin!==config.origin||!parsed.pathname.startsWith(`/mock/${config.session}/`))return response(403,{error:'Offline cartridge cannot access this destination'});
    const operation=parsed.pathname.slice(`/mock/${config.session}/`.length);
    if(operation==='reset'&&init?.method==='POST'){
      closed=true;for(const item of pending.values())item.resolve(response(410,{error:'Cartridge reset'}));pending.clear();notify();return response(200,{reset:true});
    }
    if(closed)return response(410,{error:'Cartridge session closed'});
    if(operation==='state'){
      if(parsed.searchParams.get('watch')==='1'&&Number(parsed.searchParams.get('after'))===events.length){
        await new Promise<void>(resolve=>{const timer=setTimeout(()=>{watchers.delete(finish);resolve();},20_000);const finish=()=>{clearTimeout(timer);resolve();};watchers.add(finish);});
      }
      return response(200,snapshot());
    }
    if(init?.method!=='POST'||typeof init.body!=='string'||init.body.length>65_536)return response(400,{error:'Invalid cartridge request'});
    let body:{key?:string;payload?:unknown;request?:string};
    try{body=JSON.parse(init.body) as typeof body;}catch{return response(400,{error:'Invalid request JSON'});}
    if(operation==='request'){
      const entry=config.manifest.schedule.find(candidate=>candidate.key===body.key&&!used.has(candidate.id));
      if(!entry||used.size>=24)return response(422,{error:'No scheduled response for request'});
      used.add(entry.id);events.push({type:'request',id:entry.id,key:entry.key,payload:body.payload??null,atMs:Math.round(performance.now()-started)});
      const result=new Promise<Response>(resolve=>pending.set(entry.id,{entry,resolve}));notify();return result;
    }
    if(operation==='release'){
      const item=body.request?pending.get(body.request):undefined;
      if(!item)return response(409,{error:'Request has not arrived or was already released'});
      pending.delete(item.entry.id);events.push({type:'release',id:item.entry.id,status:item.entry.status,response:item.entry.response,atMs:Math.round(performance.now()-started)});
      item.resolve(response(item.entry.status,item.entry.response));notify();return response(200,snapshot());
    }
    return response(404,{error:'Unsupported cartridge operation'});
  };
}
