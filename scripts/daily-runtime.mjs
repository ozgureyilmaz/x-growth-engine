import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { sha256 } from './daily-contracts.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const resolvePath = value => path.resolve(ROOT,value);
export const loadJson = async file => JSON.parse(await readFile(file,'utf8'));
export const READ_TOOLS = ['x_search_tweets','x_get_profile','x_get_tweets','x_get_thread','x_get_replies','x_get_quote_tweets'];
const count = z.number().int().positive();
const score = z.number().min(0).max(1);
export const ConfigSchema = z.object({
  schema_version:z.literal('1.0'), account:z.literal('nullquanty'),
  mode:z.enum(['FIXTURE_DRY_RUN','EXPERIMENTAL_LIVE_READ','REPLAY_REAL_DATA','EXPERIMENTAL_LIVE_AUTO']), facts_path:z.string().optional(),
  source:z.object({kind:z.literal('xactions_mcp'),platform:z.literal('twitter'),command:z.string().min(1),args:z.array(z.string()),read_tools:z.array(z.enum(READ_TOOLS)).min(1)}).strict(),
  discovery:z.object({lookback_hours:count.max(2160),queries_per_run:count.max(120),result_limit_per_query:count.max(20),max_raw_posts:count.max(1200),max_enriched_accounts:count.max(200),timeline_limit_per_account:count.max(20),max_contexts:count.max(12),min_opportunity_score:score.default(.45),max_consecutive_runtime_failures:count,retry_transient_attempts:z.number().int().min(0).max(2),inter_call_delay_seconds:z.number().nonnegative(),call_timeout_ms:count.default(60000)}).strict(),
  intelligence:z.object({max_opportunities:count.max(12),candidates_per_opportunity:count.max(3),max_review_drafts:count.max(5),min_evaluation_score:score,max_spam_risk:score,max_repetition_risk:score,max_unsupported_claim_risk:score,max_codex_calls:count.max(8),max_concurrent_codex_calls:z.literal(1),timeout_ms:count,run_timeout_ms:count.default(1800000)}).strict(),
  codex:z.object({model:z.literal('gpt-5.6-luna'),reasoning_effort:z.literal('xhigh'),binary:z.string().min(1)}).strict(),
  content:z.object({language:z.literal('en'),max_chars:count.max(280),marx_mentions:z.literal(1),links_allowed:z.literal(false),ctas_allowed:z.literal(false),hashtags_allowed:z.literal(false),strategies:z.array(z.string().min(1)).min(1)}).strict(),
  storage:z.object({root:z.string(),database:z.string(),events:z.string()} ).strict(),
  publisher:z.union([
    z.object({enabled:z.literal(false),mode:z.literal('MANUAL_ONLY'),kill_switch:z.literal(true)}).strict(),
    z.object({
      enabled:z.literal(true), mode:z.literal('AUTOMATIC'), kill_switch:z.boolean(),
      max_actions_per_run:count.max(5).default(5), action_timeout_ms:count.default(60000),
      readback_attempts:count.max(5).default(3), readback_delay_ms:z.number().int().nonnegative().default(5000),
      inter_action_delay_seconds:z.number().nonnegative().default(5),
      write_tools:z.object({POST_DRAFT:z.literal('x_post_tweet'),REPLY_DRAFT:z.literal('x_reply'),QUOTE_DRAFT:z.literal('x_quote_tweet')}).strict(),
    }).strict(),
  ]),
}).strict().superRefine((value, ctx) => {
  if (value.mode === 'EXPERIMENTAL_LIVE_AUTO' && (value.publisher.enabled !== true || value.publisher.mode !== 'AUTOMATIC')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['publisher'], message: 'automatic mode requires an enabled automatic publisher' });
  }
});

export async function loadConfig(file=resolvePath('config/daily-experiment.json')) {
  const value=await loadJson(file);
  value.source.command=process.env.XGE_XACTIONS_MCP_COMMAND || value.source.command;
  value.codex.binary=process.env.CODEX_EXEC_BIN || value.codex.binary;
  if (/^(1|true|yes)$/i.test(String(process.env.XGE_PUBLISHER_KILL_SWITCH ?? ''))) value.publisher.kill_switch=true;
  return ConfigSchema.parse(value);
}

export async function approvedFacts(config, now=new Date()) {
  if (!config.facts_path) return [];
  const registry=await loadJson(resolvePath(config.facts_path));
  if(registry.schema_version!=='1.0'||!Array.isArray(registry.facts)) throw new Error('FACT_REGISTRY_INVALID');
  return registry.facts.filter(f=>f.status==='APPROVED').map(f=>{
    if(!f.fact_id||!f.claim||!f.approved_by||!Number.isFinite(Date.parse(f.approved_at))||Date.parse(f.approved_at)>now.getTime()||!Number.isFinite(Date.parse(f.expires_at))||Date.parse(f.expires_at)<=now.getTime()) throw new Error('FACT_APPROVAL_INVALID_OR_EXPIRED');
    const u=new URL(f.source_url);
    if(u.protocol!=='https:'||u.hostname!=='marx.finance') throw new Error('FACT_SOURCE_INVALID');
    const material={fact_id:f.fact_id,claim:f.claim,source_url:f.source_url,prohibited_extrapolations:f.prohibited_extrapolations};
    if(f.claim_hash!==sha256(material)) throw new Error('FACT_HASH_MISMATCH');
    return f;
  });
}

export async function atomicJson(file,value) {
  await mkdir(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  await writeFile(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  await rename(temp,file);
}

export function errorCode(error) {
  const code=String(error?.code||error?.message||error);
  if(code==='RUN_TIMEOUT') return code;
  if(/INTERRUPTED|AbortError/.test(code)) return 'INTERRUPTED';
  if(/MODEL_LIMIT|usage limit|usage_limit|quota|rate_limit_exceeded/i.test(code)) return 'MODEL_LIMIT_STOPPED';
  if(/auth|login|credential|401/i.test(code)) return 'AUTH_REQUIRED';
  if(/captcha|challenge|suspicious/i.test(code)) return 'CHALLENGE';
  if(/rate.?limit|429|too many/i.test(code)) return 'RATE_LIMITED';
  if(/TIMEOUT|timed out/i.test(code)) return /MODEL|CODEX/.test(code)?'MODEL_TIMEOUT':'SOURCE_TIMEOUT';
  if(/MALFORMED|SyntaxError|ZodError|schema|VALIDATION/i.test(code)) return 'INVALID_RESPONSE';
  return /^[A-Z0-9_:]+$/.test(code)?code:'RUNTIME_FAILURE';
}

export function throwIfAborted(signal) { if(signal?.aborted) throw signal.reason || new Error('INTERRUPTED'); }
export function delay(ms,signal) {
  throwIfAborted(signal);
  return new Promise((resolve,reject)=>{
    const stop=()=>{clearTimeout(timer);reject(signal.reason||new Error('INTERRUPTED'));};
    const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},ms);
    signal?.addEventListener('abort',stop,{once:true});
  });
}
