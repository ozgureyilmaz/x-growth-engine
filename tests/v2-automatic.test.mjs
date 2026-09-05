import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildAutoPublicationRequest, verifyAutoReceipt } from '../scripts/daily-publication-contracts.mjs';
import { evaluatePublicationPolicy } from '../scripts/daily-policy.mjs';
import { buildDraft } from '../scripts/daily-intelligence.mjs';
import { DailyStore, withRunLock } from '../scripts/daily-store.mjs';
import { compactContext, compactEvaluationContext, executeDaily, main } from '../scripts/run-daily.mjs';
import { buildHermesArgs, HermesXPublisher, parseHermesReceipt } from '../scripts/hermes-x-publisher.mjs';
import { normalizePost, sha256 } from '../scripts/daily-contracts.mjs';

function autoConfig(root) {
  return {
    schema_version: '1.0', mode: 'EXPERIMENTAL_LIVE_AUTO', account: 'nullquanty', facts_path: undefined,
    source: { kind: 'xactions_mcp', platform: 'twitter', command: 'unused', args: [], read_tools: ['x_search_tweets', 'x_get_profile', 'x_get_tweets', 'x_get_thread', 'x_get_replies', 'x_get_quote_tweets'] },
    discovery: { lookback_hours: 48, queries_per_run: 1, result_limit_per_query: 10, max_raw_posts: 120, max_enriched_accounts: 10, timeline_limit_per_account: 20, max_contexts: 10, min_opportunity_score: 0.45, max_consecutive_runtime_failures: 3, retry_transient_attempts: 2, inter_call_delay_seconds: 0, call_timeout_ms: 60000 },
    intelligence: { max_opportunities: 1, candidates_per_opportunity: 3, max_review_drafts: 5, min_evaluation_score: 0.72, max_spam_risk: 0.2, max_repetition_risk: 0.25, max_unsupported_claim_risk: 0.15, max_codex_calls: 8, max_concurrent_codex_calls: 1, timeout_ms: 120000, run_timeout_ms: 1800000 },
    codex: { model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', binary: 'codex' },
    content: { language: 'en', max_chars: 280, marx_mentions: 1, links_allowed: false, ctas_allowed: false, hashtags_allowed: false, strategies: ['EVIDENCE_AND_PROVENANCE', 'VALIDATION_AND_FAILURE_MODES', 'AGENT_WORKFLOW'] },
    storage: { root, database: path.join(root, 'x-growth.sqlite'), events: path.join(root, 'events.jsonl') },
    publisher: { enabled: true, mode: 'AUTOMATIC', kill_switch: false, max_actions_per_run: 5, action_timeout_ms: 60000, readback_attempts: 1, readback_delay_ms: 0, inter_action_delay_seconds: 0, write_tools: { POST_DRAFT: 'x_post_tweet', REPLY_DRAFT: 'x_reply', QUOTE_DRAFT: 'x_quote_tweet' } },
  };
}

function draft() {
  return buildDraft({
    action_type: 'REPLY_DRAFT',
    body: 'For the trading agent, log failed fills first. Marx can make those assumptions inspectable.',
    strategy_family: 'EVIDENCE_AND_PROVENANCE',
    hook_family: 'specific_context',
  }, {
    post: { provider_id: '1001', url: 'https://x.com/builder/status/1001', username: 'builder', text: 'Building an AI trading agent' },
    context_hash: 'a'.repeat(64),
  }, {
    context_fit: 0.9, usefulness: 0.9, naturalness: 0.9, marx_relevance: 0.9, spam_risk: 0.01, repetition_risk: 0.01, unsupported_claim_risk: 0.01, decision: 'PUBLISHABLE',
  }, { passed: true, reasons: [] }, { run_id: 'auto-run', fact_ids: ['marx-agent-first-finance-platform'], prompt_versions: { opportunity: 'v2', generation: 'v2', evaluation: 'v2' } });
}

test('automatic policy allows a publishable draft without founder approval', () => {
  const action = draft();
  const result = evaluatePublicationPolicy(action, autoConfig('/tmp/xge-policy'), { now: new Date('2026-09-05T10:00:00.000Z'), facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 0, priorActions: [] });
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.action_hash, action.action_hash);
  assert.match(result.policy_hash, /^[a-f0-9]{64}$/);
});

test('automatic policy blocks a duplicate, invalid target, or cap breach', () => {
  const action = draft();
  const config = autoConfig('/tmp/xge-policy');
  const duplicate = evaluatePublicationPolicy(action, config, { facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 5, priorActions: [{ action_hash: action.action_hash }] });
  assert.equal(duplicate.decision, 'BLOCK');
  assert.ok(duplicate.reasons.includes('PUBLISH_CAP_REACHED'));
  assert.ok(duplicate.reasons.includes('DUPLICATE_ACTION'));
});

test('automatic policy kill switch blocks every action', () => {
  const action = draft();
  const config = autoConfig('/tmp/xge-policy');
  config.publisher.kill_switch = true;
  const result = evaluatePublicationPolicy(action, config, { facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 0, priorActions: [] });
  assert.equal(result.decision, 'BLOCK');
  assert.ok(result.reasons.includes('PUBLISHER_KILL_SWITCH_ENGAGED'));
});

test('automatic request and receipt bind policy, grant, and exact action', () => {
  const action = draft();
  const policy = evaluatePublicationPolicy(action, autoConfig('/tmp/xge-contract'), { facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 0, priorActions: [] });
  const grant = { grant_id: 'grant_auto', publisher_account: 'nullquanty', expires_at: '2026-09-05T11:00:00.000Z', max_actions: 5 };
  const request = buildAutoPublicationRequest(action, policy, grant, new Date('2026-09-05T10:00:00.000Z'));
  assert.equal(request.authorization.mode, 'AUTOMATED_POLICY');
  assert.equal(request.action_hash, action.action_hash);
  const receipt = verifyAutoReceipt(request, { schema_version: '2.0', message_type: 'X_PUBLICATION_RECEIPT', request_id: request.request_id, action_id: action.action_id, publisher_account: 'nullquanty', idempotency_key: request.idempotency_key, action_hash: request.action_hash, request_hash: request.request_hash, status: 'PUBLISHED', provider_id: '2001', permalink: 'https://x.com/nullquanty/status/2001', observed_at: '2026-09-05T10:01:00.000Z' });
  assert.equal(receipt.status, 'PUBLISHED');
  assert.throws(() => verifyAutoReceipt(request, { ...receipt, action_hash: '0'.repeat(64) }), /PUBLICATION_RECEIPT_BINDING_MISMATCH/);
});

test('publication ledger claims each automatic request once and stores receipt state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DailyStore(path.join(root, 'test.sqlite'), path.join(root, 'events.jsonl'));
  const action = draft();
  const policy = evaluatePublicationPolicy(action, autoConfig(root), { facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 0, priorActions: [] });
  const request = buildAutoPublicationRequest(action, policy, { grant_id: 'grant_auto', publisher_account: 'nullquanty', expires_at: '2026-09-05T11:00:00.000Z', max_actions: 5 }, new Date('2026-09-05T10:00:00.000Z'), 'auto-run');
  await store.startRun('auto-run', 'EXPERIMENTAL_LIVE_AUTO', 'PASSED', 'a'.repeat(64), '2026-09-05T10:00:00.000Z');
  await store.saveDraft('auto-run', action, 'PENDING');
  await store.createPublicationRequest(request);
  assert.equal((await store.claimPublicationRequest(request.request_id)).status, 'CLAIMED');
  assert.equal((await store.claimPublicationRequest(request.request_id)).status, 'CLAIMED');
  await store.savePublicationReceipt({ schema_version: '2.0', message_type: 'X_PUBLICATION_RECEIPT', request_id: request.request_id, action_id: action.action_id, publisher_account: 'nullquanty', idempotency_key: request.idempotency_key, action_hash: request.action_hash, request_hash: request.request_hash, status: 'PUBLISHED', provider_id: '2001', permalink: 'https://x.com/nullquanty/status/2001', observed_at: '2026-09-05T10:01:00.000Z' });
  assert.equal((await store.listPublicationRequests('auto-run'))[0].status, 'PUBLISHED');
});

test('automatic dry-run produces requests without invoking a publisher', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-dry-run-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = autoConfig(root);
  const fixture = { search_results: [{ id: '1001', username: 'builder', text: 'Building an AI trading agent', timestamp: '2026-09-05T09:00:00.000Z', url: 'https://x.com/builder/status/1001', likes: 8, retweets: 2, replies: 1 }], profiles: [{ username: 'builder', name: 'Builder', bio: 'AI trading developer', followers: 10 }] };
  const result = await executeDaily({ config, mode: 'EXPERIMENTAL_LIVE_AUTO', fixture, source: undefined, dryRun: true, maxActions: 1, runId: 'auto_dry_run', now: new Date('2026-09-05T10:00:00.000Z') });
  assert.equal(result.status, 'AUTO_DRY_RUN');
  assert.equal(result.publisher_enabled, true);
  const summary = JSON.parse(await readFile(path.join(root, 'auto_dry_run', 'auto-summary.json'), 'utf8'));
  assert.equal(summary.dry_run, true);
  assert.ok(summary.requests.length >= 1);
});

test('CLI automatic mode is explicit and V1 run cannot select it', async () => {
  await assert.rejects(main(['run', '--mode', 'EXPERIMENTAL_LIVE_AUTO']), /AUTO_REQUIRES_EXPLICIT_COMMAND/);
  await assert.rejects(main(['run', '--config', 'config/daily-v2.json']), /AUTO_REQUIRES_EXPLICIT_COMMAND/);
});

test('Hermes receipt parser ignores CLI noise and returns the final receipt', () => {
  const receipt = parseHermesReceipt('Hermes started\n{"schema_version":"2.0","message_type":"X_PUBLICATION_RECEIPT","request_id":"r","action_id":"a","publisher_account":"nullquanty","idempotency_key":"i","action_hash":"' + 'a'.repeat(64) + '","request_hash":"' + 'b'.repeat(64) + '","status":"PUBLISHED","provider_id":"2001","permalink":"https://x.com/nullquanty/status/2001","observed_at":"2026-09-05T10:00:00.000Z"}\n');
  assert.equal(receipt.status, 'PUBLISHED');
  assert.equal(receipt.provider_id, '2001');
});

test('Hermes invocation is pinned to openai-codex Luna xhigh browser execution', () => {
  const args = buildHermesArgs('execute request', { timeoutMs: 180000 });
  assert.deepEqual(args.slice(0, 10), ['chat', '-Q', '--provider', 'openai-codex', '-m', 'gpt-5.6-luna', '--reasoning', 'xhigh', '--toolsets', 'browser']);
});

test('Hermes publisher validates the request and accepts a hash-bound Hermes receipt', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-hermes-publisher-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const action = draft();
  const policy = evaluatePublicationPolicy(action, autoConfig(root), { facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 0, priorActions: [] });
  const request = buildAutoPublicationRequest(action, policy, { grant_id: 'grant_hermes', publisher_account: 'nullquanty', expires_at: '2026-09-05T11:00:00.000Z', max_actions: 5 }, new Date('2026-09-05T10:00:00.000Z'), 'hermes-run');
  const requestPath = path.join(root, 'request.json');
  await writeFile(requestPath, JSON.stringify(request));
  const publisher = new HermesXPublisher({ runHermes: async () => JSON.stringify({ schema_version: '2.0', message_type: 'X_PUBLICATION_RECEIPT', request_id: request.request_id, action_id: action.action_id, publisher_account: 'nullquanty', idempotency_key: request.idempotency_key, action_hash: request.action_hash, request_hash: request.request_hash, status: 'PUBLISHED', provider_id: '2001', permalink: 'https://x.com/nullquanty/status/2001', observed_at: '2026-09-05T10:01:00.000Z' }) });
  const receipt = await publisher.publishRequest(requestPath);
  assert.equal(receipt.status, 'PUBLISHED');
});

test('automatic pipeline publishes policy-approved drafts without founder review', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-auto-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = autoConfig(root);
  const factBase = { fact_id: 'marx-agent-first-finance-platform', claim: 'Marx presents itself as an agent-first financial platform.', source_url: 'https://marx.finance/docs', prohibited_extrapolations: ['returns'] };
  await writeFile(path.join(root, 'facts.json'), JSON.stringify({ schema_version: '1.0', facts: [{ ...factBase, status: 'APPROVED', approved_by: 'ozgur', approved_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-10-01T00:00:00.000Z', claim_hash: sha256(factBase) }] }));
  config.facts_path = path.join(root, 'facts.json');
  const now = new Date('2026-09-05T10:00:00.000Z');
  const post = normalizePost({ id: '1001', username: 'builder', text: 'Building an AI trading agent', timestamp: '2026-09-05T09:00:00.000Z', url: 'https://x.com/builder/status/1001', likes: 8, retweets: 2, replies: 1 }, 'q', 'bucket', now.toISOString());
  const source = { preflight: async () => ({ status: 'passed', result_count: 1 }), search: async () => [post], profile: async () => undefined, timeline: async () => [], replies: async () => { throw new Error('localTools.getPage is not a function'); }, thread: async () => ({ raw: null, completeness: 'unknown', retrieved_at: now.toISOString() }), close: async () => {} };
  const publisher = { publishRequest: async () => ({ status: 'PUBLISHED', provider_id: '2001', permalink: 'https://x.com/nullquanty/status/2001' }), close: async () => {} };
  const result = await executeDaily({ config, mode: 'EXPERIMENTAL_LIVE_AUTO', source, publisher, maxActions: 1, runId: 'auto_publish_run', now, queryConfig: { language: 'en', buckets: { bucket: ['"AI trading agent"'] } }, modelRunner: async (stage) => stage === 'opportunity' ? [{ context_index: 0, opportunity_score: 0.9, confidence: 0.9, recommended_action_type: 'REPLY_DRAFT', reason: 'specific builder problem' }] : stage === 'generation' ? [{ context_index: 0, action_type: 'REPLY_DRAFT', body: 'For this trading agent, log failed fills first. Marx can make those assumptions inspectable.', strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'specific_context', fact_ids: ['marx-agent-first-finance-platform'] }] : [{ draft_index: 0, scores: { context_fit: 0.9, usefulness: 0.9, naturalness: 0.9, marx_relevance: 0.9, spam_risk: 0.01, repetition_risk: 0.01, unsupported_claim_risk: 0.01 }, decision: 'PUBLISHABLE', reasons: ['specific'] }] });
  assert.equal(result.status, 'AUTO_PUBLISHED');
  assert.equal(result.publication.published, 1);
  const bundle = JSON.parse(await readFile(path.join(root, 'auto_publish_run', 'founder-review.json'), 'utf8'));
  assert.equal(bundle.context_details[0].context_errors[0].error_code, 'RUNTIME_FAILURE');
  assert.equal((await new DailyStore(config.storage.database, config.storage.events).listPublicationRequests('auto_publish_run'))[0].status, 'PUBLISHED');
});

test('automatic pipeline continues after a bounded publication failure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-auto-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = autoConfig(root);
  const factBase = { fact_id: 'marx-agent-first-finance-platform', claim: 'Marx presents itself as an agent-first financial platform.', source_url: 'https://marx.finance/docs', prohibited_extrapolations: ['returns'] };
  await writeFile(path.join(root, 'facts.json'), JSON.stringify({ schema_version: '1.0', facts: [{ ...factBase, status: 'APPROVED', approved_by: 'ozgur', approved_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-10-01T00:00:00.000Z', claim_hash: sha256(factBase) }] }));
  config.facts_path = path.join(root, 'facts.json');
  const now = new Date('2026-09-05T10:00:00.000Z');
  const post = normalizePost({ id: '1001', username: 'builder', text: 'Building an AI trading agent', timestamp: '2026-09-05T09:00:00.000Z', url: 'https://x.com/builder/status/1001', likes: 8, retweets: 2, replies: 1 }, 'q', 'bucket', now.toISOString());
  const source = { preflight: async () => ({ status: 'passed', result_count: 1 }), search: async () => [post], profile: async () => undefined, timeline: async () => [], replies: async () => [], thread: async () => ({ raw: null, completeness: 'unknown', retrieved_at: now.toISOString() }), close: async () => {} };
  let calls = 0;
  const publisher = { publishRequest: async () => (++calls === 1 ? { status: 'PUBLISHED', provider_id: '2001', permalink: 'https://x.com/nullquanty/status/2001' } : { status: 'FAILED', error_code: 'PUBLISH_PROVIDER_REJECTED', error_message: 'provider rejected' }), close: async () => {} };
  const bodies = ['For this trading agent, log failed fills first. Marx can make those assumptions inspectable.', 'For this trading agent, preserve rejected orders. Marx can make the discussion auditable.'];
  const result = await executeDaily({ config, mode: 'EXPERIMENTAL_LIVE_AUTO', source, publisher, maxActions: 2, runId: 'auto_partial_run', now, queryConfig: { language: 'en', buckets: { bucket: ['"AI trading agent"'] } }, modelRunner: async (stage) => stage === 'opportunity' ? [{ context_index: 0, opportunity_score: 0.9, confidence: 0.9, recommended_action_type: 'REPLY_DRAFT', reason: 'specific builder problem' }] : stage === 'generation' ? bodies.map(body => ({ context_index: 0, action_type: 'REPLY_DRAFT', body, strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'specific_context', fact_ids: ['marx-agent-first-finance-platform'] })) : bodies.map((_, draft_index) => ({ draft_index, scores: { context_fit: 0.9, usefulness: 0.9, naturalness: 0.9, marx_relevance: 0.9, spam_risk: 0.01, repetition_risk: 0.01, unsupported_claim_risk: 0.01 }, decision: 'PUBLISHABLE', reasons: ['specific'] })) });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.publication.attempted, 2);
  assert.equal(result.publication.published, 1);
  assert.equal(result.publication.failed, 1);
});

test('automatic pipeline regenerates evaluator-rejected drafts once before publishing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-auto-regenerate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = autoConfig(root);
  const factBase = { fact_id: 'marx-agent-first-finance-platform', claim: 'Marx presents itself as an agent-first financial platform.', source_url: 'https://marx.finance/docs', prohibited_extrapolations: ['returns'] };
  await writeFile(path.join(root, 'facts.json'), JSON.stringify({ schema_version: '1.0', facts: [{ ...factBase, status: 'APPROVED', approved_by: 'ozgur', approved_at: '2026-09-01T00:00:00.000Z', expires_at: '2026-10-01T00:00:00.000Z', claim_hash: sha256(factBase) }] }));
  config.facts_path = path.join(root, 'facts.json');
  const now = new Date('2026-09-05T10:00:00.000Z');
  const post = normalizePost({ id: '1001', username: 'builder', text: 'Building an AI trading agent', timestamp: '2026-09-05T09:00:00.000Z', url: 'https://x.com/builder/status/1001', likes: 8, retweets: 2, replies: 1 }, 'q', 'bucket', now.toISOString());
  const source = { preflight: async () => ({ status: 'passed', result_count: 1 }), search: async () => [post], profile: async () => undefined, timeline: async () => [], replies: async () => [], thread: async () => ({ raw: null, completeness: 'unknown', retrieved_at: now.toISOString() }), close: async () => {} };
  const good = 'For this trading agent, log failed fills before changing features. Marx can make the assumptions inspectable.';
  const rejected = 'This repeats a promotional bridge for the trading agent. Marx is useful.';
  const repaired = 'For this trading agent, preserve rejected fills in the event log. Marx can make the assumptions inspectable.';
  let evaluationCalls = 0;
  const publisher = { publishRequest: async () => ({ status: 'PUBLISHED', provider_id: '2001', permalink: 'https://x.com/nullquanty/status/2001' }), close: async () => {} };
  const result = await executeDaily({ config, mode: 'EXPERIMENTAL_LIVE_AUTO', source, publisher, maxActions: 2, runId: 'auto_regenerate_run', now, queryConfig: { language: 'en', buckets: { bucket: ['"AI trading agent"'] } }, modelRunner: async (stage, input) => stage === 'opportunity' ? [{ context_index: 0, opportunity_score: 0.9, confidence: 0.9, recommended_action_type: 'REPLY_DRAFT', reason: 'specific builder problem' }] : stage === 'generation' ? (evaluationCalls === 0 ? [{ context_index: 0, action_type: 'REPLY_DRAFT', body: good, strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'specific_context', fact_ids: ['marx-agent-first-finance-platform'] }, { context_index: 0, action_type: 'REPLY_DRAFT', body: rejected, strategy_family: 'VALIDATION_AND_FAILURE_MODES', hook_family: 'repeated_bridge', fact_ids: ['marx-agent-first-finance-platform'] }] : [{ context_index: 0, action_type: 'REPLY_DRAFT', body: repaired, strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'repaired_context', fact_ids: ['marx-agent-first-finance-platform'] }]) : (++evaluationCalls === 1 ? [{ draft_index: 0, scores: { context_fit: 0.9, usefulness: 0.9, naturalness: 0.9, marx_relevance: 0.9, spam_risk: 0.01, repetition_risk: 0.01, unsupported_claim_risk: 0.01 }, decision: 'PUBLISHABLE', reasons: ['good'] }, { draft_index: 1, scores: { context_fit: 0.9, usefulness: 0.8, naturalness: 0.8, marx_relevance: 0.9, spam_risk: 0.3, repetition_risk: 0.8, unsupported_claim_risk: 0.2 }, decision: 'REGENERATE', reasons: ['repetition and promotional risk'] }] : [{ draft_index: 0, scores: { context_fit: 0.9, usefulness: 0.9, naturalness: 0.9, marx_relevance: 0.9, spam_risk: 0.01, repetition_risk: 0.01, unsupported_claim_risk: 0.01 }, decision: 'PUBLISHABLE', reasons: ['repaired'] }] ) });
  assert.equal(result.status, 'AUTO_PUBLISHED');
  assert.equal(result.publication.published, 2);
  assert.equal(result.model_calls, 5);
});

test('publication receipt replay is idempotent and conflicting receipt is rejected', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-receipt-replay-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new DailyStore(path.join(root, 'test.sqlite'), path.join(root, 'events.jsonl'));
  const action = draft();
  const policy = evaluatePublicationPolicy(action, autoConfig(root), { facts: [{ fact_id: 'marx-agent-first-finance-platform', status: 'APPROVED', expires_at: '2026-10-05T10:00:00.000Z' }], attempted: 0, priorActions: [] });
  const request = buildAutoPublicationRequest(action, policy, { grant_id: 'grant_auto', publisher_account: 'nullquanty', expires_at: '2026-09-05T11:00:00.000Z', max_actions: 5 }, new Date('2026-09-05T10:00:00.000Z'), 'receipt-run');
  await store.createPublicationRequest(request);
  const receipt = { schema_version: '2.0', message_type: 'X_PUBLICATION_RECEIPT', request_id: request.request_id, action_id: action.action_id, publisher_account: 'nullquanty', idempotency_key: request.idempotency_key, action_hash: request.action_hash, request_hash: request.request_hash, status: 'PUBLISHED', provider_id: '2001', permalink: 'https://x.com/nullquanty/status/2001', observed_at: '2026-09-05T10:01:00.000Z' };
  await store.savePublicationReceipt(receipt);
  assert.deepEqual(await store.savePublicationReceipt(receipt), receipt);
  assert.rejects(store.savePublicationReceipt({ ...receipt, provider_id: '2002', permalink: 'https://x.com/nullquanty/status/2002' }), /PUBLICATION_RECEIPT_CONFLICT/);
});

test('run lock automatically reclaims a stale dead-owner lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-stale-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.daily-run.lock'));
  await writeFile(path.join(root, '.daily-run.lock', 'owner.json'), JSON.stringify({ pid: 999999, token: 'stale', acquired_at: '2026-09-05T00:00:00.000Z' }));
  let entered = false;
  await withRunLock(root, async () => { entered = true; });
  assert.equal(entered, true);
});

test('automatic control preflight retries a transient empty result', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'xge-v2-control-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = autoConfig(root);
  let calls = 0;
  const source = { preflight: async () => (++calls === 1 ? { status: 'empty', result_count: 0 } : { status: 'passed', result_count: 1 }), search: async () => [], close: async () => {} };
  const result = await executeDaily({ config, mode: 'EXPERIMENTAL_LIVE_AUTO', source, dryRun: true, maxActions: 0, runId: 'control_retry_run', now: new Date('2026-09-05T10:00:00.000Z'), queryConfig: { language: 'en', buckets: { bucket: ['"AI trading agent"'] } } });
  assert.equal(result.status, 'DISCOVERY_COMPLETE');
  assert.equal(calls, 2);
});

test('model context compaction bounds repeated timeline, replies, and thread payloads', () => {
  const context = { post: { provider_id: '1', text: 'post' }, account: { bio: 'bio' }, timeline: Array.from({ length: 20 }, (_, index) => ({ text: `timeline-${index}-${'x'.repeat(1000)}` })), replies: Array.from({ length: 20 }, (_, index) => ({ text: `reply-${index}-${'y'.repeat(1000)}` })), thread: { raw: 'z'.repeat(32000), completeness: 'sampled' }, context_errors: [], completeness: 'sampled', source_mode: 'EXPERIMENTAL_LIVE_AUTO' };
  const compact = compactContext(context);
  assert.equal(compact.timeline.length, 5);
  assert.equal(compact.replies.length, 5);
  assert.ok(compact.thread.raw.length <= 8000);
  assert.ok(JSON.stringify(compact).length < 30000);
  const evaluation = compactEvaluationContext(context);
  assert.equal(evaluation.timeline.length, 1);
  assert.equal(evaluation.replies.length, 2);
  assert.ok(evaluation.thread.raw.length <= 2000);
  assert.ok(JSON.stringify(evaluation).length < 8000);
});
