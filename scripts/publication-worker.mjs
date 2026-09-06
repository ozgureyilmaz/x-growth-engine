import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AutoPublicationReceiptSchema, AutoPublicationRequestSchema, verifyAutoReceipt } from './daily-publication-contracts.mjs';
import { DailyStore } from './daily-store.mjs';
import { errorCode, loadConfig, resolvePath, approvedFacts } from './daily-runtime.mjs';
import { evaluatePublicationPolicy } from './daily-policy.mjs';
import { HermesXPublisher } from './hermes-x-publisher.mjs';
import { checkPublisherRuntime, publisherRuntimeEnv } from './publisher-runtime.mjs';

function nowIso() { return new Date().toISOString(); }

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}

async function readRequest(file) {
  return AutoPublicationRequestSchema.parse(JSON.parse(await readFile(file, 'utf8')));
}

async function archiveRequest(file, root, status) {
  const destinationRoot = status === 'PUBLISHED' || status === 'FAILED' ? path.join(root, 'completed') : path.join(root, 'reconciliation');
  await mkdir(destinationRoot, { recursive: true });
  const destination = path.join(destinationRoot, path.basename(file));
  try { await rename(file, destination); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return destination;
}

export async function withPublisherWorkerLock(lockPath, fn) {
  const absolute = path.resolve(lockPath);
  await mkdir(path.dirname(absolute), { recursive: true });
  const token = randomUUID();
  try {
    await mkdir(absolute);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(await readFile(path.join(absolute, 'owner.json'), 'utf8')); } catch { owner = undefined; }
    if (owner?.pid && (() => { try { process.kill(owner.pid, 0); return true; } catch { return false; } })()) throw new Error(`PUBLISHER_WORKER_LOCKED:${owner.pid}`);
    await rm(absolute, { recursive: true, force: true });
    await mkdir(absolute);
  }
  await atomicJson(path.join(absolute, 'owner.json'), { pid: process.pid, token, acquired_at: nowIso() });
  try { return await fn({ token, lockPath: absolute }); }
  finally { try { await rm(absolute, { recursive: true, force: true }); } catch { /* best effort cleanup */ } }
}

function publisherFor(config, options = {}) {
  if (options.publisher) return options.publisher;
  return new HermesXPublisher({
    hermesCommand: process.env.HERMES_BIN || '/Users/0x79de/.local/bin/hermes',
    model: config.codex.model,
    reasoningEffort: config.codex.reasoning_effort,
    timeoutMs: config.publisher.action_timeout_ms,
    cwd: resolvePath('.'),
    runtimeEnv: publisherRuntimeEnv(config),
    allowStaleCleanup: false,
  });
}

function receiptFor(request, value) {
  return AutoPublicationReceiptSchema.parse({
    schema_version: '2.0', message_type: 'X_PUBLICATION_RECEIPT', request_id: request.request_id,
    action_id: request.action.action_id, publisher_account: request.publisher_account,
    idempotency_key: request.idempotency_key, action_hash: request.action_hash, request_hash: request.request_hash,
    status: value.status, provider_id: value.provider_id, permalink: value.permalink,
    observed_at: value.observed_at || nowIso(), error_code: value.error_code, error_message: value.error_message,
  });
}

export async function publishRequestFile(requestPath, options = {}) {
  const absolute = path.resolve(requestPath);
  const request = await readRequest(absolute);
  const config = options.config ?? await loadConfig(options.configPath ?? resolvePath('config/daily-v2.json'));
  if (!options.publisher) {
    if(config.publisher.enabled!==true || config.publisher.kill_switch || /^(1|true|yes)$/i.test(process.env.XGE_PUBLISHER_KILL_SWITCH||''))throw new Error('PUBLISHER_DISABLED');
    if(Date.parse(request.grant.expires_at)<=Date.now())throw new Error('PUBLICATION_GRANT_EXPIRED');
    const policy=evaluatePublicationPolicy(request.action,config,{facts:await approvedFacts(config)});
    if(policy.decision!=='ALLOW'||policy.policy_hash!==request.authorization.policy_hash)throw new Error('PUBLICATION_POLICY_CHANGED');
    verifyAutoReceipt(request,receiptFor(request,{status:'FAILED'}));
    await checkPublisherRuntime(config);
  }
  const spoolRoot = options.spoolPath ?? path.dirname(path.dirname(absolute));
  const receiptPath = options.receiptPath ?? path.join(spoolRoot, 'receipts', `publication-receipt-${request.request_id}.json`);
  const store = options.store ?? (options.database ? new DailyStore(options.database, options.events) : undefined);
  if (store) {
    await store.init();
    const row = await store.getPublicationRequest(request.request_id);
    if (!row || row.action_hash !== request.action_hash || row.request_hash !== request.request_hash) throw new Error('PUBLICATION_REQUEST_LEDGER_MISMATCH');
    if (options.requireClaim && (row.status !== 'CLAIMED' || row.owner_token !== options.ownerToken)) throw new Error('PUBLICATION_CLAIM_REQUIRED');
  }
  const ownerToken = options.ownerToken || `publisher_${process.pid}_${randomUUID()}`;
  const publisher = publisherFor(config, options);
  let receipt;
  try {
    const result = await publisher.publishRequest(absolute);
    receipt = receiptFor(request, result);
    verifyAutoReceipt(request, receipt);
  } catch (error) {
    receipt = receiptFor(request, { status: 'RECONCILIATION_REQUIRED', error_code: errorCode(error), error_message: String(error?.message || error).replace(/[\r\n]+/g, ' ').slice(-800) });
  } finally {
    try { await publisher.close?.(); } catch { /* cleanup is best effort */ }
  }
  if (store) await store.savePublicationReceipt(receipt, { ownerToken });
  await atomicJson(receiptPath, receipt);
  return { request, receipt, receiptPath };
}

export async function drainSpool(spoolPath, options = {}) {
  const root = path.resolve(spoolPath);
  const pending = path.join(root, 'pending');
  const receipts = path.join(root, 'receipts');
  await mkdir(pending, { recursive: true });
  await mkdir(receipts, { recursive: true });
  const config = options.config ?? await loadConfig(options.configPath ?? resolvePath('config/daily-v2.json'));
  await checkPublisherRuntime(config);
  const store = options.store ?? new DailyStore(options.database ?? resolvePath(config.storage.database), options.events ?? resolvePath(config.storage.events));
  await store.init();
  const ownerToken = options.ownerToken || `publisher_${process.pid}_${randomUUID()}`;
  const files = (await readdir(pending)).filter(file => file.endsWith('.json') && !file.endsWith('.execution.json')).sort();
  const results = [];
  for (const file of files) {
    const requestPath = path.join(pending, file);
    let request;
    try { request = await readRequest(requestPath); } catch (error) {
      await archiveRequest(requestPath, root, 'RECONCILIATION_REQUIRED');
      results.push({ status: 'RECONCILIATION_REQUIRED', error_code: errorCode(error), request_path: requestPath });
      break;
    }
    const row = await store.getPublicationRequest(request.request_id);
    if (!row || row.action_hash !== request.action_hash || row.request_hash !== request.request_hash) {
      await archiveRequest(requestPath, root, 'RECONCILIATION_REQUIRED');
      results.push({ status: 'RECONCILIATION_REQUIRED', request_id: request.request_id, error_code: 'PUBLICATION_REQUEST_LEDGER_MISMATCH' });
      break;
    }
    if (['PUBLISHED', 'FAILED', 'RECONCILIATION_REQUIRED'].includes(row.status)) {
      await archiveRequest(requestPath, root, row.status);
      continue;
    }
    const claim = await store.claimPublicationRequest(request.request_id, { ownerToken, leaseMs: config.publisher.worker_lease_ms });
    if (!claim) continue;
    const result = await publishRequestFile(requestPath, { ...options, config, store, ownerToken, spoolPath: root, receiptPath: path.join(receipts, `publication-receipt-${request.request_id}.json`) });
    results.push(result);
    await archiveRequest(requestPath, root, result.receipt.status);
    if (result.receipt.status === 'RECONCILIATION_REQUIRED') break;
  }
  return results;
}

export async function runWorker(config, options = {}) {
  const spool = resolvePath(config.publisher.worker_spool);
  const lock = resolvePath(config.publisher.worker_lock_path);
  return withPublisherWorkerLock(lock, async ({ token }) => drainSpool(spool, { ...options, config, ownerToken: token }));
}

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({ args: argv.slice(1), strict: true, options: { request: { type: 'string' }, config: { type: 'string' }, 'poll-ms': { type: 'string' } } });
  const command = argv[0] || 'drain';
  const config = await loadConfig(values.config ? path.resolve(values.config) : resolvePath('config/daily-v2.json'));
  if (command === 'once') {
    if (!values.request) throw new Error('PUBLISHER_REQUEST_REQUIRED');
    const result = await withPublisherWorkerLock(resolvePath(config.publisher.worker_lock_path), async ({ token }) => {
      const store = new DailyStore(resolvePath(config.storage.database), resolvePath(config.storage.events));
      await store.init();
      const request = await readRequest(values.request);
      await checkPublisherRuntime(config);
      if(Date.parse(request.grant.expires_at)<=Date.now())throw new Error('PUBLICATION_GRANT_EXPIRED');
      const claim = await store.claimPublicationRequest(request.request_id, { ownerToken: token, leaseMs: config.publisher.worker_lease_ms });
      if (!claim) throw new Error('PUBLICATION_CLAIM_UNAVAILABLE');
      return publishRequestFile(values.request, { config, ownerToken: token, requireClaim: true, store, spoolPath: resolvePath(config.publisher.worker_spool), receiptPath: path.join(resolvePath(config.publisher.worker_spool), 'receipts', `publication-receipt-${request.request_id}.json`) });
    });
    await archiveRequest(path.resolve(values.request), resolvePath(config.publisher.worker_spool), result.receipt.status);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (!['drain', 'watch'].includes(command)) throw new Error('UNKNOWN_PUBLISHER_COMMAND');
  let result = await runWorker(config);
  if (command === 'watch') {
    const interval = Number(values['poll-ms'] ?? config.publisher.worker_poll_ms);
    let stopping = false;
    const stop = () => { stopping = true; };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    while (!stopping) { await new Promise(resolve => setTimeout(resolve, interval)); if (!stopping) result = await runWorker(config); }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await main(); } catch (error) { console.error(JSON.stringify({ status: 'error', code: errorCode(error) })); process.exitCode = 1; }
}
