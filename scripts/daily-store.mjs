import { access, appendFile, mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { eventEnvelope, DraftSchema, NoActionSchema, ReviewBundleSchema, stableStringify, sha256 } from './daily-contracts.mjs';
import { AutoPublicationRequestSchema, AutoPublicationReceiptSchema } from './daily-publication-contracts.mjs';

function quote(value) { return `'${String(value ?? '').replaceAll("'", "''")}'`; }

function runSql(database, sql, json = false) {
  const args = json ? ['-batch','-bail','-json', '-cmd', '.timeout 5000', database] : ['-batch','-bail','-cmd', '.timeout 5000', database];
  const result = spawnSync('sqlite3', args, { input: sql, encoding: 'utf8', timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw new Error(`SQLITE_UNAVAILABLE:${result.error.message}`);
  if (result.status !== 0) throw new Error(`SQLITE_ERROR:${String(result.stderr).trim().slice(0, 300)}`);
  if (!json) return undefined;
  const output = String(result.stdout).trim();
  return output ? JSON.parse(output) : [];
}

async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w', mode: 0o600 });
  await rename(temporary, file);
}

export class DailyStore {
  constructor(database, eventsPath) {
    this.database = path.resolve(database);
    this.eventsPath = path.resolve(eventsPath);
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;
    await mkdir(path.dirname(this.database), { recursive: true });
    await mkdir(path.dirname(this.eventsPath), { recursive: true });
    runSql(this.database, `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS runs (run_id TEXT PRIMARY KEY, mode TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, source_health TEXT NOT NULL, config_hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS events (event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, message_type TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, payload_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS posts (provider_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, username TEXT NOT NULL, url TEXT NOT NULL, timestamp TEXT NOT NULL, evidence_hash TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS run_posts (run_id TEXT NOT NULL, provider_id TEXT NOT NULL, observed_at TEXT NOT NULL, PRIMARY KEY(run_id, provider_id)); CREATE TABLE IF NOT EXISTS source_calls (call_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL, result_count INTEGER NOT NULL, error_class TEXT); CREATE TABLE IF NOT EXISTS retired_posts (provider_id TEXT PRIMARY KEY, username TEXT NOT NULL, url TEXT NOT NULL, timestamp TEXT NOT NULL, evidence_hash TEXT NOT NULL, retired_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, run_id TEXT NOT NULL, evidence_hash TEXT NOT NULL UNIQUE, payload_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS retired_accounts (username TEXT PRIMARY KEY, evidence_hash TEXT NOT NULL, retired_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS actions (action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, action_type TEXT NOT NULL, action_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL, payload_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS founder_reviews (action_id TEXT PRIMARY KEY, action_hash TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL, reviewed_at TEXT NOT NULL, payload_json TEXT NOT NULL); INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES('001_initial', datetime('now')); INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES('002_lineage_retention_calls', datetime('now'));`);
    const migrated = runSql(this.database, "SELECT 1 AS done FROM schema_migrations WHERE version='003_replay_checkpoints';", true);
    if (!migrated.length) runSql(this.database, `BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO run_posts(run_id,provider_id,observed_at) SELECT run_id,provider_id,COALESCE(json_extract(payload_json,'$.retrieved_at'),timestamp) FROM posts;
      CREATE TABLE IF NOT EXISTS checkpoints(run_id TEXT NOT NULL,step_key TEXT NOT NULL,input_hash TEXT NOT NULL,payload_json TEXT NOT NULL,completed_at TEXT NOT NULL,PRIMARY KEY(run_id,step_key));
      CREATE TABLE IF NOT EXISTS review_history(review_id TEXT PRIMARY KEY,action_id TEXT NOT NULL,action_hash TEXT NOT NULL,decision TEXT NOT NULL,reviewer TEXT NOT NULL,reviewed_at TEXT NOT NULL,payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_settings(run_id TEXT PRIMARY KEY,payload_json TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES('003_replay_checkpoints',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      COMMIT;`);
    const publicationMigrated = runSql(this.database, "SELECT 1 AS done FROM schema_migrations WHERE version='004_publication_ledger';", true);
    if (!publicationMigrated.length) runSql(this.database, `BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS publication_requests(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,action_id TEXT NOT NULL UNIQUE,action_hash TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL UNIQUE,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL,created_at TEXT NOT NULL,claimed_at TEXT,updated_at TEXT NOT NULL,payload_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS publication_receipts(request_id TEXT PRIMARY KEY,action_id TEXT NOT NULL,action_hash TEXT NOT NULL,status TEXT NOT NULL,provider_id TEXT,permalink TEXT,observed_at TEXT NOT NULL,error_code TEXT,error_message TEXT,payload_json TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES('004_publication_ledger',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      COMMIT;`);
    this.initialized = true;
    await chmod(this.database,0o600);
  }

  async startRun(runId, mode, sourceHealth, configHash, startedAt) {
    await this.init();
    runSql(this.database, `INSERT OR IGNORE INTO runs(run_id,mode,status,started_at,source_health,config_hash) VALUES(${quote(runId)},${quote(mode)},'RUNNING',${quote(startedAt)},${quote(sourceHealth)},${quote(configHash)});`);
  }

  async resumeRun(runId, sourceHealth = 'RESUMING') {
    await this.init();
    runSql(this.database, `UPDATE runs SET status='RUNNING',source_health=${quote(sourceHealth)},finished_at=NULL WHERE run_id=${quote(runId)} AND status IN ('INTERRUPTED','FAILED','MODEL_LIMIT_STOPPED');`);
  }

  async finishRun(runId, status, finishedAt) {
    await this.init();
    runSql(this.database, `UPDATE runs SET status=${quote(status)},finished_at=${quote(finishedAt)} WHERE run_id=${quote(runId)};`);
  }

  async updateRunHealth(runId, sourceHealth) {
    await this.init();
    runSql(this.database, `UPDATE runs SET source_health=${quote(sourceHealth)} WHERE run_id=${quote(runId)};`);
  }

  async saveEvent(runId, messageType, payload, idempotencyKey) {
    await this.init();
    const envelope = eventEnvelope(messageType, runId, payload, idempotencyKey);
    const existing = runSql(this.database, `SELECT event_id,created_at,message_type,payload_json FROM events WHERE idempotency_key=${quote(idempotencyKey)};`, true);
    if (existing[0]) return { schema_version: '1.0', message_type: existing[0].message_type, event_id: existing[0].event_id, run_id: runId, created_at: existing[0].created_at, idempotency_key: idempotencyKey, payload: JSON.parse(existing[0].payload_json) };
    runSql(this.database, `INSERT OR IGNORE INTO events(event_id,run_id,message_type,idempotency_key,created_at,payload_json) VALUES(${quote(envelope.event_id)},${quote(runId)},${quote(messageType)},${quote(idempotencyKey)},${quote(envelope.created_at)},${quote(JSON.stringify(envelope.payload))});`);
    await appendFile(this.eventsPath, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 });
    return envelope;
  }

  async savePost(runId, post) {
    await this.init();
    runSql(this.database, `INSERT OR IGNORE INTO posts(provider_id,run_id,username,url,timestamp,evidence_hash,payload_json) VALUES(${quote(post.provider_id)},${quote(runId)},${quote(post.username)},${quote(post.url)},${quote(post.timestamp)},${quote(post.evidence_hash)},${quote(JSON.stringify(post))});`);
    runSql(this.database, `INSERT OR IGNORE INTO run_posts(run_id,provider_id,observed_at) VALUES(${quote(runId)},${quote(post.provider_id)},${quote(post.retrieved_at)});`);
  }

  async listPosts(runId) {
    await this.init();
    const rows = runSql(this.database, `SELECT p.payload_json AS payload_json FROM posts p JOIN run_posts rp ON rp.provider_id=p.provider_id WHERE rp.run_id=${quote(runId)} ORDER BY p.timestamp DESC;`, true);
    return rows.map((row) => JSON.parse(row.payload_json));
  }

  async checkpoint(runId,key,inputHash,payload) {
    await this.init();
    runSql(this.database,`INSERT OR IGNORE INTO checkpoints VALUES(${quote(runId)},${quote(key)},${quote(inputHash)},${quote(JSON.stringify(payload))},${quote(new Date().toISOString())});`);
  }

  async readCheckpoint(runId,key,inputHash) {
    await this.init();
    const row=runSql(this.database,`SELECT * FROM checkpoints WHERE run_id=${quote(runId)} AND step_key=${quote(key)};`,true)[0];
    if(!row) return undefined;
    if(row.input_hash!==inputHash) throw new Error('CHECKPOINT_INPUT_CHANGED');
    return JSON.parse(row.payload_json);
  }

  async settings(runId,value) {
    await this.init();
    if(value) runSql(this.database,`INSERT OR IGNORE INTO run_settings VALUES(${quote(runId)},${quote(JSON.stringify(value))});`);
    const row=runSql(this.database,`SELECT payload_json FROM run_settings WHERE run_id=${quote(runId)};`,true)[0];
    return row?JSON.parse(row.payload_json):undefined;
  }

  async modelCallsStarted(runId) {
    await this.init();
    return runSql(this.database,`SELECT count(*) AS n FROM events WHERE run_id=${quote(runId)} AND message_type='X_MODEL_STARTED';`,true)[0].n;
  }

  async unfinishedRuns() {
    await this.init();
    return runSql(this.database,"SELECT run_id,status FROM runs WHERE status='RUNNING';",true);
  }

  async integrity() {await this.init();return runSql(this.database,'PRAGMA integrity_check;',true)[0].integrity_check;}

  async saveSourceCall(runId, tool, status, startedAt, finishedAt, resultCount = 0, errorClass = null) {
    await this.init();
    runSql(this.database, `INSERT OR IGNORE INTO source_calls(call_id,run_id,tool,status,started_at,finished_at,result_count,error_class) VALUES(${quote(`${runId}:${tool}:${startedAt}`)},${quote(runId)},${quote(tool)},${quote(status)},${quote(startedAt)},${quote(finishedAt)},${Number(resultCount) || 0},${quote(errorClass)});`);
  }

  async saveAccount(runId, account) {
    await this.init();
    runSql(this.database, `INSERT OR REPLACE INTO accounts(username,run_id,evidence_hash,payload_json) VALUES(${quote(account.username)},${quote(runId)},${quote(account.evidence_hash)},${quote(JSON.stringify(account))});`);
  }

  async saveDraft(runId, draft, status = 'READY_FOR_FOUNDER_REVIEW') {
    const valid = DraftSchema.parse(draft);
    await this.init();
    const existing = runSql(this.database, `SELECT action_hash AS action_hash,payload_json AS payload_json FROM actions WHERE action_id=${quote(valid.action_id)};`, true);
    if (existing[0] && existing[0].action_hash !== valid.action_hash) throw new Error('ACTION_ID_HASH_CONFLICT');
    runSql(this.database, `INSERT OR IGNORE INTO actions(action_id,run_id,action_type,action_hash,status,payload_json) VALUES(${quote(valid.action_id)},${quote(runId)},${quote(valid.action_type)},${quote(valid.action_hash)},${quote(status)},${quote(JSON.stringify(valid))});`);
    return valid;
  }

  async saveNoAction(runId, value) {
    const valid = NoActionSchema.parse(value);
    await this.init();
    runSql(this.database, `INSERT OR IGNORE INTO actions(action_id,run_id,action_type,action_hash,status,payload_json) VALUES(${quote(valid.action_id)},${quote(runId)},'NO_ACTION',${quote(sha256(valid))},'NO_ACTION',${quote(JSON.stringify(valid))});`);
    return valid;
  }

  async listDrafts(runId) {
    await this.init();
    const rows = runSql(this.database, `SELECT payload_json AS payload_json FROM actions WHERE run_id=${quote(runId)} AND action_type IN ('POST_DRAFT','REPLY_DRAFT','QUOTE_DRAFT') AND status='READY_FOR_FOUNDER_REVIEW' ORDER BY action_id;`, true);
    return rows.map((row) => DraftSchema.parse(JSON.parse(row.payload_json)));
  }

  async listRecentBodies(mode='EXPERIMENTAL_LIVE_READ') {
    await this.init();
    const predicate=mode==='FIXTURE_DRY_RUN'?"r.mode='FIXTURE_DRY_RUN'":"r.mode<>'FIXTURE_DRY_RUN'";
    const rows = runSql(this.database, `SELECT a.payload_json FROM actions a JOIN runs r ON r.run_id=a.run_id WHERE a.action_type IN ('POST_DRAFT','REPLY_DRAFT','QUOTE_DRAFT') AND ${predicate} AND r.status IN ('READY_FOR_FOUNDER_REVIEW','NO_ACTION') ORDER BY a.action_id;`, true);
    return rows.map((row) => { try { return JSON.parse(row.payload_json).body; } catch { return ''; } }).filter(Boolean);
  }

  async saveReviewDecision(value) {
    if (!value || typeof value !== 'object') throw new Error('INVALID_FOUNDER_REVIEW');
    const decision = String(value.decision ?? '');
    const allowed = new Set(['APPROVED', 'NEEDS_REVISION', 'REJECTED_GENERIC', 'REJECTED_PROMOTIONAL', 'REJECTED_IRRELEVANT', 'REJECTED_UNSUPPORTED', 'REJECTED_VOICE']);
    if (!allowed.has(decision)) throw new Error('INVALID_FOUNDER_DECISION');
    if (!/^[a-f0-9]{64}$/.test(String(value.action_hash ?? '')) || !Number.isFinite(Date.parse(value.reviewed_at))) throw new Error('INVALID_FOUNDER_REVIEW');
    await this.init();
    const action = runSql(this.database, `SELECT action_hash AS action_hash FROM actions WHERE action_id=${quote(value.action_id)};`, true)[0];
    if (!action || action.action_hash !== value.action_hash) throw new Error('FOUNDER_REVIEW_ACTION_HASH_MISMATCH');
    runSql(this.database, `INSERT OR REPLACE INTO founder_reviews(action_id,action_hash,decision,reason,reviewed_at,payload_json) VALUES(${quote(value.action_id)},${quote(value.action_hash)},${quote(decision)},${quote(value.reason ?? '')},${quote(value.reviewed_at)},${quote(JSON.stringify(value))}); UPDATE actions SET status=${quote(decision)} WHERE action_id=${quote(value.action_id)};`);
  }

  async createPublicationRequest(value) {
    const request = AutoPublicationRequestSchema.parse(value);
    await this.init();
    const existing = runSql(this.database, `SELECT request_id,action_hash,request_hash,status,payload_json FROM publication_requests WHERE request_id=${quote(request.request_id)} OR action_id=${quote(request.action.action_id)};`, true)[0];
    if (existing && (existing.action_hash !== request.action_hash || existing.request_hash !== request.request_hash)) throw new Error('PUBLICATION_REQUEST_CONFLICT');
    runSql(this.database, `INSERT OR IGNORE INTO publication_requests(request_id,run_id,action_id,action_hash,request_hash,idempotency_key,status,created_at,updated_at,payload_json) VALUES(${quote(request.request_id)},${quote(request.run_id)},${quote(request.action.action_id)},${quote(request.action_hash)},${quote(request.request_hash)},${quote(request.idempotency_key)},'PENDING',${quote(request.created_at)},${quote(request.created_at)},${quote(JSON.stringify(request))});`);
    return (await this.listPublicationRequests(request.run_id)).find((item) => item.request_id === request.request_id) ?? request;
  }

  async claimPublicationRequest(requestId) {
    await this.init();
    const now = new Date().toISOString();
    runSql(this.database, `BEGIN IMMEDIATE; UPDATE publication_requests SET status='CLAIMED',claimed_at=COALESCE(claimed_at,${quote(now)}),updated_at=${quote(now)} WHERE request_id=${quote(requestId)} AND status='PENDING'; COMMIT;`);
    const row = runSql(this.database, `SELECT request_id,run_id,action_id,action_hash,request_hash,idempotency_key,status,created_at,claimed_at,updated_at,payload_json FROM publication_requests WHERE request_id=${quote(requestId)};`, true)[0];
    return row ? { ...row, payload: JSON.parse(row.payload_json) } : undefined;
  }

  async savePublicationReceipt(value) {
    const receipt = AutoPublicationReceiptSchema.parse(value);
    await this.init();
    const request = runSql(this.database, `SELECT action_id,action_hash FROM publication_requests WHERE request_id=${quote(receipt.request_id)};`, true)[0];
    if (!request || request.action_id !== receipt.action_id || request.action_hash !== receipt.action_hash) throw new Error('PUBLICATION_RECEIPT_REQUEST_MISMATCH');
    const existing = runSql(this.database, `SELECT payload_json FROM publication_receipts WHERE request_id=${quote(receipt.request_id)};`, true)[0];
    if (existing) {
      const prior = JSON.parse(existing.payload_json);
      const fields = ['status', 'provider_id', 'permalink', 'error_code', 'error_message', 'action_hash', 'request_hash'];
      if (fields.some((field) => prior[field] !== receipt[field])) throw new Error('PUBLICATION_RECEIPT_CONFLICT');
      return AutoPublicationReceiptSchema.parse(prior);
    }
    runSql(this.database, `INSERT OR REPLACE INTO publication_receipts(request_id,action_id,action_hash,status,provider_id,permalink,observed_at,error_code,error_message,payload_json) VALUES(${quote(receipt.request_id)},${quote(receipt.action_id)},${quote(receipt.action_hash)},${quote(receipt.status)},${quote(receipt.provider_id)},${quote(receipt.permalink)},${quote(receipt.observed_at)},${quote(receipt.error_code)},${quote(receipt.error_message)},${quote(JSON.stringify(receipt))}); UPDATE publication_requests SET status=${quote(receipt.status)},updated_at=${quote(receipt.observed_at)} WHERE request_id=${quote(receipt.request_id)}; UPDATE actions SET status=${quote(receipt.status)} WHERE action_id=${quote(receipt.action_id)};`);
    return receipt;
  }

  async listPublicationRequests(runId) {
    await this.init();
    const rows = runSql(this.database, `SELECT request_id,run_id,action_id,action_hash,request_hash,idempotency_key,status,created_at,claimed_at,updated_at,payload_json FROM publication_requests WHERE run_id=${quote(runId)} ORDER BY created_at,request_id;`, true);
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }));
  }

  async publicationHistory() {
    await this.init();
    const rows = runSql(this.database, 'SELECT action_id,action_hash,status,payload_json FROM publication_requests ORDER BY created_at;', true);
    return rows.map((row) => ({ ...row, ...JSON.parse(row.payload_json).action }));
  }

  async markClaimedForReconciliation(runId) {
    await this.init();
    runSql(this.database, `BEGIN IMMEDIATE; UPDATE publication_requests SET status='RECONCILIATION_REQUIRED',updated_at=datetime('now') WHERE run_id=${quote(runId)} AND status IN ('PENDING','CLAIMED'); UPDATE actions SET status='RECONCILIATION_REQUIRED' WHERE action_id IN (SELECT action_id FROM publication_requests WHERE run_id=${quote(runId)} AND status='RECONCILIATION_REQUIRED'); COMMIT;`);
  }

  async writeReviewBundle(file, bundle) {
    const valid = ReviewBundleSchema.parse(bundle);
    await atomicJson(file, valid);
    return valid;
  }

  async status(runId) {
    await this.init();
    const runs = runSql(this.database, `SELECT run_id,mode,status,started_at,finished_at,source_health FROM runs WHERE run_id=${quote(runId)};`, true);
    const counts = runSql(this.database, `SELECT action_type,status,COUNT(*) AS count FROM actions WHERE run_id=${quote(runId)} GROUP BY action_type,status ORDER BY action_type,status;`, true);
    return { run: runs[0] ?? null, counts };
  }

  async v1Gate() {
    await this.init();
    const rows = runSql(this.database, "SELECT a.action_type,COUNT(*) AS count FROM actions a JOIN founder_reviews r ON r.action_id=a.action_id JOIN runs run ON run.run_id=a.run_id WHERE r.decision='APPROVED' AND run.mode IN ('EXPERIMENTAL_LIVE_READ','REPLAY_REAL_DATA') GROUP BY a.action_type;", true);
    const approved = Object.fromEntries(rows.map((row) => [row.action_type, Number(row.count)]));
    const required = ['POST_DRAFT', 'REPLY_DRAFT', 'QUOTE_DRAFT'];
    return { status: required.every((type) => (approved[type] ?? 0) >= 1) ? 'PASS' : 'INCOMPLETE', required, approved };
  }

  async latestRun() {
    await this.init();
    const rows = runSql(this.database, 'SELECT run_id,mode,status,started_at,finished_at,source_health FROM runs ORDER BY started_at DESC LIMIT 1;', true);
    return rows[0] ?? null;
  }

  async markInterrupted(runId, reason = 'OWNER_NOT_ALIVE') {
    await this.init();
    runSql(this.database, `UPDATE runs SET status='INTERRUPTED',source_health=${quote(reason)},finished_at=datetime('now') WHERE run_id=${quote(runId)} AND status='RUNNING';`);
  }

  async purgeRaw(cutoffIso) {
    await this.init();
    runSql(this.database, `BEGIN; INSERT OR IGNORE INTO retired_posts(provider_id,username,url,timestamp,evidence_hash,retired_at) SELECT provider_id,username,url,timestamp,evidence_hash,datetime('now') FROM posts WHERE timestamp < ${quote(cutoffIso)}; INSERT OR IGNORE INTO retired_accounts(username,evidence_hash,retired_at) SELECT username,evidence_hash,datetime('now') FROM accounts WHERE json_extract(payload_json,'$.retrieved_at') < ${quote(cutoffIso)}; DELETE FROM posts WHERE timestamp < ${quote(cutoffIso)}; DELETE FROM accounts WHERE json_extract(payload_json,'$.retrieved_at') < ${quote(cutoffIso)}; COMMIT;`);
  }
}

export async function withRunLock(root, operation) {
  await mkdir(root,{recursive:true});
  const lock = path.join(path.resolve(root), '.daily-run.lock');
  try { await mkdir(lock); } catch (error) { if (error.code === 'EEXIST') throw new Error('DAILY_RUN_LOCKED'); throw error; }
  const token=randomUUID();
  const owner={pid:process.pid,token,host:hostname(),acquired_at:new Date().toISOString()};
  const ownerFile=path.join(lock,'owner.json');
  const owns=async()=>{try{return JSON.parse(await readFile(ownerFile,'utf8')).token===token;}catch{return false;}};
  let timer;let heartbeat=Promise.resolve();
  try {
    await writeFile(ownerFile,JSON.stringify(owner),{mode:0o600});
    timer=setInterval(()=>{heartbeat=heartbeat.then(async()=>{if(await owns()) await atomicJson(ownerFile,{...owner,heartbeat_at:new Date().toISOString()});}).catch(()=>{});},5000);
    return await operation();
  } finally {clearInterval(timer);await heartbeat;if(await owns()) await rm(lock,{recursive:true,force:true});}
}
