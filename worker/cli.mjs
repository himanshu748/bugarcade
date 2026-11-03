import { runChallenge } from './executor.mjs';
let input='';
try {
  for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>32768)throw new Error('Worker input exceeds limit');}
  const request=JSON.parse(input);
  const result=await runChallenge(request);
  process.stdout.write(JSON.stringify(result)+'\n');
  process.exitCode=result.status==='error'?2:0;
}catch(error){process.stdout.write(JSON.stringify({status:'error',error:{code:'INVALID_INPUT',message:String(error.message).slice(0,400)},artifacts:{}})+'\n');process.exitCode=2;}
