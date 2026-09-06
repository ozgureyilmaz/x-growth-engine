import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildAutoPublicationRequest } from '../scripts/daily-publication-contracts.mjs';
import { evaluatePublicationPolicy } from '../scripts/daily-policy.mjs';
import { buildDraft } from '../scripts/daily-intelligence.mjs';
import { DailyStore } from '../scripts/daily-store.mjs';
import { drainSpool, withPublisherWorkerLock } from '../scripts/publication-worker.mjs';

function config(root) {
  return {
    schema_version: '1.0', mode: 'EXPERIMENTAL_LIVE_AUTO', account: 'nullquanty',
    source: { kind: 'xactions_mcp', platform: 'twitter', command: 'unused', args: [], read_tools: ['x_search_tweets'] },
    discovery: { lookback_hours: 48, queries_per_run: 1, result_limit_per_query: 10, max_raw_posts: 120, max_enriched_accounts: 10, timeline_limit_per_account: 20, max_contexts: 10, min_opportunity_score: 0.45, max_consecutive_runtime_failures: 3, retry_transient_attempts: 1, inter_call_delay_seconds: 0, call_timeout_ms: 60000 },
    intelligence: { max_opportunities: 1, candidates_per_opportunity: 1, max_review_drafts: 5, min_evaluation_score: 0.72, max_spam_risk: 0.2, max_repetition_risk: 0.25, max_unsupported_claim_risk: 0.15, max_codex_calls: 8, max_concurrent_codex_calls: 1, timeout_ms: 120000, run_timeout_ms: 1800000 },
    codex: { model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', binary: 'codex' },
    content: { language: 'en', max_chars: 280, marx_mentions: 1, links_allowed: false, ctas_allowed: false, hashtags_allowed: false, strategies: ['EVIDENCE_AND_PROVENANCE'] },
    storage: { root, database: path.join(root, 'x-growth.sqlite'), events: path.join(root, 'events.jsonl') },
    publisher: { enabled: true, mode: 'AUTOMATIC', kill_switch: false, dispatch_mode: 'WORKER', worker_spool: path.join(root, 'spool'), worker_lock_path: path.join(root, 'worker.lock'), worker_poll_ms: 10, worker_lease_ms: 60000, browser: { backend: 'browser-use', profile: 'Default', expected_account: 'nullquanty', require_health: false }, max_actions_per_run: 5, action_timeout_ms: 60000, readback_attempts: 1, readback_delay_ms: 0, inter_action_delay_seconds: 0, write_tools: { POST_DRAFT: 'x_post_tweet', REPLY_DRAFT: 'x_reply', QUOTE_DRAFT: 'x_quote_tweet' } },
  };
}

function draft() {
  return buildDraft({ action_type: 'REPLY_DRAFT', body: 'For this trading agent, log failed fills first. Marx can make the assumptions inspectable.', strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'specific_context' }, { post: { provider_id: '1001', url: 'https://x.com/builder/status/1001', username: 'builder', text: 'Building an AI trading agent' }, context_hash: 'a'.repeat(64) }, { context_fit: .9, usefulness: .9, naturalness: .9, marx_relevance: .9, spam_risk: .01, repetition_risk: .01, unsupported_claim_risk: .01, decision: 'PUBLISHABLE' }, { passed: true, reasons: [] }, { run_id: 'worker-run', fact_ids: ['marx-agent-first-finance-platform'], prompt_versions: { opportunity: 'v2', generation: 'v2', evaluation: 'v2' } });
}

test('persistent worker serializes a queued request and archives it after a verified receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cfg = config(root);
  const store = new DailyStore(cfg.storage.database, cfg.storage.events);
  await store.startRun('worker-run', 'EXPERIMENTAL_LIVE_AUTO', 'PASSED', 'a'.repeat(64), '2026-09-06T10:00:00.000Z');
  const action = draft();
  await store.saveDraft('worker-run', action, 'PENDING');
  const policy = evaluatePublicationPolicy(action, cfg, { facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 0, priorActions: [] });
  const request = buildAutoPublicationRequest(action, policy, { grant_id: 'grant_worker', publisher_account: 'nullquanty', expires_at: '2026-09-06T11:00:00.000Z', max_actions: 1 }, new Date('2026-09-06T10:00:00.000Z'), 'worker-run');
  await store.createPublicationRequest(request);
  const pending = path.join(cfg.publisher.worker_spool, 'pending');
  await mkdir(pending, { recursive: true });
  await writeFile(path.join(pending, `${request.request_id}.json`), `${JSON.stringify(request)}\n`);
  let calls = 0;
  const publisher = { publishRequest: async () => { calls += 1; return { status: 'PUBLISHED', provider_id: '9001', permalink: 'https://x.com/nullquanty/status/9001' }; }, close: async () => {} };
  const result = await withPublisherWorkerLock(cfg.publisher.worker_lock_path, ({ token }) => drainSpool(cfg.publisher.worker_spool, { config: cfg, store, ownerToken: token, publisher }));
  assert.equal(result[0].receipt.status, 'PUBLISHED');
  assert.equal(calls, 1);
  assert.equal((await store.getPublicationRequest(request.request_id)).status, 'PUBLISHED');
  assert.deepEqual(await readdir(path.join(cfg.publisher.worker_spool, 'pending')), []);
  await drainSpool(cfg.publisher.worker_spool, { config: cfg, store, publisher });
  assert.equal(calls, 1);
});

test('worker lock rejects a live owner and cleans up after release', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-worker-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, 'lock');
  await withPublisherWorkerLock(lock, async () => {
    await assert.rejects(withPublisherWorkerLock(lock, async () => undefined), /PUBLISHER_WORKER_LOCKED/);
  });
  await assert.doesNotReject(withPublisherWorkerLock(lock, async () => undefined));
});
