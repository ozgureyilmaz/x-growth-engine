import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CLI = path.join(ROOT, 'scripts/run-comprehensive.mjs');

function invoke(args, input = '') {
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8' });
}

function encoded(value) {
  return encodeURIComponent(JSON.stringify(value));
}

async function makeRun(overrides = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'xge-test-'));
  const runDir = path.join(base, 'run');
  await mkdir(runDir);
  const manifest = {
    schema_version: 2,
    run_id: 'test-run',
    run_started_at: '2026-09-01T00:00:00.000Z',
    run_finished_at: null,
    lookback_since: '2026-06-03',
    source: 'test public source',
    platform: 'twitter',
    limits: {
      max_search_calls: 1,
      result_limit_per_query: 10,
      max_raw_tweets: 20,
      max_unique_authors: 10,
      max_enriched_authors: 10,
      recent_tweets_per_author: 20,
      retry_transient_attempts: 2,
      max_consecutive_runtime_failures: 3,
      review_score: 50,
    },
    control_check: { query: 'the', status: 'passed', result_count: 1 },
    queries: [{ index: 0, bucket: 'test', query: 'test query', status: 'pending', attempts: 0, raw_result_count: 0 }],
    authors: [],
    counts: {
      raw_tweets_returned: 0,
      raw_tweets_stored: 0,
      unique_authors: 0,
      profiles_stored: 0,
      recent_tweets_stored: 0,
      search_calls_completed: 0,
      enrichments_completed: 0,
      rejected_records: 0,
      consecutive_runtime_failures: 0,
    },
    stop: { status: 'not_stopped', reason: null, at: null },
    actions_performed: [],
    ...overrides,
  };
  await writeFile(path.join(runDir, 'run-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const name of ['search-results.jsonl', 'profiles.jsonl', 'recent-tweets.jsonl']) {
    await writeFile(path.join(runDir, name), '');
  }
  return { base, runDir };
}

function tweet(overrides = {}) {
  return {
    id: '1234567890',
    username: 'alice',
    text: 'Building an AI trading agent',
    timestamp: '2026-09-02T12:00:00.000Z',
    url: 'https://x.com/alice/status/1234567890',
    ...overrides,
  };
}

async function manifest(runDir) {
  return JSON.parse(await readFile(path.join(runDir, 'run-manifest.json'), 'utf8'));
}

async function lineCount(file) {
  return (await readFile(file, 'utf8')).split('\n').filter(Boolean).length;
}

async function fakeScorer(base) {
  const scorer = path.join(base, 'fake-scorer.mjs');
  await writeFile(scorer, `import { writeFileSync } from 'node:fs';\nconst at=process.argv.indexOf('--output');\nwriteFileSync(process.argv[at+1], 'username,name,bio,category,score,matching_tweet,tweet_url,followers,website,reason,last_tweet_at\\n');\nconsole.log(JSON.stringify({status:'ok',rows_written:0}));\n`);
  return scorer;
}

test('search ingest is blocked until the control query passes', async () => {
  const { runDir } = await makeRun({ control_check: { query: 'the', status: 'pending', result_count: 0 } });
  const result = invoke(['--ingest-batch-encoded', encoded({ type: 'search', query_index: 0, result: [tweet()] }), '--run-dir', runDir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /control_check_not_passed/);
  assert.equal(await lineCount(path.join(runDir, 'search-results.jsonl')), 0);
});

test('replaying a completed search batch does not inflate completion counts', async () => {
  const { runDir } = await makeRun();
  const args = ['--ingest-batch-encoded', encoded({ type: 'search', query_index: 0, attempt: 1, result: [tweet()] }), '--run-dir', runDir];
  assert.equal(invoke(args).status, 0);
  assert.equal(invoke(args).status, 0);
  const state = await manifest(runDir);
  assert.equal(await lineCount(path.join(runDir, 'search-results.jsonl')), 1);
  assert.equal(state.counts.search_calls_completed, 1);
  assert.equal(state.counts.raw_tweets_returned, 1);
});

test('replaying enrichment does not duplicate timeline records or counters', async () => {
  const { runDir } = await makeRun({
    queries: [{ index: 0, bucket: 'test', query: 'test query', status: 'completed', attempts: 1, raw_result_count: 1 }],
  });
  await writeFile(path.join(runDir, 'search-results.jsonl'), `${JSON.stringify(tweet())}\n`);
  const batch = { type: 'enrichment', author_index: 0, attempt: 1, username: 'alice', profile: { username: 'alice', name: 'Alice' }, tweets: [tweet()] };
  const args = ['--ingest-batch-encoded', encoded(batch), '--run-dir', runDir];
  assert.equal(invoke(args).status, 0);
  assert.equal(invoke(args).status, 0);
  const state = await manifest(runDir);
  assert.equal(await lineCount(path.join(runDir, 'profiles.jsonl')), 1);
  assert.equal(await lineCount(path.join(runDir, 'recent-tweets.jsonl')), 1);
  assert.equal(state.counts.enrichments_completed, 1);
});

test('enrichment must match the ranked search author at its index', async () => {
  const { runDir } = await makeRun({
    queries: [{ index: 0, bucket: 'test', query: 'test query', status: 'completed', attempts: 1, raw_result_count: 1 }],
  });
  await writeFile(path.join(runDir, 'search-results.jsonl'), `${JSON.stringify(tweet())}\n`);
  const batch = { type: 'enrichment', author_index: 0, username: 'bob', profile: { username: 'bob' }, tweets: [] };
  const result = invoke(['--ingest-batch-encoded', encoded(batch), '--run-dir', runDir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /enrichment_author_mismatch/);
});

test('malformed provider records are rejected instead of crashing ingest', async () => {
  const { runDir } = await makeRun();
  const batch = { type: 'search', query_index: 0, result: [null, 'not-an-object'] };
  const result = invoke(['--ingest-batch-encoded', encoded(batch), '--run-dir', runDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await manifest(runDir)).counts.rejected_records, 2);
});

test('invalid and out-of-window evidence is rejected at ingest', async () => {
  const { runDir } = await makeRun();
  const batch = {
    type: 'search', query_index: 0, result: [
      tweet({ id: '1', url: 'https://example.com/alice/status/1' }),
      tweet({ id: '2', url: 'https://x.com/bob/status/2' }),
      tweet({ id: '3', url: 'https://x.com/alice/status/3', timestamp: '2026-01-01T00:00:00.000Z' }),
    ],
  };
  assert.equal(invoke(['--ingest-batch-encoded', encoded(batch), '--run-dir', runDir]).status, 0);
  const state = await manifest(runDir);
  assert.equal(await lineCount(path.join(runDir, 'search-results.jsonl')), 0);
  assert.equal(state.counts.rejected_records, 3);
});

test('an incomplete non-stopped run cannot be finalized', async () => {
  const { runDir, base } = await makeRun();
  const scorer = await fakeScorer(base);
  const result = invoke(['--finalize', '--run-dir', runDir, '--scorer', scorer]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /incomplete_search_plan/);
});

test('a complete run finalizes with a configurable scorer', async () => {
  const { runDir, base } = await makeRun({
    queries: [{ index: 0, bucket: 'test', query: 'test query', status: 'empty', attempts: 1, raw_result_count: 0 }],
    counts: { raw_tweets_returned: 0, raw_tweets_stored: 0, unique_authors: 0, profiles_stored: 0, recent_tweets_stored: 0, search_calls_completed: 1, enrichments_completed: 0, rejected_records: 0, consecutive_runtime_failures: 0 },
  });
  const scorer = await fakeScorer(base);
  const result = invoke(['--finalize', '--run-dir', runDir, '--scorer', scorer]);
  assert.equal(result.status, 0, result.stderr);
  const exported = JSON.parse(await readFile(path.join(runDir, 'mcp-comprehensive-x-export.json'), 'utf8'));
  assert.equal(exported.run_status, 'NO_ACTION');
  assert.match(await readFile(path.join(runDir, 'run-report.md'), 'utf8'), /Rejected evidence records \| 0/);
});

test('a held run lock prevents a concurrent mutation', async () => {
  const { runDir } = await makeRun();
  await mkdir(path.join(runDir, '.run.lock'));
  const result = invoke(['--ingest-batch-encoded', encoded({ type: 'control', query: 'the', result: [{}] }), '--run-dir', runDir]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /run_locked/);
});

test('transient retry limits come from the frozen run policy', async () => {
  const { runDir } = await makeRun({
    limits: { max_search_calls: 1, result_limit_per_query: 10, max_raw_tweets: 20, max_unique_authors: 10, max_enriched_authors: 10, recent_tweets_per_author: 20, retry_transient_attempts: 1, max_consecutive_runtime_failures: 5, review_score: 50 },
  });
  const first = { type: 'error', scope: 'search', index: 0, attempt: 1, message: 'temporary upstream failure' };
  const second = { ...first, attempt: 2 };
  assert.equal(invoke(['--ingest-batch-encoded', encoded(first), '--run-dir', runDir]).status, 0);
  assert.equal((await manifest(runDir)).stop.status, 'not_stopped');
  assert.equal(invoke(['--ingest-batch-encoded', encoded(second), '--run-dir', runDir]).status, 0);
  assert.equal((await manifest(runDir)).stop.status, 'stopped');
});

test('the raw tweet cap is enforced within a single batch', async () => {
  const { runDir } = await makeRun({
    limits: { max_search_calls: 1, result_limit_per_query: 10, max_raw_tweets: 1, max_unique_authors: 10, max_enriched_authors: 10, recent_tweets_per_author: 20, retry_transient_attempts: 2, max_consecutive_runtime_failures: 3, review_score: 50 },
  });
  const batch = { type: 'search', query_index: 0, result: [tweet(), tweet({ id: '2', url: 'https://x.com/bob/status/2', username: 'bob' })] };
  assert.equal(invoke(['--ingest-batch-encoded', encoded(batch), '--run-dir', runDir]).status, 0);
  assert.equal(await lineCount(path.join(runDir, 'search-results.jsonl')), 1);
  assert.equal((await manifest(runDir)).stop.reason, 'raw_tweet_cap_reached');
});

test('a non-empty action ledger blocks finalization', async () => {
  const { runDir, base } = await makeRun({
    queries: [{ index: 0, bucket: 'test', query: 'test query', status: 'empty', attempts: 1, raw_result_count: 0 }],
    counts: { raw_tweets_returned: 0, raw_tweets_stored: 0, unique_authors: 0, profiles_stored: 0, recent_tweets_stored: 0, search_calls_completed: 1, enrichments_completed: 0, rejected_records: 0, consecutive_runtime_failures: 0 },
    actions_performed: [{ type: 'like' }],
  });
  const scorer = await fakeScorer(base);
  const result = invoke(['--finalize', '--run-dir', runDir, '--scorer', scorer]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /non_empty_action_ledger/);
});

test('a scorer that emits no CSV cannot leave final artifacts behind', async () => {
  const { runDir, base } = await makeRun({
    queries: [{ index: 0, bucket: 'test', query: 'test query', status: 'empty', attempts: 1, raw_result_count: 0 }],
    counts: { raw_tweets_returned: 0, raw_tweets_stored: 0, unique_authors: 0, profiles_stored: 0, recent_tweets_stored: 0, search_calls_completed: 1, enrichments_completed: 0, rejected_records: 0, consecutive_runtime_failures: 0 },
  });
  const scorer = path.join(base, 'silent-scorer.mjs');
  await writeFile(scorer, `console.log(JSON.stringify({status:'ok',rows_written:0}));\n`);
  const result = invoke(['--finalize', '--run-dir', runDir, '--scorer', scorer]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /scorer_output_missing/);
  await assert.rejects(readFile(path.join(runDir, 'mcp-comprehensive-x-export.json')));
  assert.equal((await manifest(runDir)).run_finished_at, null);
});
