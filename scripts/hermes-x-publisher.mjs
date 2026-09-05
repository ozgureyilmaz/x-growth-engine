import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AutoPublicationRequestSchema, AutoPublicationReceiptSchema, verifyAutoReceipt } from './daily-publication-contracts.mjs';
import { errorCode } from './daily-runtime.mjs';

function receiptBase(request) {
  return { schema_version:'2.0',message_type:'X_PUBLICATION_RECEIPT',request_id:request.request_id,action_id:request.action.action_id,publisher_account:request.publisher_account,idempotency_key:request.idempotency_key,action_hash:request.action_hash,request_hash:request.request_hash,observed_at:new Date().toISOString() };
}

export function parseHermesReceipt(raw) {
  const text=String(raw??'').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  const candidates=[];
  for(let start=text.indexOf('{');start>=0;start=text.indexOf('{',start+1)){
    let depth=0,inString=false,escaped=false;
    for(let index=start;index<text.length;index++){
      const char=text[index];
      if(inString){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')inString=false;continue;}
      if(char==='"'){inString=true;continue;}
      if(char==='{')depth++;
      if(char==='}'&&--depth===0){try{const value=JSON.parse(text.slice(start,index+1));if(value?.message_type==='X_PUBLICATION_RECEIPT')candidates.push(value);}catch{}break;}
    }
  }
  return candidates.at(-1);
}

export function runHermesCli(requestPath, options={}) {
  const command=options.hermesCommand||'hermes';
  const model=options.model||'gpt-5.6-luna';
  const reasoning=options.reasoningEffort||'xhigh';
  const timeoutMs=options.timeoutMs||180000;
  const prompt=[
    'Execute exactly one X_PUBLICATION_REQUEST JSON file using the browser tool.',
    `REQUEST_PATH: ${requestPath}`,
    'Use the request body and target exactly. Verify the signed-in account is @nullquanty. Do not ask for or print API keys, cookies, auth_token, or ct0. Do not use X API tools. Return only one X_PUBLICATION_RECEIPT JSON object after visible read-back verification. If the result is uncertain, return RECONCILIATION_REQUIRED and never retry.',
  ].join('\n');
  const args=buildHermesArgs(prompt,{model,reasoning,timeoutMs});
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{cwd:options.cwd,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH||'',HOME:process.env.HOME||'',LANG:process.env.LANG||'en_US.UTF-8',TERM:process.env.TERM||'dumb'}});
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{if(settled)return;settled=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000);reject(new Error('HERMES_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>2_000_000){settled=true;child.kill('SIGTERM');reject(new Error('HERMES_OUTPUT_TOO_LARGE'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-12000);});
    child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)return reject(new Error(`HERMES_EXIT_${code??signal}:${stderr.slice(-800)}`));resolve(stdout);});
  });
}

export function buildHermesArgs(prompt, options={}) {
  return ['chat','-Q','--provider','openai-codex','-m',options.model||'gpt-5.6-luna','--reasoning',options.reasoning||'xhigh','--toolsets','browser','--max-turns','20','--run-budget',String(Math.ceil((options.timeoutMs||180000)/1000)),'-q',prompt];
}

export class HermesXPublisher {
  constructor(options={}) { this.options=options; }

  async close() {}

  async publishRequest(requestPath) {
    const request=AutoPublicationRequestSchema.parse(JSON.parse(await readFile(path.resolve(requestPath),'utf8')));
    let raw;
    try { raw=await (this.options.runHermes||((file)=>runHermesCli(file,this.options)))(path.resolve(requestPath)); }
    catch(error) { return {...receiptBase(request),status:'RECONCILIATION_REQUIRED',error_code:errorCode(error),error_message:'Hermes returned no verified receipt.',observed_at:new Date().toISOString()}; }
    const parsed=parseHermesReceipt(raw);
    if(!parsed) return {...receiptBase(request),status:'RECONCILIATION_REQUIRED',error_code:'INVALID_HERMES_RECEIPT',error_message:'Hermes returned no schema-valid receipt.',observed_at:new Date().toISOString()};
    try { return verifyAutoReceipt(request,AutoPublicationReceiptSchema.parse(parsed)); }
    catch(error) { return {...receiptBase(request),status:'RECONCILIATION_REQUIRED',error_code:errorCode(error),error_message:'Hermes receipt did not bind to the exact request.',observed_at:new Date().toISOString()}; }
  }
}
