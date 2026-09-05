import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { normalizeAccount, normalizePost, nowIso } from './daily-contracts.mjs';
import { READ_TOOLS, errorCode, throwIfAborted, delay } from './daily-runtime.mjs';

export function decodeToolResult(result) {
  const block=result?.content?.find(item=>item.type==='text');
  let value=result?.structuredContent;
  if(value===undefined){try{value=JSON.parse(block?.text);}catch{throw new Error('MALFORMED_SOURCE_RESPONSE');}}
  if(result.isError||value?.error) throw new Error(errorCode(new Error(JSON.stringify(value))));
  return value;
}
export function arrayResult(value) {
  for(const v of [value,value?.data,value?.tweets,value?.results,value?.replies,value?.quotes,value?.data?.tweets,value?.data?.replies,value?.data?.quotes]) if(Array.isArray(v))return v;
  throw new Error('MALFORMED_SOURCE_ARRAY');
}
export class XActionsMcpSource {
  constructor(options={}) {
    this.command=options.command;this.args=options.args||[];this.cwd=options.cwd;
    this.callTimeoutMs=options.callTimeoutMs??60000;this.signal=options.signal;this.lastCall=0;
    this.delayMs=options.delayMs??0;this.allowedTools=new Set(options.readTools||READ_TOOLS);
    if([...this.allowedTools].some(t=>!READ_TOOLS.includes(t)))throw new Error('XActions source tool allowlist contains a non-read tool');
  }
  async bounded(operation) {
    throwIfAborted(this.signal);
    const controller=new AbortController();
    const stop=()=>controller.abort(this.signal.reason||new Error('INTERRUPTED'));
    this.signal?.addEventListener('abort',stop,{once:true});
    const timer=setTimeout(()=>controller.abort(new Error('SOURCE_TIMEOUT')),this.callTimeoutMs);
    try {return await Promise.race([operation(controller.signal),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}))]);}
    catch(e){await this.close();throw e;}
    finally{clearTimeout(timer);this.signal?.removeEventListener('abort',stop);}
  }
  async connect() {
    if(this.client)return;
    const env=Object.fromEntries(['PATH','HOME','TMPDIR','LANG','LC_ALL','TERM','PUPPETEER_EXECUTABLE_PATH'].flatMap(k=>process.env[k]?[[k,process.env[k]]]:[]));
    this.transport=new StdioClientTransport({command:this.command,args:this.args,cwd:this.cwd,env:{...env,XACTIONS_MODE:'local'},stderr:'pipe'});
    this.transport.stderr?.on('data',()=>{});
    const client=new Client({name:'x-growth-read-only',version:'1.0.0'},{capabilities:{}});this.client=client;
    await this.bounded(async signal=>{
      await client.connect(this.transport,{signal,timeout:this.callTimeoutMs});
      const listed=await client.listTools({}, {signal,timeout:this.callTimeoutMs});
      for(const name of this.allowedTools)if(!listed.tools.some(t=>t.name===name))throw new Error('SOURCE_TOOL_MISSING');
    });
  }
  async close(){const client=this.client,transport=this.transport;this.client=undefined;this.transport=undefined;try{await client?.close();}finally{await transport?.close();}}
  async call(tool,args) {
    if(!this.allowedTools.has(tool))throw new Error('SOURCE_TOOL_NOT_ALLOWLISTED');
    await delay(Math.max(0,this.lastCall+this.delayMs-Date.now()),this.signal);
    await this.connect();this.lastCall=Date.now();const client=this.client;
    return this.bounded(async signal=>decodeToolResult(await client.callTool({name:tool,arguments:args},undefined,{signal,timeout:this.callTimeoutMs})));
  }
  async preflight(query){const rows=arrayResult(await this.call('x_search_tweets',{platform:'twitter',query,limit:1}));return{status:rows.length?'passed':'empty',result_count:rows.length};}
  async search(query,bucket,limit){const rows=arrayResult(await this.call('x_search_tweets',{platform:'twitter',query,limit}));return rows.slice(0,limit).map(x=>normalizePost(x,query,bucket)).filter(Boolean);}
  async profile(username){const raw=await this.call('x_get_profile',{platform:'twitter',username});const p=normalizeAccount(raw?.profile||raw?.data||raw,username);if(!p||p.username!==username)throw new Error('SOURCE_ACCOUNT_MISMATCH');return p;}
  async timeline(username,limit){const rows=arrayResult(await this.call('x_get_tweets',{platform:'twitter',username,limit}));return rows.slice(0,limit).map(x=>normalizePost(x,`profile:${username}`,'timeline')).filter(p=>p&&p.username===username);}
  async thread(url){return{raw:await this.call('x_get_thread',{url}),retrieved_at:nowIso(),completeness:'unknown'};}
  async replies(url,limit){return arrayResult(await this.call('x_get_replies',{tweetUrl:url,limit,sort:'recent'})).slice(0,limit).map(x=>normalizePost(x,url,'replies')).filter(Boolean);}
}
export class FixtureXSource {
  constructor(fixture){this.fixture=fixture;}
  async preflight(){return{status:'passed',result_count:1};}
  async search(query,bucket,limit=10){return (this.fixture.search_results||this.fixture.tweets||[]).slice(0,limit).map(x=>normalizePost(x,query,bucket)).filter(Boolean);}
  async profile(username){return normalizeAccount((this.fixture.profiles||[]).find(x=>x.username.toLowerCase()===username),username);}
  async timeline(username){return (this.fixture.recent_tweets?.[username]||[]).map(x=>normalizePost(x,`profile:${username}`,'timeline')).filter(Boolean);}
  async replies(){return[];}
  async thread(){return{raw:null,completeness:'unknown'};}
  async close(){}
}
export class StoredXSource extends FixtureXSource {
  constructor(posts){super({});this.posts=posts;}
  async preflight(){return{status:this.posts.length?'passed':'empty',result_count:this.posts.length};}
  async search(){return this.posts;}
  async profile(){return undefined;}
}
