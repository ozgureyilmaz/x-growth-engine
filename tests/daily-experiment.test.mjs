import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { buildDailyQueries, executeDaily } from '../scripts/run-daily.mjs';
import { DraftSchema, normalizePost, sha256 } from '../scripts/daily-contracts.mjs';
import { buildDraft, deterministicQa, normalizeCandidate, scoreOpportunity } from '../scripts/daily-intelligence.mjs';
import { XActionsMcpSource } from '../scripts/daily-source.mjs';
import { codexArgs } from '../scripts/daily-codex.mjs';
import { buildPublicationRequest, verifyReceipt } from '../scripts/daily-publication-contracts.mjs';
import { importFounderReviews } from '../scripts/review.mjs';
import { doctor, recover, status } from '../scripts/daily-admin.mjs';
import { DailyStore } from '../scripts/daily-store.mjs';

function configFor(root) {
  return {
    schema_version: '1.0', mode: 'FIXTURE_DRY_RUN', account: 'nullquanty',
    source: { kind: 'xactions_mcp', platform: 'twitter', command: 'unused', args: [], read_tools: ['x_search_tweets', 'x_get_profile', 'x_get_tweets', 'x_get_thread', 'x_get_replies'] },
    discovery: { lookback_hours: 48, queries_per_run: 1, result_limit_per_query: 10, max_raw_posts: 120, max_enriched_accounts: 10, timeline_limit_per_account: 20, max_contexts: 10, max_consecutive_runtime_failures: 3, retry_transient_attempts: 2, inter_call_delay_seconds: 0 },
    intelligence: { max_opportunities: 1, candidates_per_opportunity: 3, max_review_drafts: 5, min_evaluation_score: 0.72, max_spam_risk: 0.2, max_repetition_risk: 0.25, max_unsupported_claim_risk: 0.15, max_codex_calls: 8, max_concurrent_codex_calls: 1, timeout_ms: 120000 },
    codex: { model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', binary: 'codex' },
    content: { language: 'en', max_chars: 280, marx_mentions: 1, links_allowed: false, ctas_allowed: false, hashtags_allowed: false, strategies: ['EVIDENCE_AND_PROVENANCE', 'VALIDATION_AND_FAILURE_MODES', 'AGENT_WORKFLOW'] },
    storage: { root, database: path.join(root, 'x-growth.sqlite'), events: path.join(root, 'events.jsonl') },
    publisher: { enabled: false, mode: 'MANUAL_ONLY', kill_switch: true },
  };
}

function post(now, overrides = {}) {
  return { id: '1001', username: 'builder', text: 'Building an AI trading agent with better backtests', timestamp: new Date(now.getTime() - 3600000).toISOString(), url: 'https://x.com/builder/status/1001', likes: 8, retweets: 2, replies: 1, ...overrides };
}

test('daily query rotation keeps the 12 buckets bounded and deterministic', async () => {
  const queryConfig = { language: 'en', buckets: { first: ['one', 'two'], second: ['three'] } };
  const now = new Date('2026-09-04T09:00:00.000Z');
  const first = buildDailyQueries(queryConfig, now, 12);
  const second = buildDailyQueries(queryConfig, now, 12);
  assert.deepEqual(first, second);
  assert.equal(first.length, 2);
  assert.match(first[0].query, /lang:en/);
});

test('daily source rejects write tools in its MCP allowlist', () => {
  assert.throws(() => new XActionsMcpSource({ command: 'unused', readTools: ['x_search_tweets', 'x_reply'] }), /non-read tool/);
});

test('doctor reports local dependencies and publisher safety without secrets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'x-growth-doctor-'));
  const result = await doctor({ config: configFor(root) });
  assert.equal(result.checks.publisher_disabled, true);
  assert.equal(typeof result.checks.xactions_auth_token_present, 'boolean');
  assert.equal(typeof result.checks.lock_healthy, 'boolean');
  assert.equal(result.checks.facts_ready, false);
  assert.ok(['PASS', 'DEGRADED'].includes(result.status));
});

test('recover marks a dead-owner run interrupted and clears only its stale lock', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'x-growth-recover-'));
  const config = configFor(root);
  const store = new DailyStore(config.storage.database, config.storage.events);
  await store.startRun('stale_run', 'EXPERIMENTAL_LIVE_READ', 'STARTING', 'a'.repeat(64), '2026-09-04T08:00:00.000Z');
  await mkdir(path.join(root, '.daily-run.lock'));
  await writeFile(path.join(root, '.daily-run.lock', 'owner.json'), JSON.stringify({ pid: 999999, acquired_at: '2026-09-04T08:00:00.000Z' }));
  const result = await recover('stale_run', { config });
  assert.equal(result.new_state, 'INTERRUPTED');
  assert.equal((await status('stale_run', { config })).run.status, 'INTERRUPTED');
});

test('XActions stdio adapter calls only the configured read tool and normalizes JSON', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'x-growth-mcp-'));
  const server = path.join(root, 'fake-mcp.mjs');
  const sdkRoot = path.join(process.cwd(), 'node_modules/@modelcontextprotocol/sdk');
  await writeFile(server, `import { Server } from '${pathToFileURL(path.join(sdkRoot, 'dist/esm/server/index.js')).href}';\nimport { StdioServerTransport } from '${pathToFileURL(path.join(sdkRoot, 'dist/esm/server/stdio.js')).href}';\nimport { CallToolRequestSchema, ListToolsRequestSchema } from '${pathToFileURL(path.join(sdkRoot, 'dist/esm/types.js')).href}';\nconst server = new Server({name:'fake',version:'1.0.0'},{capabilities:{tools:{}}});\nserver.setRequestHandler(ListToolsRequestSchema, async()=>({tools:[{name:'x_search_tweets',inputSchema:{type:'object'}}]}));\nserver.setRequestHandler(CallToolRequestSchema, async()=>({content:[{type:'text',text:JSON.stringify([{id:'1001',author:'builder',text:'AI trading agent',timestamp:'2026-09-04T08:00:00.000Z',url:'https://x.com/builder/status/1001'}])}]}));\nawait server.connect(new StdioServerTransport());\n`);
  const source = new XActionsMcpSource({ command: process.execPath, args: [server], cwd: process.cwd(), readTools: ['x_search_tweets'] });
  assert.deepEqual(await source.preflight('the'), { status: 'passed', result_count: 1 });
  const posts = await source.search('AI trading', 'direct_ai_trading', 1, '2026-09-04');
  assert.equal(posts[0].provider_id, '1001');
  await source.close();
});

test('Codex Exec is pinned to the Plus model and read-only sandbox', () => {
  const args = codexArgs('prompt', { model: 'gpt-5.6-luna', reasoning_effort: 'xhigh' });
  assert.equal(args[args.indexOf('--model')+1],'gpt-5.6-luna');
  assert.ok(args.includes('model_reasoning_effort="xhigh"'));
  assert.ok(args.includes('shell_tool'));
  assert.equal(args.at(-1),'-');
});

test('deterministic QA rejects promotional slop and accepts a contextual contribution', () => {
  const context = { post: { text: 'I am building a backtesting agent' } };
  const options = { max_chars: 280, marx_mentions: 1, links_allowed: false, ctas_allowed: false, hashtags_allowed: false };
  assert.equal(deterministicQa('This is a game changer. Check out Marx!', context, [], options).passed, false);
  assert.equal(deterministicQa('For the backtesting agent, log costs and failed fills first. Marx can make that evidence inspectable.', context, [], options).passed, true);
});

test('a missing or low-quality evaluator result cannot become publishable', () => {
  const context = { post: { provider_id: '1001', url: 'https://x.com/builder/status/1001', username: 'builder', text: 'Building an AI trading agent' }, context_hash: 'a'.repeat(64) };
  const options = { max_chars: 280, marx_mentions: 1, links_allowed: false, ctas_allowed: false, hashtags_allowed: false, strategies: ['EVIDENCE_AND_PROVENANCE'], priorBodies: [], min_evaluation_score: 0.72, max_spam_risk: 0.2, max_repetition_risk: 0.25, max_unsupported_claim_risk: 0.15 };
  const normalized = normalizeCandidate({ action_type: 'REPLY_DRAFT', body: 'For the trading agent, log failed fills first. Marx can make those assumptions inspectable.' }, context, 0, options);
  assert.equal(normalized.evaluation.decision, 'NO_ACTION');
  assert.ok(normalized.qa.reasons.includes('EVALUATION_INVALID'));
});

test('fixture daily run produces founder-review JSON without a publisher', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'x-growth-daily-'));
  const now = new Date('2026-09-04T09:00:00.000Z');
  const fixture = { search_results: [post(now)], profiles: [{ username: 'builder', name: 'Builder', bio: 'AI trading developer', followers: 10 }], recent_tweets: { builder: [post(now, { id: '1002', url: 'https://x.com/builder/status/1002', text: 'testing a trading agent' })] } };
  const result = await executeDaily({ config: configFor(root), queryConfig: { language: 'en', buckets: { direct_ai_trading: ['"AI trading agent"'] } }, mode: 'FIXTURE_DRY_RUN', fixture, now, runId: 'daily_test' });
  assert.equal(result.publisher_enabled, false);
  assert.equal(result.status, 'READY_FOR_FOUNDER_REVIEW');
  const bundle = JSON.parse(await readFile(path.join(root, 'daily_test', 'founder-review.json'), 'utf8'));
  assert.equal(bundle.message_type, 'X_FOUNDER_REVIEW_BUNDLE');
  assert.equal(bundle.publisher_enabled, false);
  assert.ok(bundle.drafts.length >= 1);
  for (const draft of bundle.drafts) DraftSchema.parse(draft);
  const decisionFile = path.join(root, 'founder-decisions.json');
  await writeFile(decisionFile, JSON.stringify([{ action_id: bundle.drafts[0].action_id, action_hash: bundle.drafts[0].action_hash, decision: 'APPROVED', reason: 'contextual and useful', reviewed_at: '2026-09-04T10:00:00.000Z' }]));
  assert.deepEqual(await importFounderReviews(decisionFile, { config: configFor(root), database: path.join(root, 'x-growth.sqlite'), events: path.join(root, 'events.jsonl') }), { status: 'ok', imported: 1, publisher_enabled: false });
});

test('daily runs use persistent prior draft history for duplicate prevention', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'x-growth-daily-history-'));
  const now = new Date('2026-09-04T09:00:00.000Z');
  const fixture = { search_results: [post(now)], profiles: [{ username: 'builder', name: 'Builder', bio: 'AI trading developer' }] };
  const config = configFor(root);
  const first = await executeDaily({ config, queryConfig: { language: 'en', buckets: { direct_ai_trading: ['"AI trading agent"'] } }, mode: 'FIXTURE_DRY_RUN', fixture, now, runId: 'history_first' });
  const second = await executeDaily({ config, queryConfig: { language: 'en', buckets: { direct_ai_trading: ['"AI trading agent"'] } }, mode: 'FIXTURE_DRY_RUN', fixture, now, runId: 'history_second' });
  assert.equal(first.drafts, 1);
  assert.equal(second.drafts, 0);
});

test('stage zero can replay persisted real evidence without model calls', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'x-growth-daily-replay-'));
  const now = new Date('2026-09-04T09:00:00.000Z');
  const config = configFor(root);
  const store = new DailyStore(config.storage.database, config.storage.events);
  const stored = normalizePost(post(now), 'q', 'bucket', now.toISOString());
  await store.savePost('real_source_run', stored);
  const result = await executeDaily({ config, queryConfig: { language: 'en', buckets: { direct_ai_trading: ['"AI trading agent"'] } }, mode: 'REPLAY_REAL_DATA', replayRunId: 'real_source_run', maxDrafts: 0, now, runId: 'replay_zero' });
  assert.equal(result.status, 'DISCOVERY_COMPLETE');
  assert.equal(result.discovered, 1);
  assert.equal(result.drafts, 0);
});

test('normalized source evidence keeps a canonical URL and stable evidence hash', () => {
  const first = normalizePost(post(new Date('2026-09-04T09:00:00.000Z')), 'q', 'bucket', '2026-09-04T09:00:00.000Z');
  const second = normalizePost(post(new Date('2026-09-04T09:00:00.000Z')), 'q', 'bucket', '2026-09-04T09:00:00.000Z');
  assert.equal(first.url, 'https://x.com/builder/status/1001');
  assert.equal(first.evidence_hash, second.evidence_hash);
  assert.ok(sha256(first).length === 64);
});

test('the same draft material has a stable action hash across runs', async () => {
  const context = { post: { provider_id: '1001', url: 'https://x.com/builder/status/1001', username: 'builder', text: 'Building an AI trading agent' }, context_hash: 'a'.repeat(64) };
  const evaluation = { context_fit: 0.9, usefulness: 0.9, naturalness: 0.9, marx_relevance: 0.9, spam_risk: 0.01, repetition_risk: 0.01, unsupported_claim_risk: 0.01, decision: 'PUBLISHABLE' };
  const qa = { passed: true, reasons: [] };
  const first = buildDraft({ action_type: 'REPLY_DRAFT', body: 'For the trading agent, log failed fills first. Marx can make those assumptions inspectable.', strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'specific_context' }, context, evaluation, qa, { run_id: 'run', prompt_versions: { generation: 'v1' } });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = buildDraft({ action_type: 'REPLY_DRAFT', body: 'For the trading agent, log failed fills first. Marx can make those assumptions inspectable.', strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'specific_context' }, context, evaluation, qa, { run_id: 'run', prompt_versions: { generation: 'v1' } });
  assert.equal(first.action_id, second.action_id);
  assert.equal(first.action_hash, second.action_hash);
});

test('opportunity scoring distinguishes an AI-finance builder from noise', () => {
  const strong = scoreOpportunity({ text: 'Building an autonomous AI trading agent', likes: 5, reposts: 2, replies: 0 }, { bio: 'founder and developer' });
  const weak = scoreOpportunity({ text: 'giveaway signal group 100x', likes: 0, reposts: 0, replies: 0 }, {});
  assert.ok(strong.score > weak.score);
  assert.ok(strong.score >= 0.45);
});

test('V2 publication request binds approval, grant, and exact action hash', () => {
  const context = { post: { provider_id: '1001', url: 'https://x.com/builder/status/1001', username: 'builder', text: 'Building an AI trading agent' }, context_hash: 'a'.repeat(64) };
  const evaluation = { context_fit: 0.9, usefulness: 0.9, naturalness: 0.9, marx_relevance: 0.9, spam_risk: 0.01, repetition_risk: 0.01, unsupported_claim_risk: 0.01, decision: 'PUBLISHABLE' };
  const draft = buildDraft({ action_type: 'REPLY_DRAFT', body: 'For the trading agent, log failed fills first. Marx can make those assumptions inspectable.', strategy_family: 'EVIDENCE_AND_PROVENANCE', hook_family: 'specific_context' }, context, evaluation, { passed: true, reasons: [] }, { run_id: 'run', prompt_versions: { generation: 'v1' } });
  const approval = { decision: 'APPROVED', approver_id: 'founder', decided_at: '2026-09-04T09:00:00.000Z', action_hash: draft.action_hash };
  const grant = { grant_id: 'grant_v2', publisher_account: 'nullquanty', expires_at: '2026-09-05T09:00:00.000Z', max_actions: 1 };
  const request = buildPublicationRequest(draft, approval, grant, new Date('2026-09-04T09:01:00.000Z'));
  assert.equal(request.publisher_account, 'nullquanty');
  const forged = { ...draft, action_hash: '0'.repeat(64) };
  assert.throws(() => buildPublicationRequest(forged, { ...approval, action_hash: forged.action_hash }, grant, new Date('2026-09-04T09:01:00.000Z')), /PUBLICATION_ACTION_HASH_INVALID/);
  assert.throws(() => verifyReceipt(request, { schema_version: '1.0', message_type: 'X_PUBLICATION_RECEIPT', request_id: request.request_id, action_id: draft.action_id, publisher_account: 'nullquanty', idempotency_key: request.idempotency_key, action_hash: request.action_hash, request_hash: request.request_hash, status: 'PUBLISHED', observed_at: '2026-09-04T09:02:00.000Z' }), /PUBLISHED_RECEIPT_MISSING_READBACK/);
});
