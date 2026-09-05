import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DraftGenerationSchema, EvaluationBatchSchema, OpportunityAnalysisSchema, nowIso, sha256, SourcePostSchema } from './daily-contracts.mjs';
import { XActionsMcpSource, FixtureXSource } from './daily-source.mjs';
import { DailyStore, withRunLock } from './daily-store.mjs';
import { buildDraft, normalizeCandidate, scoreOpportunity, makeNoAction } from './daily-intelligence.mjs';
import { runStage } from './daily-codex.mjs';
import { ROOT,ConfigSchema,loadConfig,loadJson,resolvePath,approvedFacts,throwIfAborted,delay,errorCode,atomicJson } from './daily-runtime.mjs';
import { evaluatePublicationPolicy } from './daily-policy.mjs';
import { AutoPublicationReceiptSchema, buildAutoPublicationRequest, verifyAutoReceipt } from './daily-publication-contracts.mjs';
import { XActionsMcpPublisher } from './daily-publisher.mjs';

export function buildDailyQueries(queryConfig,now,count,lookbackHours=48) {
  const day=Math.floor(now.getTime()/86400000);
  const since=new Date(now.getTime()-lookbackHours*3600000).toISOString().slice(0,10);
  return Object.entries(queryConfig.buckets).slice(0,count).map(([bucket,variants])=>{
    if(!Array.isArray(variants)||!variants.length)throw new Error('QUERY_PLAN_INVALID');
    const variant=variants[day%variants.length];
    return{bucket,variant,query:`${variant} lang:${queryConfig.language||'en'} since:${since} -airdrop -giveaway`.replace(/\s+/g,' ').trim()};
  });
}
const schemaByStage={opportunity:OpportunityAnalysisSchema,generation:DraftGenerationSchema,evaluation:EvaluationBatchSchema};

export function validateStage(stage,value,contexts,config,drafts=[],facts=[]) {
  const parsed=schemaByStage[stage].parse(value);
  const indices=new Set();
  for(const item of parsed){
    const index=stage==='evaluation'?item.draft_index:item.context_index;
    const size=stage==='evaluation'?drafts.length:contexts.length;
    if(index>=size)throw new Error('MODEL_CONTEXT_MISMATCH');
    if(stage!=='generation'&&indices.has(index))throw new Error('MODEL_DUPLICATE_INDEX');
    indices.add(index);
    if(stage==='generation'){
      if(!config.content.strategies.includes(item.strategy_family))throw new Error('MODEL_STRATEGY_INVALID');
      if(item.fact_ids.some(id=>!facts.some(f=>f.fact_id===id)))throw new Error('MODEL_FACT_INVALID');
    }
  }
  if(stage==='evaluation'&&parsed.length!==drafts.length)throw new Error('MODEL_EVALUATION_INCOMPLETE');
  if(stage==='opportunity'&&parsed.length!==contexts.length)throw new Error('MODEL_ANALYSIS_INCOMPLETE');
  if(stage==='generation'&&(parsed.length>contexts.length*config.intelligence.candidates_per_opportunity||contexts.some((_,i)=>parsed.filter(d=>d.context_index===i).length>config.intelligence.candidates_per_opportunity)))throw new Error('MODEL_CANDIDATE_CAP');
  return parsed;
}

export function markdownBundle(bundle) {
  const publicationMode = bundle.publisher_enabled ? 'Automatic publication is enabled; this bundle is an audit artifact.' : 'Publication is manual. Source completeness is recorded, not inferred.';
  const lines=[`# X founder review — ${bundle.run_id}`,'',`Status: ${bundle.status||'UNKNOWN'} | Mode: ${bundle.mode} | model calls: ${bundle.model_calls||0}`,'',publicationMode,''];
  for(const d of bundle.drafts){
    const p=bundle.source_contexts.find(p=>p.provider_id===d.source_record_ids[0]);
    lines.push(`## ${d.action_type} — ${d.action_id}`,'',d.body,'',`Source: ${p?.url||'unknown'}`,`Published: ${p?.timestamp||'unknown'}`,'',`> ${(p?.text||'').replaceAll('\n','\n> ')}`,'',`Facts: ${d.fact_ids.join(', ')||'fixture only'}`,`Strategy: ${d.strategy_family}; hook: ${d.hook_family}`,`Naturalness: ${d.evaluation.naturalness}; context: ${d.evaluation.context_fit}; spam risk: ${d.evaluation.spam_risk}`,`Action hash: ${d.action_hash}`,'');
  }
  lines.push('## Decisions','',...((bundle.decisions||[]).map(d=>`- ${d.action_type||d.kind}: ${d.reason||d.qa?.reasons?.join(', ')||'recorded'}`)));
  return lines.join('\n')+'\n';
}

export async function executeDaily(options={}) {
  let config=ConfigSchema.parse(options.config||await loadConfig(options.configPath));
  const store=new DailyStore(resolvePath(config.storage.database),resolvePath(config.storage.events));
  let now=options.now||new Date(),mode=options.mode||config.mode,autoMode=mode==='EXPERIMENTAL_LIVE_AUTO',maxDrafts=options.maxActions??options.maxDrafts??(autoMode?config.publisher.max_actions_per_run:config.intelligence.max_review_drafts);
  let runId=options.resumeRunId||options.runId||`daily_${now.toISOString().replace(/[-:.]/g,'')}_${randomUUID().slice(0,6)}`;
  if(!/^[a-zA-Z0-9_-]+$/.test(runId))throw new Error('RUN_ID_INVALID');
  if(!['FIXTURE_DRY_RUN','EXPERIMENTAL_LIVE_READ','REPLAY_REAL_DATA','EXPERIMENTAL_LIVE_AUTO'].includes(mode))throw new Error('UNSUPPORTED_MODE');
  if(!Number.isInteger(maxDrafts)||maxDrafts<0||maxDrafts>config.intelligence.max_review_drafts)throw new Error('MAX_DRAFTS_INVALID');
  if(autoMode&&maxDrafts>config.publisher.max_actions_per_run)throw new Error('MAX_ACTIONS_INVALID');
  if(mode==='REPLAY_REAL_DATA'&&!options.replayRunId)throw new Error('REPLAY_REQUIRES_RUN_ID');
  const root=resolvePath(config.storage.root),out=path.join(root,runId);
  const controller=new AbortController(),signal=controller.signal;
  const stop=()=>controller.abort(options.signal?.reason||new Error('INTERRUPTED'));
  options.signal?.addEventListener('abort',stop,{once:true});
  if(options.signal?.aborted)stop();
  const timeout=setTimeout(()=>controller.abort(new Error('RUN_TIMEOUT')),config.intelligence.run_timeout_ms);
  try{return await withRunLock(root,async()=>{
    await store.init();throwIfAborted(signal);
    let queries=options.queryConfig||await loadJson(resolvePath('config/query-buckets.json'));
    let settings={mode,clock:now.toISOString(),maxDrafts,config,queries,replayRunId:options.replayRunId||null};
    if(options.resumeRunId){
      const saved=await store.settings(runId);if(!saved)throw new Error('RESUME_SETTINGS_MISSING');
      if(sha256(saved.config)!==sha256(config))throw new Error('RESUME_CONFIG_CHANGED');
      const resumedRun=await store.status(runId);
      if(resumedRun.run?.finished_at && !['INTERRUPTED','FAILED','MODEL_LIMIT_STOPPED'].includes(resumedRun.run?.status))throw new Error('RUN_ALREADY_COMPLETE');
      settings=saved;mode=saved.mode;maxDrafts=saved.maxDrafts;now=new Date(saved.clock);queries=saved.queries;
      await store.resumeRun(runId);
    }else if((await store.status(runId)).run)throw new Error('RUN_ID_ALREADY_EXISTS');
    if((await store.unfinishedRuns()).some(r=>r.run_id!==runId))throw new Error('UNFINISHED_RUN_REQUIRES_RECOVERY');
    await store.settings(runId,settings);
    await store.startRun(runId,mode,'STARTING',sha256(config),now.toISOString());
    await mkdir(out,{recursive:true});
    let source,publisher,health='UNKNOWN',calls=await store.modelCallsStarted(runId);
    const decisions=[],posts=new Map(),contexts=[];let facts=[];
    const progress=(stage,details={})=>options.onProgress?.({run_id:runId,stage,...details});
    const step=async(key,input,operation)=>{
      throwIfAborted(signal);const hash=sha256(input);
      const cached=await store.readCheckpoint(runId,key,hash);
      if(cached!==undefined){progress(key,{cached:true});return cached;}
      progress(key);const result=(await operation())??null;throwIfAborted(signal);
      await store.checkpoint(runId,key,hash,result);return result;
    };
    const callSource=async(tool,key,args,operation)=>step(key,args,async()=>{
      for(let attempt=1;attempt<=config.discovery.retry_transient_attempts+1;attempt++){
        throwIfAborted(signal);const started=nowIso();
        await store.saveEvent(runId,'X_SOURCE_STARTED',{tool,args_hash:sha256(args),attempt},`${runId}:${key}:${started}`);
        try{const value=await operation();await store.saveSourceCall(runId,tool,'SUCCEEDED',started,nowIso(),Array.isArray(value)?value.length:1);return value;}
        catch(e){const code=signal.aborted?errorCode(signal.reason):errorCode(e);await store.saveSourceCall(runId,tool,'FAILED',started,nowIso(),0,code);if(code!=='RUNTIME_FAILURE'||attempt>config.discovery.retry_transient_attempts)throw e;await delay(500*attempt,signal);}
      }
    });
    try{
      const fixtureDryRun=mode==='FIXTURE_DRY_RUN'||(autoMode&&options.dryRun&&options.fixture);
      if(maxDrafts>0&&!fixtureDryRun){facts=await approvedFacts(config);if(!facts.length)throw new Error('MARX_FACT_REGISTRY_NOT_APPROVED');}
      const original=mode==='REPLAY_REAL_DATA'?(await store.status(settings.replayRunId)).run:null;
      if(mode==='REPLAY_REAL_DATA'&&original?.mode==='FIXTURE_DRY_RUN')throw new Error('FIXTURE_CANNOT_BECOME_REAL');
      const since=new Date(now.getTime()-config.discovery.lookback_hours*3600000).toISOString();
      if(mode==='REPLAY_REAL_DATA'){
        for(const p of await store.listPosts(settings.replayRunId)){
          if(posts.size>=config.discovery.max_raw_posts)break;
          SourcePostSchema.parse(p);if(Date.parse(p.timestamp)>Date.now()||Date.parse(p.retrieved_at)<Date.now()-30*86400000)continue;
          posts.set(p.provider_id,p);
        }
        health=posts.size?'STORED_EVIDENCE':'EMPTY_STORED_EVIDENCE';
      }else{
        source=options.source||(fixtureDryRun?new FixtureXSource(options.fixture||{search_results:[]}):new XActionsMcpSource({command:config.source.command,args:config.source.args,readTools:config.source.read_tools,callTimeoutMs:config.discovery.call_timeout_ms,delayMs:config.discovery.inter_call_delay_seconds*1000,signal}));
        const query=`the lang:en since:${since.slice(0,10)}`;
        const control=await callSource('x_search_tweets','control',{query,limit:1},()=>source.preflight(query));
        if(control.status!=='passed')throw new Error('CONTROL_CHECK_EMPTY');health='PASSED';
        for(const q of buildDailyQueries(queries,now,config.discovery.queries_per_run,config.discovery.lookback_hours)){
          const result=await callSource('x_search_tweets',`search:${q.bucket}`,q,()=>source.search(q.query,q.bucket,config.discovery.result_limit_per_query,since.slice(0,10)));
          for(const p of result){if(posts.size>=config.discovery.max_raw_posts)break;SourcePostSchema.parse(p);if(p.timestamp<since||Date.parse(p.timestamp)>Date.now())continue;posts.set(p.provider_id,p);await store.savePost(runId,p);}
          if(posts.size>=config.discovery.max_raw_posts)break;
        }
      }
      await store.updateRunHealth(runId,health);
      if(!posts.size)decisions.push(makeNoAction('LOW_RELEVANCE'));
      if(maxDrafts>0){
        const ranked=[...posts.values()].map(post=>({post,score:scoreOpportunity(post).score})).filter(p=>p.score>=config.discovery.min_opportunity_score).sort((a,b)=>b.score-a.score||(b.post.likes+b.post.reposts)-(a.post.likes+a.post.reposts)||a.post.provider_id.localeCompare(b.post.provider_id)).slice(0,Math.min(config.discovery.max_contexts,config.intelligence.max_opportunities));
        const accountCache=new Map();
        for(const {post} of ranked){
          let account=null,timeline=[],replies=[],thread=null;
          if(source){
            if(!accountCache.has(post.username)){
              if(accountCache.size>=config.discovery.max_enriched_accounts)break;
              account=await callSource('x_get_profile',`profile:${post.username}`,{username:post.username},()=>source.profile(post.username));
              timeline=await callSource('x_get_tweets',`timeline:${post.username}`,{username:post.username,limit:20},()=>source.timeline(post.username,config.discovery.timeline_limit_per_account,since.slice(0,10)));
              accountCache.set(post.username,{account:account||null,timeline});if(account)await store.saveAccount(runId,account);
            }
            ({account,timeline}=accountCache.get(post.username));
            replies=await callSource('x_get_replies',`replies:${post.provider_id}`,{url:post.url,limit:20},()=>source.replies(post.url,20));
            const threadValue=await callSource('x_get_thread',`thread:${post.provider_id}`,{url:post.url},()=>source.thread(post.url));
            thread={retrieved_at:threadValue?.retrieved_at,completeness:threadValue?.completeness??'unknown',raw:JSON.stringify(threadValue?.raw??'').slice(0,32768)};
          }
          const material={post,account,timeline,replies,thread,completeness:source?'sampled':'post_only',source_mode:mode};
          contexts.push({...material,context_hash:sha256(material)});
        }
      }
      await source?.close();source=undefined;
      const prior=options.priorBodies??await store.listRecentBodies(mode);
      let generated=[];
      if(contexts.length&&fixtureDryRun){
        generated=contexts.map((c,i)=>({context_index:i,action_type:'REPLY_DRAFT',body:'For the trading agent, make failed fills explicit. Marx is a place to discuss market analysis with other agents.',strategy_family:config.content.strategies[0],hook_family:'specific_context',fact_ids:[],evaluation:{context_fit:.9,usefulness:.9,naturalness:.85,marx_relevance:.85,spam_risk:.02,repetition_risk:.02,unsupported_claim_risk:.02,decision:'PUBLISHABLE'}}));
      }else if(contexts.length){
        const modelConfig={...config.codex,timeout_ms:config.intelligence.timeout_ms,cwd:ROOT};
        const stage=async(name,input,expected,drafts=[])=>step(`model:${name}`,{input,prompt:await readFile(resolvePath(`prompts/daily/${name}-v2.md`),'utf8')},async()=>{
          const prompt=await readFile(resolvePath(`prompts/daily/${name}-v2.md`),'utf8');
          for(let attempt=1;attempt<=2;attempt++){
            throwIfAborted(signal);if(calls>=config.intelligence.max_codex_calls)throw new Error('MODEL_LIMIT_STOPPED');calls++;
            const started=nowIso();await store.saveEvent(runId,'X_MODEL_STARTED',{stage:name,call:calls,attempt,model:config.codex.model,reasoning_effort:config.codex.reasoning_effort,prompt_hash:sha256(prompt),input_hash:sha256(input)},`${runId}:model:${calls}`);
            try{
              const raw=await (options.modelRunner||runStage)(name,input,expected,modelConfig,prompt,signal);
              const value=validateStage(name,raw,contexts,config,drafts,facts);
              await store.saveEvent(runId,'X_MODEL_FINISHED',{stage:name,call:calls,status:'SUCCEEDED'},`${runId}:model:${calls}:done`);return value;
            }catch(e){const code=errorCode(e);await store.saveEvent(runId,'X_MODEL_FINISHED',{stage:name,call:calls,status:'FAILED',code},`${runId}:model:${calls}:done`);if(attempt===2||['INTERRUPTED','RUN_TIMEOUT','MODEL_LIMIT_STOPPED','AUTH_REQUIRED','CODEX_EXEC_FAILED','CODEX_BINARY_MISSING'].includes(code))throw e;await delay(1000,signal);}
          }
        });
        const input={contexts,approved_facts:facts};
        const analysis=await stage('opportunity',input,'Array<{context_index, opportunity_score, confidence, recommended_action_type, reason}>');
        const eligible=analysis.filter(a=>a.opportunity_score>=config.discovery.min_opportunity_score&&a.confidence>=.7);
        if(eligible.length){
          const candidates=await stage('generation',{...input,opportunities:eligible,strategies:config.content.strategies,candidates_per_opportunity:config.intelligence.candidates_per_opportunity,prior_bodies:prior.slice(-50)},'Array<{context_index, action_type, body, strategy_family, hook_family, fact_ids}>');
          if(candidates.some(c=>!eligible.some(a=>a.context_index===c.context_index)))throw new Error('MODEL_UNQUALIFIED_CONTEXT');
          if(candidates.length){
            const evaluated=await stage('evaluation',{...input,drafts:candidates.map((c,i)=>({draft_index:i,context_index:c.context_index,body:c.body,action_type:c.action_type,fact_ids:c.fact_ids})),prior_bodies:prior.slice(-50)},'Array<{draft_index, scores:{context_fit,usefulness,naturalness,marx_relevance,spam_risk,repetition_risk,unsupported_claim_risk},decision,reasons}>',candidates);
            generated=candidates.map((c,i)=>({...c,evaluation:evaluated.find(e=>e.draft_index===i)}));
          }
        }
      }
      const selected=[];
      for(const [i,candidate] of generated.entries()){
        throwIfAborted(signal);const context=contexts[candidate.context_index];
        const n=normalizeCandidate(candidate,context,i,{...config.content,...config.intelligence,priorBodies:[...prior,...selected.map(d=>d.body)]});
        if(!n.qa.passed){decisions.push({kind:'QA_REJECTED',source_record_ids:[context.post.provider_id],body:candidate.body,qa:n.qa});continue;}
        if(selected.length>=maxDrafts)continue;
        selected.push(buildDraft({action_type:n.actionType,body:n.body,strategy_family:n.strategy,hook_family:n.hook},context,n.evaluation,n.qa,{run_id:runId,fact_ids:candidate.fact_ids||[],prompt_versions:{opportunity:'v2',generation:'v2',evaluation:'v2'}}));
      }
      if(maxDrafts>0&&!selected.length)decisions.push(makeNoAction(contexts.length?'QUALITY_BELOW_THRESHOLD':'LOW_RELEVANCE',[...posts.keys()]));
      for(const d of selected)await store.saveDraft(runId,d);
      for(const d of decisions)if(d.action_type==='NO_ACTION')await store.saveNoAction(runId,d);
      const publication={dry_run:Boolean(options.dryRun),attempted:0,published:0,failed:0,reconciliation_required:0,blocked:0,requests:[],receipts:[]};
      if(autoMode&&selected.length){
        const grant={grant_id:`grant_${runId}`,publisher_account:'nullquanty',expires_at:new Date(now.getTime()+config.intelligence.run_timeout_ms).toISOString(),max_actions:maxDrafts};
        const priorActions=await store.publicationHistory();
        if(!options.dryRun)publisher=options.publisher||new XActionsMcpPublisher({command:config.source.command,args:config.source.args,cwd:ROOT,callTimeoutMs:config.publisher.action_timeout_ms,readbackAttempts:config.publisher.readback_attempts,readbackDelayMs:config.publisher.readback_delay_ms,interActionDelaySeconds:config.publisher.inter_action_delay_seconds,writeTools:config.publisher.write_tools,readbackTools:[...new Set([...config.source.read_tools,'x_get_quote_tweets'])],signal});
        try{
          for(const draft of selected){
            throwIfAborted(signal);
            const context=contexts.find(value=>value.post.provider_id===draft.source_record_ids[0]);
            const policy=evaluatePublicationPolicy(draft,config,{now,facts,sourceContext:context,attempted:publication.attempted,maxActions:maxDrafts,priorActions,allowFixture:fixtureDryRun});
            await store.saveEvent(runId,'X_POLICY_EVALUATED',{action_id:draft.action_id,action_hash:draft.action_hash,decision:policy.decision,policy_hash:policy.policy_hash,reasons:policy.reasons},`${runId}:policy:${draft.action_id}`);
            if(policy.decision!=='ALLOW'){publication.blocked+=1;decisions.push({kind:'POLICY_BLOCKED',action_id:draft.action_id,reasons:policy.reasons});continue;}
            const request=buildAutoPublicationRequest(draft,policy,grant,now,runId);publication.requests.push(request);
            if(options.dryRun){await atomicJson(path.join(out,`publication-request-${draft.action_id}.json`),request);continue;}
            let claimed=false;
            try{
              await store.createPublicationRequest(request);const claim=await store.claimPublicationRequest(request.request_id);if(!claim)throw new Error('PUBLICATION_CLAIM_FAILED');
              if(claim.status==='PUBLISHED'){publication.blocked+=1;continue;}
              if(claim.status!=='CLAIMED')throw new Error('PUBLICATION_CLAIM_FAILED');
              claimed=true;publication.attempted+=1;await store.saveEvent(runId,'X_PUBLICATION_ATTEMPTED',{action_id:draft.action_id,request_id:request.request_id,action_hash:draft.action_hash},`${runId}:publish:${draft.action_id}:attempt`);
              const result=await publisher.publishAndVerify(draft);
              const receipt=AutoPublicationReceiptSchema.parse({schema_version:'2.0',message_type:'X_PUBLICATION_RECEIPT',request_id:request.request_id,action_id:draft.action_id,publisher_account:'nullquanty',idempotency_key:request.idempotency_key,action_hash:request.action_hash,request_hash:request.request_hash,status:result.status,provider_id:result.provider_id,permalink:result.permalink,observed_at:nowIso(),error_code:result.error_code,error_message:result.error_message});
              verifyAutoReceipt(request,receipt);await store.savePublicationReceipt(receipt);publication.receipts.push(receipt);await atomicJson(path.join(out,`publication-request-${draft.action_id}.json`),request);await atomicJson(path.join(out,`publication-receipt-${draft.action_id}.json`),receipt);
              if(receipt.status==='PUBLISHED')publication.published+=1;else if(receipt.status==='RECONCILIATION_REQUIRED')publication.reconciliation_required+=1;else publication.failed+=1;
              priorActions.push({...draft,status:receipt.status});
            }catch(error){
              const status=error?.phase==='dispatch_unknown'?'RECONCILIATION_REQUIRED':'FAILED';
              if(claimed){const receipt=AutoPublicationReceiptSchema.parse({schema_version:'2.0',message_type:'X_PUBLICATION_RECEIPT',request_id:request.request_id,action_id:draft.action_id,publisher_account:'nullquanty',idempotency_key:request.idempotency_key,action_hash:request.action_hash,request_hash:request.request_hash,status,observed_at:nowIso(),error_code:errorCode(error),error_message:error?.message});await store.savePublicationReceipt(receipt);publication.receipts.push(receipt);if(status==='RECONCILIATION_REQUIRED')publication.reconciliation_required+=1;else publication.failed+=1;}else{publication.failed+=1;decisions.push({kind:'PUBLICATION_NOT_ATTEMPTED',action_id:draft.action_id,error_code:errorCode(error)});}
            }
          }
        }finally{if(publisher)await publisher.close().catch(()=>undefined);publisher=undefined;}
      }
      const status=maxDrafts===0?'DISCOVERY_COMPLETE':!autoMode?(selected.length?'READY_FOR_FOUNDER_REVIEW':'NO_ACTION'):options.dryRun?'AUTO_DRY_RUN':publication.reconciliation_required?'RECONCILIATION_REQUIRED':publication.failed?'PARTIAL':publication.published?'AUTO_PUBLISHED':'NO_ACTION';
      const bundle={schema_version:'1.0',message_type:'X_FOUNDER_REVIEW_BUNDLE',run_id:runId,mode,generated_at:nowIso(),source_contexts:[...posts.values()].map(p=>({provider_id:p.provider_id,url:p.url,username:p.username,text:p.text,timestamp:p.timestamp})),context_details:contexts,facts,decisions,drafts:selected,no_action_count:decisions.filter(d=>d.action_type==='NO_ACTION').length,source_health:health,status,model_calls:calls,publisher_enabled:autoMode&&config.publisher.enabled,publication:autoMode?publication:undefined};
      throwIfAborted(signal);await store.writeReviewBundle(path.join(out,'founder-review.json'),bundle);await writeFile(path.join(out,'founder-review.md'),markdownBundle(bundle),{mode:0o600});
      if(autoMode)await atomicJson(path.join(out,'auto-summary.json'),{schema_version:'2.0',message_type:'X_AUTO_PUBLISH_SUMMARY',run_id:runId,mode,status,dry_run:publication.dry_run,...publication,publication,generated_at:nowIso()});
      await store.finishRun(runId,status,nowIso());
      return{run_id:runId,status,mode,source_health:health,discovered:posts.size,drafts:selected.length,no_action:bundle.no_action_count,model_calls:calls,output_dir:out,publisher_enabled:autoMode&&config.publisher.enabled,publication:autoMode?publication:undefined};
    }catch(e){
      const code=signal.aborted?errorCode(signal.reason):errorCode(e);const status=code==='INTERRUPTED'?'INTERRUPTED':code==='MODEL_LIMIT_STOPPED'?code:'FAILED';
      await store.saveEvent(runId,'X_RUN_FAILURE',{code,status},`${runId}:failure:${nowIso()}`);
      await store.finishRun(runId,status,nowIso());
      await atomicJson(path.join(out,'failure.json'),{run_id:runId,status,code,discovered:posts.size,publisher_enabled:autoMode&&config.publisher.enabled});
      throw new Error(code);
    }finally{if(source)await source.close().catch(()=>undefined);if(publisher)await publisher.close().catch(()=>undefined);}
  });}finally{clearTimeout(timeout);options.signal?.removeEventListener('abort',stop);}
}

export async function main(argv=process.argv.slice(2)){
  const {values:v,positionals}=parseArgs({args:argv,allowPositionals:true,strict:true,options:{mode:{type:'string'},fixture:{type:'string'},'run-id':{type:'string'},'replay-run-id':{type:'string'},resume:{type:'string'},'max-drafts':{type:'string'},'max-actions':{type:'string'},'live-read':{type:'boolean'},auto:{type:'boolean'},config:{type:'string'},'dry-run':{type:'boolean'},apply:{type:'boolean'}}});
  const command=positionals[0]||'run';
  if(positionals.length>1)throw new Error('UNEXPECTED_ARGUMENT');
  if(command==='replay'&&!v['run-id'])throw new Error('REPLAY_REQUIRES_RUN_ID');
  const config=await loadConfig(v.config?path.resolve(v.config):undefined);
  const controlCommands=['doctor','status','recover','verify-v1','retention'];
  if(!controlCommands.includes(command)&&command!=='auto'&&(v.mode==='EXPERIMENTAL_LIVE_AUTO'||(!v.mode&&config.mode==='EXPERIMENTAL_LIVE_AUTO')))throw new Error('AUTO_REQUIRES_EXPLICIT_COMMAND');
  if(command==='auto'&&(config.mode!=='EXPERIMENTAL_LIVE_AUTO'||config.publisher.mode!=='AUTOMATIC'))throw new Error('AUTO_CONFIG_REQUIRED');
  if(['doctor','status','recover','verify-v1','retention'].includes(command)){
    const admin=await import('./daily-admin.mjs');
    if(command==='doctor')return admin.doctor({config,liveRead:v['live-read'],auto:v.auto===true});
    if(command==='status')return admin.status(v['run-id'],{config});
    if(command==='recover')return admin.recover(v['run-id'],{config});
    if(command==='verify-v1')return admin.verifyV1({config});
    return admin.retention({config,apply:v.apply===true});
  }
  if(!['run','replay','auto'].includes(command))throw new Error('UNKNOWN_COMMAND');
  const controller=new AbortController(),stop=()=>controller.abort(new Error('INTERRUPTED'));
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try{return await executeDaily({config,mode:command==='auto'?'EXPERIMENTAL_LIVE_AUTO':command==='replay'?'REPLAY_REAL_DATA':v.mode||config.mode,fixture:v.fixture?await loadJson(path.resolve(v.fixture)):undefined,replayRunId:command==='replay'?v['run-id']:v['replay-run-id'],resumeRunId:v.resume,maxDrafts:v['max-drafts']===undefined?undefined:Number(v['max-drafts']),maxActions:v['max-actions']===undefined?undefined:Number(v['max-actions']),dryRun:v['dry-run']===true,signal:controller.signal,onProgress:p=>process.stderr.write(JSON.stringify(p)+'\n')});}
  finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{const result=await main();console.log(JSON.stringify(result));if(['DEGRADED','INCOMPLETE','FAILED'].includes(result.status))process.exitCode=2;}
  catch(e){console.error(JSON.stringify({status:'error',code:errorCode(e)}));process.exitCode=1;}
}
