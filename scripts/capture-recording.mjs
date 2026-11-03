import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { ROOT, getChallenges } from '../worker/server.mjs';

const command=(program,args)=>new Promise((resolve,reject)=>{
 const child=spawn(program,args,{stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error(`${program} timed out`));},20000);
 child.stdout.on('data',data=>{if(stdout.length<65536)stdout+=data;});child.stderr.on('data',data=>{if(stderr.length<65536)stderr+=data;});
 child.on('error',error=>{clearTimeout(timeout);reject(error);});child.on('close',code=>{clearTimeout(timeout);if(code===0)resolve({stdout,stderr});else reject(new Error(`${program} failed: ${stderr.slice(0,1000)}`));});
});
async function bundledFfmpeg(){
 const require=createRequire(import.meta.url),base=path.dirname(require.resolve('playwright-core/package.json'));
 const info=JSON.parse(await readFile(path.join(base,'browsers.json'),'utf8')).browsers.find(item=>item.name==='ffmpeg');
 const cache=process.env.PLAYWRIGHT_BROWSERS_PATH??(process.platform==='darwin'?path.join(os.homedir(),'Library','Caches','ms-playwright'):process.platform==='win32'?path.join(process.env.LOCALAPPDATA,'ms-playwright'):path.join(os.homedir(),'.cache','ms-playwright'));
 const suffix=process.platform==='darwin'?'mac':process.platform==='win32'?'win64.exe':'linux';
 const binary=path.join(cache,`ffmpeg-${info.revision}`,`ffmpeg-${suffix}`);await access(binary);return binary;
}
export async function captureRecordingFrames(id){
 const dir=path.join(ROOT,'evidence','seeds',id),recording=path.join(dir,'buggy-1','recording.webm'),output=path.join(dir,'recording-frames');
 await mkdir(output,{recursive:true});
 const binary=process.env.FFMPEG_BINARY??await bundledFfmpeg();
 const first=await command(binary,['-hide_banner','-y','-i',recording,'-frames:v','1','-vf','scale=640:-1',path.join(output,'frame-001.png')]);
 const match=first.stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
 if(!match)throw new Error('Could not determine captured WebM duration');
 const duration=Number(match[1])*3600+Number(match[2])*60+Number(match[3]);
 if(!Number.isFinite(duration)||duration>60)throw new Error('Invalid recorded browser video duration');
 const count=Math.min(8,Math.max(2,Math.ceil(duration*4))),interval=Math.max(0,duration-0.08)/(count-1);
 const frames=[{timestampMs:0,path:'recording-frames/frame-001.png'}];
 for(let index=1;index<count;index++){
  const timestampMs=Math.round(index*interval*1000),filename=`frame-${String(index+1).padStart(3,'0')}.png`;
  await command(binary,['-hide_banner','-loglevel','error','-y','-i',recording,'-ss',String(timestampMs/1000),'-frames:v','1','-vf','scale=640:-1',path.join(output,filename)]);
  await access(path.join(output,filename));frames.push({timestampMs,path:`recording-frames/${filename}`});
 }
 const data={kind:'captured-local-browser',synthetic:false,modelRun:false,recording:'buggy-1/recording.webm',durationMs:Math.round(duration*1000),frames,timestampBasis:'Requested presentation seek positions in captured WebM; decoded frame is at or after each seek, within one video frame',extractor:'Pinned Playwright bundled FFmpeg (VP9 WebM decoder)',warning:'Sampled frames can miss fast interactions. Browser trace and action timestamps are the authoritative execution sequence.'};
 await writeFile(path.join(dir,'recording.json'),JSON.stringify(data,null,2));return data;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const selected=process.argv.slice(2);for(const item of (await getChallenges()).filter(item=>!selected.length||selected.includes(item.id))){const result=await captureRecordingFrames(item.id);process.stdout.write(`${item.id}: ${result.frames.length} timestamped video frames\n`);}
}
