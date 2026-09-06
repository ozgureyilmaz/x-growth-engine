import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { AutoPublicationRequestSchema, AutoPublicationReceiptSchema, verifyAutoReceipt } from './daily-publication-contracts.mjs';
import { errorCode } from './daily-runtime.mjs';

function receiptBase(request) {
  return { schema_version:'2.0',message_type:'X_PUBLICATION_RECEIPT',request_id:request.request_id,action_id:request.action.action_id,publisher_account:request.publisher_account,idempotency_key:request.idempotency_key,action_hash:request.action_hash,request_hash:request.request_hash,observed_at:new Date().toISOString() };
}

function closeStalePublisherSession(pathValue, env) {
  // Clear Hermes-owned sessions before dispatch so a preflight or timed-out
  // worker cannot leave a dead CDP endpoint cached for the publisher.
  const npx = process.env.NPX_BIN || 'npx';
  try {
    spawnSync(npx, ['--yes', 'agent-browser@^0.26.0', 'close', '--all'], {
      cwd:pathValue, env, stdio:'ignore', timeout:10000,
    });
    // Terminate only Hermes-owned agent-browser processes listed by Hermes'
    // own PID files. Never use broad pkill patterns: they can terminate an
    // unrelated browser-agent session or the user's browser.
    const pidDir=path.join(env.HERMES_HOME||path.join(env.HOME||'', '.hermes'), '.agent-browser');
    for (const file of readdirSync(pidDir,{withFileTypes:true}).filter(entry=>entry.isFile()&&entry.name.endsWith('.pid'))) {
      const pid=Number.parseInt(readFileSync(path.join(pidDir,file.name),'utf8').trim(),10);
      if(!Number.isInteger(pid)||pid<=0) continue;
      const probe=spawnSync('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:2000});
      const commandLine=String(probe.stdout||'');
      if(!commandLine.includes('.hermes')||!commandLine.includes('agent-browser')) continue;
      try { process.kill(pid,'SIGTERM'); } catch { /* already exited */ }
    }
  } catch { /* stale-session cleanup is best effort; publisher remains fail-closed */ }
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
  const actionId=String(options.actionId||path.basename(requestPath,'.json')).replace(/[^a-zA-Z0-9_-]/g,'_');
  const prompt=[
    'Execute exactly one X_PUBLICATION_REQUEST JSON file using the browser tool.',
    `REQUEST_PATH: ${requestPath}`,
    `Use a fresh browser session named xpub_${actionId.slice(-12)}; do not reuse a generic or prior session.`,
    'Use the request body and target exactly. Verify the signed-in account is @nullquanty. Do not ask for or print API keys, cookies, auth_token, or ct0. Do not use X API tools. Return only one X_PUBLICATION_RECEIPT JSON object after visible read-back verification. If the result is uncertain, return RECONCILIATION_REQUIRED and never retry.',
  ].join('\n');
  const args=buildHermesArgs(prompt,{model,reasoning,timeoutMs});
  return new Promise((resolve,reject)=>{
    const home=process.env.HOME||'';
    const managedBins=[path.join(home,'.hermes','bin'),path.join(home,'.local','bin')].filter(Boolean);
    const inheritedPath=process.env.PATH||'';
    const PATH=[...managedBins,inheritedPath].filter(Boolean).join(path.delimiter);
    const safeEnv={PATH,HOME:home,LANG:process.env.LANG||'en_US.UTF-8',TERM:process.env.TERM||'dumb'};
    for (const key of ['USER','LOGNAME','SHELL','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME','XDG_DATA_HOME','XDG_RUNTIME_DIR','HERMES_HOME']) {
      if (process.env[key]) safeEnv[key]=process.env[key];
    }
    closeStalePublisherSession(options.cwd, safeEnv);
    const child=spawn(command,args,{cwd:options.cwd,stdio:['ignore','pipe','pipe'],env:safeEnv});
    let stdout='',stderr='',settled=false;
    const timer=setTimeout(()=>{if(settled)return;settled=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),5000);reject(new Error('HERMES_TIMEOUT'));},timeoutMs);
    child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>2_000_000){settled=true;child.kill('SIGTERM');reject(new Error('HERMES_OUTPUT_TOO_LARGE'));}});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-12000);});
    child.once('error',error=>{if(settled)return;settled=true;clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{if(settled)return;settled=true;clearTimeout(timer);if(code!==0)return reject(new Error(`HERMES_EXIT_${code??signal}:${stderr.slice(-800)}`));resolve(stdout);});
  });
}

export function buildHermesArgs(prompt, options={}) {
  // Hermes' managed Browser Use backend is exposed through the full tool registry;
  // the legacy `browser` group omits browser_exec when the backend is selected.
  return ['chat','-Q','--provider','openai-codex','-m',options.model||'gpt-5.6-luna','--reasoning',options.reasoning||'xhigh','--toolsets','all','--skills','x-growth-publisher','--max-turns','20','--run-budget',String(Math.ceil((options.timeoutMs||180000)/1000)),'-q',prompt];
}

export class HermesXPublisher {
  constructor(options={}) { this.options=options; }

  async close() {}

  async publishRequest(requestPath) {
    const request=AutoPublicationRequestSchema.parse(JSON.parse(await readFile(path.resolve(requestPath),'utf8')));
    let raw;
    try { raw=await (this.options.runHermes||((file)=>runHermesCli(file,{...this.options,actionId:request.action.action_id})))(path.resolve(requestPath)); }
    catch(error) {
      const detail=String(error?.message||'Hermes returned no verified receipt.').replace(/[\r\n]+/g,' ').slice(-800);
      return {...receiptBase(request),status:'RECONCILIATION_REQUIRED',error_code:errorCode(error),error_message:detail,observed_at:new Date().toISOString()};
    }
    const parsed=parseHermesReceipt(raw);
    if(!parsed) return {...receiptBase(request),status:'RECONCILIATION_REQUIRED',error_code:'INVALID_HERMES_RECEIPT',error_message:'Hermes returned no schema-valid receipt.',observed_at:new Date().toISOString()};
    try { return verifyAutoReceipt(request,AutoPublicationReceiptSchema.parse(parsed)); }
    catch(error) { return {...receiptBase(request),status:'RECONCILIATION_REQUIRED',error_code:errorCode(error),error_message:'Hermes receipt did not bind to the exact request.',observed_at:new Date().toISOString()}; }
  }
}
