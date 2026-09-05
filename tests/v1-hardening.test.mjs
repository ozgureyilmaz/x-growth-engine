import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizePost } from '../scripts/daily-contracts.mjs';
import { DailyStore } from '../scripts/daily-store.mjs';
import { executeDaily } from '../scripts/run-daily.mjs';
import { retention } from '../scripts/daily-admin.mjs';

test('invalid dates and mismatched author URLs are rejected without crashing', () => {
  const raw = {id:'123',username:'alice',text:'AI trading research',timestamp:'invalid',url:'https://x.com/alice/status/123'};
  assert.equal(normalizePost(raw,'q','b'), undefined);
  assert.equal(normalizePost({...raw,timestamp:'2026-09-04T10:00:00Z',username:'bob'},'q','b'), undefined);
});

test('legacy stored posts become replayable after migrations', async t => {
  const root = await mkdtemp(path.join(tmpdir(),'xge-migration-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const db = path.join(root,'test.sqlite');
  const post = normalizePost({id:'123',username:'alice',text:'AI trading research',timestamp:'2026-09-04T10:00:00Z',url:'https://x.com/alice/status/123'},'q','b','2026-09-04T11:00:00Z');
  const sql = `CREATE TABLE posts(provider_id TEXT PRIMARY KEY,run_id TEXT,username TEXT,url TEXT,timestamp TEXT,evidence_hash TEXT UNIQUE,payload_json TEXT); INSERT INTO posts VALUES('123','legacy','alice','${post.url}','${post.timestamp}','${post.evidence_hash}','${JSON.stringify(post)}');`;
  assert.equal(spawnSync('sqlite3',[db],{input:sql}).status,0);
  const store = new DailyStore(db,path.join(root,'events.jsonl'));
  assert.equal((await store.listPosts('legacy')).length,1);
});

test('invalid max-drafts is rejected before any source or database run', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'xge-budget-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=JSON.parse(await readFile('config/daily-experiment.json','utf8'));
  config.storage={root,database:path.join(root,'test.sqlite'),events:path.join(root,'events.jsonl')};
  await assert.rejects(executeDaily({config,mode:'FIXTURE_DRY_RUN',maxDrafts:-1}),/MAX_DRAFTS/);
});

test('CLI replay requires a source run instead of silently running fixtures', () => {
  const result=spawnSync(process.execPath,['scripts/run-daily.mjs','replay','--max-drafts','0'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/REPLAY_REQUIRES_RUN_ID/);
});

test('retention defaults to dry-run and does not purge without apply', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'xge-retention-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const config=JSON.parse(await readFile('config/daily-experiment.json','utf8'));
  config.storage={root,database:path.join(root,'test.sqlite'),events:path.join(root,'events.jsonl')};
  const result=await retention({config});
  assert.equal(result.status,'DRY_RUN');
});

test('model-limit runs can resume without losing their run identity', async t => {
  const root=await mkdtemp(path.join(tmpdir(),'xge-resume-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new DailyStore(path.join(root,'test.sqlite'),path.join(root,'events.jsonl'));
  await store.startRun('resume_run','REPLAY_REAL_DATA','STORED_EVIDENCE','a'.repeat(64),'2026-09-05T08:00:00Z');
  await store.finishRun('resume_run','MODEL_LIMIT_STOPPED','2026-09-05T08:01:00Z');
  await store.resumeRun('resume_run');
  const state=await store.status('resume_run');
  assert.equal(state.run.status,'RUNNING');
  assert.equal(state.run.finished_at,null);
});
