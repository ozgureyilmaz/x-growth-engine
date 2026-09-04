#!/usr/bin/env node
/**
 * Resumable run controller for public XActions MCP data.
 *
 * MCP calls are intentionally made by the Codex app with the public-read
 * x_search_tweets, x_get_profile, and x_get_tweets tools. This file provides
 * the local run contract: init, atomic checkpoints, append-only JSONL ingest,
 * final export, deterministic SVG, and a report. It never logs credentials and
 * never calls a write/action endpoint.
 *
 * NDJSON input formats for --ingest:
 *   {"type":"control","query":"...","result":[...]}
 *   {"type":"search","query_index":0,"attempt":1,"result":[...]}
 *   {"type":"enrichment","author_index":0,"username":"...","profile":{},"tweets":[]}
 *   {"type":"error","scope":"search|enrichment","index":0,"attempt":1,"message":"..."}
 */
import { access, appendFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const POLICY_PATH = path.join(ROOT, 'config/research-policy.json');
const QUERIES_PATH = path.join(ROOT, 'config/query-buckets.json');
const RUNS_DIR = path.join(ROOT, 'outputs/runs');
const DEFAULT_SCORER = '/Users/0x79de/Documents/Codex/2026-09-02/bun/run_pipeline.py';
const TERMINAL_QUERY_STATUSES = new Set(['completed', 'completed_with_rejections', 'empty', 'failed', 'stopped']);
const CSV_HEADER = 'username,name,bio,category,score,matching_tweet,tweet_url,followers,website,reason,last_tweet_at';

const now = () => new Date().toISOString();
const text = (value) => String(value ?? '').trim();
const lower = (value) => text(value).toLowerCase();
const usernameOf = (value) => lower(typeof value === 'object' ? value.username ?? value.author ?? value.user : value).replace(/^@/, '');
const recordId = (record) => text(record.id) || text(record.url) || `${usernameOf(record)}|${text(record.timestamp)}|${text(record.text)}`;
const xml = (value) => text(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

async function loadJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

function sinceDate(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function buildQueries(policy, queryConfig, since) {
  const exclusion = queryConfig.exclusions ?? policy.query_exclusions ?? [];
  const suffix = `lang:${queryConfig.language ?? policy.language} since:${since} ${exclusion.join(' ')}`;
  const buckets = Object.entries(queryConfig.buckets).slice(0, policy.max_buckets);
  const seen = new Set();
  const queries = [];
  for (const [bucket, variants] of buckets) {
    for (const variant of variants.slice(0, policy.max_queries_per_bucket)) {
      const query = `${text(variant)} ${suffix}`.replace(/\s+/g, ' ').trim();
      const normalized = query.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      queries.push({ index: queries.length, bucket, variant, query, normalized, status: 'pending', attempts: 0, raw_result_count: 0 });
    }
  }
  if (queries.length > policy.max_search_calls) return queries.slice(0, policy.max_search_calls).map((q, index) => ({ ...q, index }));
  return queries;
}

function emptyCounts() {
  return { raw_tweets_returned: 0, raw_tweets_stored: 0, unique_authors: 0, profiles_stored: 0, recent_tweets_stored: 0, search_calls_completed: 0, enrichments_completed: 0, rejected_records: 0, consecutive_runtime_failures: 0 };
}

function positiveInteger(value, name, { allowZero = false } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < (allowZero ? 0 : 1)) throw new Error(`invalid_policy:${name}`);
  return number;
}

function validatePolicy(policy) {
  for (const name of ['lookback_days', 'max_buckets', 'max_queries_per_bucket', 'max_search_calls', 'result_limit_per_query', 'max_raw_tweets', 'max_unique_authors', 'max_enriched_authors', 'recent_tweets_per_author', 'max_consecutive_runtime_failures']) {
    positiveInteger(policy[name], name);
  }
  positiveInteger(policy.retry_transient_attempts, 'retry_transient_attempts', { allowZero: true });
  positiveInteger(policy.review_gate?.review_score, 'review_gate.review_score', { allowZero: true });
  positiveInteger(policy.review_gate?.high_intent_score, 'review_gate.high_intent_score', { allowZero: true });
}

async function initRun() {
  const [policy, queryConfig] = await Promise.all([loadJson(POLICY_PATH), loadJson(QUERIES_PATH)]);
  validatePolicy(policy);
  const started = now();
  const runId = started.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  let runDir = path.join(RUNS_DIR, runId);
  let suffix = 1;
  while (true) {
    try { await readFile(path.join(runDir, 'run-manifest.json')); runDir = path.join(RUNS_DIR, `${runId}-${suffix++}`); }
    catch { break; }
  }
  await mkdir(runDir, { recursive: true });
  const manifest = {
    schema_version: 2,
    run_id: path.basename(runDir),
    run_started_at: started,
    run_finished_at: null,
    lookback_since: sinceDate(policy.lookback_days),
    source: policy.source,
    platform: policy.platform,
    limits: {
      max_buckets: policy.max_buckets,
      max_queries_per_bucket: policy.max_queries_per_bucket,
      max_search_calls: policy.max_search_calls,
      result_limit_per_query: policy.result_limit_per_query,
      max_raw_tweets: policy.max_raw_tweets,
      max_unique_authors: policy.max_unique_authors,
      max_enriched_authors: policy.max_enriched_authors,
      recent_tweets_per_author: policy.recent_tweets_per_author,
      inter_call_delay_seconds: policy.inter_call_delay_seconds,
      retry_transient_attempts: policy.retry_transient_attempts,
      max_consecutive_runtime_failures: policy.max_consecutive_runtime_failures,
      review_score: policy.review_gate.review_score,
      high_intent_score: policy.review_gate.high_intent_score,
    },
    scorer_path: policy.scorer_path || null,
    control_check: { query: policy.control_query, status: 'pending', result_count: 0 },
    queries: buildQueries(policy, queryConfig, sinceDate(policy.lookback_days)),
    authors: [],
    last_completed_query_index: -1,
    last_completed_enrichment_index: -1,
    counts: emptyCounts(),
    stop: { status: 'not_stopped', reason: null, at: null },
    actions_performed: [],
  };
  for (const file of ['search-results.jsonl', 'profiles.jsonl', 'recent-tweets.jsonl']) await writeFile(path.join(runDir, file), '', 'utf8');
  await atomicJson(path.join(runDir, 'run-manifest.json'), manifest);
  console.log(JSON.stringify({ status: 'initialized', run_id: manifest.run_id, run_dir: runDir, queries: manifest.queries.length, lookback_since: manifest.lookback_since }));
}

async function readManifest(runDir) { return loadJson(path.join(runDir, 'run-manifest.json')); }
async function saveManifest(runDir, manifest) { await atomicJson(path.join(runDir, 'run-manifest.json'), manifest); }

async function readJsonl(file) {
  try {
    const body = await readFile(file, 'utf8');
    return body.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function withRunLock(runDir, operation) {
  const lockDir = path.join(runDir, '.run.lock');
  try {
    await mkdir(lockDir);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('run_locked');
    throw error;
  }
  try {
    await writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify({ pid: process.pid, acquired_at: now() })}\n`, 'utf8');
    return await operation();
  } finally {
    await rm(lockDir, { recursive: true, force: true });
  }
}

function assertMutable(manifest) {
  if (manifest.run_finished_at) throw new Error('run_already_finalized');
  if (!Array.isArray(manifest.actions_performed) || manifest.actions_performed.length !== 0) throw new Error('non_empty_action_ledger');
}

function assertControlPassed(manifest) {
  if (manifest.control_check?.status !== 'passed') throw new Error('control_check_not_passed');
}

function searchPlanComplete(manifest) {
  return manifest.queries.length > 0 && manifest.queries.every((query) => TERMINAL_QUERY_STATUSES.has(query.status));
}

function validTimestamp(value, lookbackSince) {
  const timestamp = Date.parse(value);
  const lowerBound = Date.parse(`${lookbackSince}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && Number.isFinite(lowerBound) && timestamp >= lowerBound && timestamp <= Date.now() + 300000;
}

function validTweetEvidence(tweet, manifest, expectedUsername = '') {
  if (!tweet.username || !tweet.text || !tweet.timestamp || !tweet.url) return false;
  if (!/^[a-z0-9_]{1,15}$/i.test(tweet.username)) return false;
  const match = tweet.url.match(/^https:\/\/(?:www\.)?x\.com\/([a-z0-9_]{1,15})\/status\/(\d+)(?:[/?#].*)?$/i);
  if (!match || lower(match[1]) !== tweet.username) return false;
  if (expectedUsername && tweet.username !== expectedUsername) return false;
  if (tweet.id && tweet.id !== match[2]) return false;
  return validTimestamp(tweet.timestamp, manifest.lookback_since);
}

async function reconcileStoredCounts(runDir, manifest) {
  const [search, profiles, recent] = await Promise.all([
    readJsonl(path.join(runDir, 'search-results.jsonl')),
    readJsonl(path.join(runDir, 'profiles.jsonl')),
    readJsonl(path.join(runDir, 'recent-tweets.jsonl')),
  ]);
  manifest.counts.raw_tweets_stored = search.length;
  manifest.counts.unique_authors = new Set(search.map(usernameOf).filter(Boolean)).size;
  manifest.counts.profiles_stored = new Set(profiles.map(usernameOf).filter(Boolean)).size;
  manifest.counts.recent_tweets_stored = recent.length;
  manifest.counts.search_calls_completed = manifest.queries.filter((query) => ['completed', 'completed_with_rejections', 'empty'].includes(query.status)).length;
  manifest.counts.enrichments_completed = new Set(manifest.authors.filter((author) => author.enrichment_status === 'completed').map((author) => author.username)).size;
}

function normalizeTweet(raw, context = {}) {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const username = usernameOf(raw.author ?? raw.username ?? raw.user);
  return {
    id: text(raw.id),
    text: text(raw.text ?? raw.fullText ?? raw.content),
    username,
    timestamp: text(raw.timeParsed ?? raw.timestamp ?? raw.created_at ?? raw.date),
    likes: raw.likes ?? raw.likeCount ?? 0,
    retweets: raw.retweets ?? raw.retweetCount ?? 0,
    replies: raw.replies ?? raw.replyCount ?? 0,
    url: text(raw.url ?? raw.permanentUrl ?? raw.tweet_url ?? raw.link),
    source_query: text(context.query ?? raw.source_query),
    bucket: text(context.bucket ?? raw.bucket),
    platform: 'twitter',
    source: 'xactions_mcp',
  };
}

function normalizeProfile(raw, fallbackUsername = '') {
  raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    username: usernameOf(raw.username ?? raw.author ?? raw.user ?? fallbackUsername),
    name: text(raw.name ?? raw.displayName),
    bio: text(raw.bio ?? raw.description),
    website: text(raw.website ?? raw.url),
    followers: raw.followers ?? raw.followersCount ?? '',
    following: raw.following ?? raw.followingCount ?? '',
    source: 'xactions_mcp',
  };
}

function errorClass(message) {
  const value = lower(message);
  if (/\bauth\b|authentication|authorization|\brequired login\b|\blogin\b|unauthori[sz]ed|credential|bearer token/.test(value)) return 'AUTH_REQUIRED';
  if (/rate.?limit|429|too many/.test(value)) return 'RATE_LIMIT';
  if (/challenge|suspicious|captcha|interstitial/.test(value)) return 'CHALLENGE';
  if (/follow|unfollow|like|repost|retweet|post|reply|dm|bookmark|delete|update|schedule|write|action/.test(value)) return 'WRITE_ACTION_DETECTED';
  return 'TRANSIENT_RUNTIME';
}

function stopFor(manifest, reason) {
  manifest.stop = { status: 'stopped', reason, at: now() };
  for (const query of manifest.queries) if (query.status === 'running') query.status = 'stopped';
}

async function ingestSearch(runDir, manifest, input) {
  assertMutable(manifest);
  assertControlPassed(manifest);
  const queryIndex = Number(input.query_index);
  if (!Number.isInteger(queryIndex) || queryIndex < 0) throw new Error('query_index_out_of_range');
  const query = manifest.queries[queryIndex];
  if (!query) throw new Error('query_index_out_of_range');
  if (manifest.stop.status === 'stopped') return;
  if (TERMINAL_QUERY_STATUSES.has(query.status)) {
    console.log(`PROGRESS run=${manifest.run_id} query=${query.index} status=${query.status} replay=ignored`);
    return;
  }
  await reconcileStoredCounts(runDir, manifest);
  const attempt = Number(input.attempt || query.attempts + 1);
  query.attempts = Math.max(query.attempts, attempt);
  query.status = 'running';
  const raw = Array.isArray(input.result) ? input.result : [];
  query.raw_result_count = raw.length;
  manifest.counts.raw_tweets_returned = (manifest.counts.raw_tweets_returned || 0) + raw.length;
  const storedSearch = await readJsonl(path.join(runDir, 'search-results.jsonl'));
  const existing = new Set(storedSearch.map(recordId));
  const authors = new Set(storedSearch.map((record) => usernameOf(record)).filter(Boolean));
  const accepted = [];
  let rejected = 0;
  for (const item of raw.slice(0, manifest.limits.result_limit_per_query)) {
    const tweet = normalizeTweet(item, query);
    if (!validTweetEvidence(tweet, manifest)) { rejected += 1; continue; }
    const id = recordId(tweet);
    if (existing.has(id)) continue;
    if (manifest.counts.raw_tweets_stored + accepted.length >= manifest.limits.max_raw_tweets) { stopFor(manifest, 'raw_tweet_cap_reached'); break; }
    if (!authors.has(tweet.username) && authors.size >= manifest.limits.max_unique_authors) { stopFor(manifest, 'unique_author_cap_reached'); break; }
    accepted.push(tweet); existing.add(id); authors.add(tweet.username);
  }
  if (accepted.length) await appendFile(path.join(runDir, 'search-results.jsonl'), accepted.map((item) => `${JSON.stringify(item)}\n`).join(''), 'utf8');
  manifest.counts.rejected_records = (manifest.counts.rejected_records || 0) + rejected;
  if (manifest.stop.status !== 'stopped') {
    query.status = raw.length ? (rejected ? 'completed_with_rejections' : 'completed') : 'empty';
    query.completed_at = now();
    manifest.last_completed_query_index = Math.max(manifest.last_completed_query_index, query.index);
    manifest.counts.search_calls_completed += 1;
    manifest.counts.consecutive_runtime_failures = 0;
  }
  await reconcileStoredCounts(runDir, manifest);
  if (manifest.counts.raw_tweets_stored >= manifest.limits.max_raw_tweets) stopFor(manifest, 'raw_tweet_cap_reached');
  await saveManifest(runDir, manifest);
  console.log(`PROGRESS run=${manifest.run_id} query=${query.index} status=${query.status} raw=${manifest.counts.raw_tweets_stored} authors=${manifest.counts.unique_authors}`);
}

async function ingestEnrichment(runDir, manifest, input) {
  assertMutable(manifest);
  assertControlPassed(manifest);
  if (!searchPlanComplete(manifest)) throw new Error('search_plan_not_complete');
  if (manifest.stop.status === 'stopped') return;
  const username = usernameOf(input.username);
  if (!username) throw new Error('missing_username');
  const index = Number(input.author_index);
  if (!Number.isInteger(index) || index < 0 || index >= manifest.limits.max_enriched_authors) throw new Error('author_index_out_of_range');
  const rankedAuthors = authorsFromTweets(await readJsonl(path.join(runDir, 'search-results.jsonl'))).slice(0, manifest.limits.max_enriched_authors);
  if (!rankedAuthors[index] || rankedAuthors[index].username !== username) throw new Error('enrichment_author_mismatch');
  const completedAuthor = manifest.authors.find((item) => item.username === username && item.enrichment_status === 'completed');
  if (completedAuthor) {
    console.log(`PROGRESS run=${manifest.run_id} enrichment=${index} user=${username} status=completed replay=ignored`);
    return;
  }
  const profile = normalizeProfile(input.profile || {}, username);
  if (profile.username !== username) throw new Error('profile_username_mismatch');
  const normalizedTweets = Array.isArray(input.tweets) ? input.tweets.slice(0, manifest.limits.recent_tweets_per_author).map((tweet) => normalizeTweet(tweet, { query: `profile:${username}`, bucket: 'profile_enrichment' })) : [];
  const tweets = normalizedTweets.filter((tweet) => validTweetEvidence(tweet, manifest, username));
  manifest.counts.rejected_records = (manifest.counts.rejected_records || 0) + (normalizedTweets.length - tweets.length);
  const profiles = await readJsonl(path.join(runDir, 'profiles.jsonl'));
  if (!profiles.some((item) => usernameOf(item) === username)) await appendFile(path.join(runDir, 'profiles.jsonl'), `${JSON.stringify(profile)}\n`, 'utf8');
  const recent = await readJsonl(path.join(runDir, 'recent-tweets.jsonl'));
  const seen = new Set(recent.map(recordId));
  const uniqueTweets = tweets.filter((tweet) => { const id = recordId(tweet); if (seen.has(id)) return false; seen.add(id); return true; });
  if (uniqueTweets.length) await appendFile(path.join(runDir, 'recent-tweets.jsonl'), uniqueTweets.map((tweet) => `${JSON.stringify({ username, ...tweet })}\n`).join(''), 'utf8');
  const author = manifest.authors.find((item) => item.username === username) || { username, index, enrichment_status: 'pending', attempts: 0 };
  author.index = index; author.enrichment_status = 'completed'; author.attempts = Math.max(author.attempts, Number(input.attempt || 1)); author.profile_present = true; author.recent_tweet_count = recent.filter((tweet) => usernameOf(tweet) === username).length + uniqueTweets.length;
  if (!manifest.authors.some((item) => item.username === username)) manifest.authors.push(author);
  manifest.counts.enrichments_completed += 1;
  manifest.counts.consecutive_runtime_failures = 0;
  manifest.last_completed_enrichment_index = Math.max(manifest.last_completed_enrichment_index, index);
  await reconcileStoredCounts(runDir, manifest);
  await saveManifest(runDir, manifest);
  console.log(`PROGRESS run=${manifest.run_id} enrichment=${index} user=${username} profiles=${manifest.counts.profiles_stored} recent=${manifest.counts.recent_tweets_stored}`);
}

async function ingestError(runDir, manifest, input) {
  assertMutable(manifest);
  const kind = errorClass(input.message);
  const scope = text(input.scope);
  const index = Number(input.index);
  const target = scope === 'search' ? manifest.queries[index] : manifest.authors.find((item) => item.index === index);
  const retryLimit = manifest.limits.retry_transient_attempts ?? 2;
  const consecutiveLimit = manifest.limits.max_consecutive_runtime_failures ?? 3;
  if (target) { target.attempts = Math.max(target.attempts || 0, Number(input.attempt || 1)); target.status = kind === 'TRANSIENT_RUNTIME' && target.attempts <= retryLimit ? 'retryable' : 'failed'; target.error_class = kind; }
  if (kind === 'TRANSIENT_RUNTIME') manifest.counts.consecutive_runtime_failures = (manifest.counts.consecutive_runtime_failures || 0) + 1;
  else manifest.counts.consecutive_runtime_failures = 0;
  if (kind !== 'TRANSIENT_RUNTIME' || (target?.attempts || 0) > retryLimit || manifest.counts.consecutive_runtime_failures >= consecutiveLimit) stopFor(manifest, kind);
  await saveManifest(runDir, manifest);
  console.log(`PROGRESS run=${manifest.run_id} error_scope=${scope} index=${index} class=${kind} stop=${manifest.stop.status}`);
}

async function ingest(runDir) {
  const manifest = await readManifest(runDir);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    await dispatchIngest(runDir, manifest, JSON.parse(line));
    if (manifest.stop.status === 'stopped') break;
  }
}

async function dispatchIngest(runDir, manifest, item) {
  if (item.type === 'control') {
    assertMutable(manifest);
    if (manifest.stop.status === 'stopped') return;
    manifest.control_check = { query: text(item.query), status: Array.isArray(item.result) && item.result.length ? 'passed' : 'empty', result_count: Array.isArray(item.result) ? item.result.length : 0 };
    manifest.counts.consecutive_runtime_failures = 0;
    if (manifest.control_check.status === 'empty') stopFor(manifest, 'CONTROL_CHECK_EMPTY');
    await saveManifest(runDir, manifest);
  } else if (item.type === 'search') await ingestSearch(runDir, manifest, item);
  else if (item.type === 'enrichment') await ingestEnrichment(runDir, manifest, item);
  else if (item.type === 'error') await ingestError(runDir, manifest, item);
  else throw new Error(`unknown_input_type:${text(item.type)}`);
}

function authorsFromTweets(tweets) {
  const grouped = new Map();
  for (const tweet of tweets) {
    const username = usernameOf(tweet);
    if (!username) continue;
    const current = grouped.get(username) || { username, tweets: [], engagement: 0 };
    current.tweets.push(tweet);
    current.engagement += Number.parseInt(String(tweet.likes).replace(/[^0-9]/g, ''), 10) || 0;
    current.engagement += Number.parseInt(String(tweet.retweets).replace(/[^0-9]/g, ''), 10) || 0;
    grouped.set(username, current);
  }
  return [...grouped.values()].sort((a, b) => b.engagement - a.engagement || a.username.localeCompare(b.username));
}

async function writeSvg(runDir, manifest, counts) {
  const W = 2000; const H = 1400;
  const node = (x, y, w, h, title, detail, fill = '#e8f1ff') => `<g><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${fill}" stroke="#1f3b63" stroke-width="2"/><text x="${x + 20}" y="${y + 36}" class="title">${xml(title)}</text><text x="${x + 20}" y="${y + 68}" class="detail">${xml(detail)}</text></g>`;
  const arrow = (x1, y1, x2, y2, label = '') => `<path d="M ${x1} ${y1} L ${x2} ${y2}" class="arrow"/>${label ? `<text x="${(x1 + x2) / 2}" y="${(y1 + y2) / 2 - 10}" class="small">${xml(label)}</text>` : ''}`;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-labelledby="title desc">
<title id="title">Marx public X prospect research pipeline</title>
<desc id="desc">Actual counts and fail-closed branches for run ${xml(manifest.run_id)}.</desc>
<style>.title{font:700 21px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;fill:#14213d}.detail{font:16px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;fill:#243b5a}.small{font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;fill:#334e68}.arrow{stroke:#526d82;stroke-width:3;fill:none;marker-end:url(#arrow)}.branch{stroke:#a33a3a;stroke-width:3;fill:none;marker-end:url(#stop)}.note{font:15px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;fill:#3c4858}.stop{font:700 17px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;fill:#7d1f1f}</style>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#526d82"/></marker><marker id="stop" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#a33a3a"/></marker></defs>
<rect width="100%" height="100%" fill="#fbfcfe"/><text x="60" y="64" class="title" font-size="28">Marx X prospect research — ${xml(manifest.run_id)}</text><text x="60" y="94" class="detail">Source: ${xml(manifest.source)} · window since ${xml(manifest.lookback_since)} · public read-only · sequential MCP calls</text>
${node(60, 150, 300, 110, 'Query buckets', `${manifest.queries.length} normalized queries / ${new Set(manifest.queries.map(q => q.bucket)).size} buckets`)}
${node(440, 150, 300, 110, 'MCP search', `${manifest.counts.search_calls_completed} completed calls · cap ${manifest.limits.max_search_calls}`)}
${node(820, 150, 300, 110, 'Raw tweets', `${counts.search} stored · cap ${manifest.limits.max_raw_tweets}`)}
${node(1200, 150, 300, 110, 'Author dedupe', `${counts.authors} unique · cap ${manifest.limits.max_unique_authors}`)}
${arrow(360, 205, 440, 205)}${arrow(740, 205, 820, 205)}${arrow(1120, 205, 1200, 205)}
${node(170, 400, 340, 115, 'Profile + timeline enrichment', `${counts.profiles} profiles · ${counts.recent} recent tweets / cap ${manifest.limits.max_enriched_authors}`)}
${node(630, 400, 340, 115, 'Deterministic scoring', `review ≥${manifest.limits.review_score ?? 50} · high-intent ≥${manifest.limits.high_intent_score ?? 70}`)}
${node(1090, 400, 340, 115, 'Human review CSV', `${counts.csv ?? 'pending'} rows · no automatic outreach`, '#eaf7ee')}
${arrow(1350, 260, 340, 400, 'ranked authors')}${arrow(510, 458, 630, 458)}${arrow(970, 458, 1090, 458)}
<rect x="60" y="650" width="1840" height="170" rx="18" fill="#fff4f4" stroke="#a33a3a" stroke-width="2"/><text x="85" y="688" class="stop">Fail-closed branches (run status: ${xml(manifest.stop.status === 'stopped' ? manifest.stop.reason : 'not triggered')})</text>
<text x="95" y="730" class="note">AUTH_REQUIRED / rate-limit / challenge</text><text x="95" y="755" class="note">→ stop and report; no fallback mixing</text>
<text x="550" y="730" class="note">raw/author cap reached</text><text x="550" y="755" class="note">→ checkpoint and finalize</text>
<text x="1000" y="730" class="note">write/action detected</text><text x="1000" y="755" class="note">→ stop immediately</text>
<path d="M 590 260 L 590 560 L 180 560 L 180 650" class="branch"/><path d="M 970 260 L 970 560 L 700 560 L 700 650" class="branch"/><path d="M 800 515 L 800 600 L 1220 600 L 1220 650" class="branch"/>
<rect x="60" y="870" width="1840" height="175" rx="18" fill="#eef2f7" stroke="#6b7c93" stroke-width="2"/><text x="85" y="910" class="title">Run note</text><text x="85" y="945" class="note">Scores are deterministic heuristics, not qualification. Every CSV row requires human verification of identity, dated evidence, Marx relevance, and provenance.</text><text x="85" y="978" class="note">Outreach and all X write actions are human-approved and outside this run. Actions ledger: ${manifest.actions_performed.length}.</text><text x="85" y="1011" class="note">Status: ${xml(manifest.stop.status === 'stopped' ? 'STOPPED' : (counts.search ? 'OK' : 'NO_ACTION'))} · finished: ${xml(manifest.run_finished_at || 'pending')}</text>
</svg>`;
  await writeFile(path.join(runDir, 'research-pipeline.svg'), svg, 'utf8');
}

function resolveScorerPath(manifest, cliScorer) {
  return path.resolve(cliScorer || process.env.XGE_SCORER_PATH || manifest.scorer_path || DEFAULT_SCORER);
}

async function validateStoredEvidence(search, recentRows, manifest) {
  for (const tweet of search) if (!validTweetEvidence(tweet, manifest)) throw new Error(`invalid_stored_search_evidence:${recordId(tweet)}`);
  for (const tweet of recentRows) if (!validTweetEvidence(tweet, manifest, usernameOf(tweet))) throw new Error(`invalid_stored_recent_evidence:${recordId(tweet)}`);
}

async function finalize(runDir, cliScorer = '') {
  const manifest = await readManifest(runDir);
  assertMutable(manifest);
  if (manifest.stop.status !== 'stopped') {
    assertControlPassed(manifest);
    if (!searchPlanComplete(manifest)) throw new Error('incomplete_search_plan');
  }
  const search = await readJsonl(path.join(runDir, 'search-results.jsonl'));
  const profiles = await readJsonl(path.join(runDir, 'profiles.jsonl'));
  const recentRows = await readJsonl(path.join(runDir, 'recent-tweets.jsonl'));
  await validateStoredEvidence(search, recentRows, manifest);
  const scorer = resolveScorerPath(manifest, cliScorer);
  try { await access(scorer); } catch { throw new Error(`scorer_not_found:${scorer}`); }
  const recent = {};
  for (const row of recentRows) (recent[row.username] ||= []).push(row);
  const dedupedSearch = [...new Map(search.map((tweet) => [recordId(tweet), tweet])).values()];
  const dedupedProfiles = [...new Map(profiles.map((profile) => [usernameOf(profile), profile])).values()].filter((profile) => profile.username);
  const authors = authorsFromTweets(dedupedSearch);
  manifest.authors = authors.slice(0, manifest.limits.max_enriched_authors).map((author, index) => {
    const existing = manifest.authors.find((item) => item.username === author.username);
    return existing || { username: author.username, index, enrichment_status: 'pending', attempts: 0, search_tweet_count: author.tweets.length, engagement: author.engagement };
  });
  manifest.counts = { ...manifest.counts, raw_tweets_stored: dedupedSearch.length, unique_authors: authors.length, profiles_stored: dedupedProfiles.length, recent_tweets_stored: recentRows.length };
  manifest.run_finished_at = now();
  if (manifest.stop.status !== 'stopped') manifest.stop = { status: 'not_stopped', reason: null, at: null };
  const exportPayload = {
    run_status: manifest.stop.status === 'stopped' ? 'STOPPED' : (dedupedSearch.length ? 'OK' : 'NO_ACTION'),
    run_started_at: manifest.run_started_at,
    run_finished_at: manifest.run_finished_at,
    lookback_since: manifest.lookback_since,
    source: manifest.source,
    search_results: dedupedSearch,
    profiles: dedupedProfiles,
    recent_tweets: recent,
    network_users: [],
    actions_performed: [],
    stop_reason: manifest.stop.reason,
  };
  const exportPath = path.join(runDir, 'mcp-comprehensive-x-export.json');
  const csvPath = path.join(runDir, 'comprehensive-candidates.csv');
  const stagedExport = `${exportPath}.staging-${process.pid}`;
  const stagedCsv = `${csvPath}.staging-${process.pid}`;
  let csvRows;
  try {
    await atomicJson(stagedExport, exportPayload);
    const scorerCommand = /\.m?js$/i.test(scorer) ? process.execPath : 'python3';
    const scored = spawnSync(scorerCommand, [scorer, '--input', stagedExport, '--output', stagedCsv, '--min-score', String(manifest.limits.review_score ?? 50)], { encoding: 'utf8' });
    if (scored.error || scored.status !== 0) throw new Error(`scorer_failed:${text(scored.error?.message || scored.stderr).slice(0, 240)}`);
    let receipt;
    try { receipt = JSON.parse(text(scored.stdout).split('\n').filter(Boolean).at(-1)); }
    catch { throw new Error('scorer_invalid_receipt'); }
    if (receipt?.status !== 'ok' || !Number.isInteger(receipt.rows_written) || receipt.rows_written < 0) throw new Error('scorer_invalid_receipt');
    let csvBody;
    try { csvBody = await readFile(stagedCsv, 'utf8'); }
    catch { throw new Error('scorer_output_missing'); }
    if (csvBody.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] !== CSV_HEADER) throw new Error('scorer_output_invalid_header');
    csvRows = receipt.rows_written;
    await rename(stagedExport, exportPath);
    await rename(stagedCsv, csvPath);
  } catch (error) {
    await Promise.all([rm(stagedExport, { force: true }), rm(stagedCsv, { force: true })]);
    throw error;
  }
  const counts = { search: dedupedSearch.length, authors: authors.length, profiles: dedupedProfiles.length, recent: recentRows.length, csv: Number(csvRows) };
  await atomicJson(path.join(runDir, 'run-manifest.json'), manifest);
  await writeSvg(runDir, manifest, counts);
  const report = `# Marx X comprehensive prospect run\n\n- Plan status: proposed — confirm with the research decision owner.\n- Run: \`${manifest.run_id}\`\n- Status: **${exportPayload.run_status}**${manifest.stop.reason ? ` (${manifest.stop.reason})` : ''}\n- Started: ${manifest.run_started_at}\n- Finished: ${manifest.run_finished_at}\n- Source: ${manifest.source}; platform: ${manifest.platform}; public read-only MCP calls.\n- Lookback: since ${manifest.lookback_since}; query plan: ${manifest.queries.length} normalized queries across ${new Set(manifest.queries.map((q) => q.bucket)).size} buckets.\n\n## Observed counts\n\n| Stage | Count | Cap |\n|---|---:|---:|\n| Completed search calls | ${manifest.counts.search_calls_completed} | ${manifest.limits.max_search_calls} |\n| Stored raw tweets | ${counts.search} | ${manifest.limits.max_raw_tweets} |\n| Unique authors | ${counts.authors} | ${manifest.limits.max_unique_authors} |\n| Enriched profiles | ${counts.profiles} | ${manifest.limits.max_enriched_authors} |\n| Recent tweets | ${counts.recent} | ${manifest.limits.max_enriched_authors * manifest.limits.recent_tweets_per_author} |\n| Rejected evidence records | ${manifest.counts.rejected_records || 0} | — |\n| CSV review rows (score ≥ ${manifest.limits.review_score ?? 50}) | ${counts.csv} | — |\n\n## Evidence contract\n\nA CSV row is a deterministic review candidate, not a qualified prospect. The row must be manually checked for identity match, dated public evidence within the lookback window, direct Marx relevance, and provenance before any outreach.\n\nPrimary evidence question: does a bounded public-X MCP pass produce enough identity-matched, dated AI-trading/finance-agent evidence to justify a second research pass or approved network expansion? Outcome that changes the decision: human review confirms or rejects the candidate evidence.\n\nPrimary metric: high-intent review rate = rows with score ≥${manifest.limits.high_intent_score ?? 70} / scored rows; source of truth: ${runDir}/comprehensive-candidates.csv; cohort/window: this run, ${manifest.lookback_since} through ${manifest.run_finished_at}; evidence status: proposed.\n\nGuardrail: unintended X write; definition/unit: count of follow, like, repost, post, reply, DM, bookmark, profile-edit, or schedule actions; source of truth: run manifest and MCP action logs; cohort/window: this run; evidence status: verified for local ledger (0), external tool logs unknown; trigger/action/responder: any value >0 → stop and credential review / unassigned — system owner.\n\nGuardrail: source-quality failure; definition/unit: auth wall, challenge, rate-limit, or repeated runtime failure; source of truth: run manifest; cohort/window: this run; evidence status: ${manifest.stop.reason ? 'verified' : 'proposed'}; trigger/action/responder: stop and report / unassigned — research owner.\n\n## Safety and QA\n\n- Actions ledger: exactly empty (${manifest.actions_performed.length}). Network expansion: disabled. Private contact inference: disabled.\n- Checkpoints are atomic; search, profile, and recent-tweet records are append-only JSONL. Resume uses record IDs/usernames to avoid duplicates.\n- Scores are heuristics. Outreach remains human-approved and is outside this run.\n- SVG: [research-pipeline.svg](./research-pipeline.svg).\n`;
  await writeFile(path.join(runDir, 'run-report.md'), report, 'utf8');
  console.log(JSON.stringify({ status: exportPayload.run_status, run_dir: runDir, search_results: counts.search, unique_authors: counts.authors, profiles: counts.profiles, recent_tweets: counts.recent, csv_rows: counts.csv, actions_performed: [] }));
}

function usage() {
  console.error('usage: node scripts/run-comprehensive.mjs --new-run | --ingest --run-dir <dir> | --ingest-batch-encoded <batch> --run-dir <dir> | --finalize --run-dir <dir> [--scorer <path>]');
  process.exitCode = 2;
}

const args = process.argv.slice(2);
try {
  if (args.includes('--new-run')) await initRun();
  else {
    const at = args.indexOf('--run-dir');
    if (at < 0 || !args[at + 1]) usage();
    else if (args.includes('--ingest')) {
      const runDir = path.resolve(args[at + 1]);
      await withRunLock(runDir, () => ingest(runDir));
    }
    else if (args.includes('--ingest-batch-encoded')) {
      const encoded = args[args.indexOf('--ingest-batch-encoded') + 1];
      if (!encoded) throw new Error('missing_encoded_batch');
      const runDir = path.resolve(args[at + 1]);
      await withRunLock(runDir, async () => {
        const manifest = await readManifest(runDir);
        await dispatchIngest(runDir, manifest, JSON.parse(decodeURIComponent(encoded)));
      });
    }
    else if (args.includes('--finalize')) {
      const scorerAt = args.indexOf('--scorer');
      const scorer = scorerAt >= 0 ? args[scorerAt + 1] : '';
      if (scorerAt >= 0 && !scorer) throw new Error('missing_scorer_path');
      const runDir = path.resolve(args[at + 1]);
      await withRunLock(runDir, () => finalize(runDir, scorer));
    }
    else usage();
  }
} catch (error) {
  console.error(JSON.stringify({ status: 'error', error_class: errorClass(error?.message), message: text(error?.message).slice(0, 240), actions_performed: [] }));
  process.exitCode = 1;
}
