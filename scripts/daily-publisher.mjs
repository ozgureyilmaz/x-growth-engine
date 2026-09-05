import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { arrayResult, decodeToolResult } from './daily-source.mjs';
import { canonicalPostUrl, normalizeUsername, postIdFromUrl } from './daily-contracts.mjs';
import { delay, errorCode, throwIfAborted } from './daily-runtime.mjs';

export const DEFAULT_WRITE_TOOLS = {
  POST_DRAFT: 'x_post_tweet',
  REPLY_DRAFT: 'x_reply',
  QUOTE_DRAFT: 'x_quote_tweet',
};

export const DEFAULT_READBACK_TOOLS = ['x_get_tweets', 'x_get_replies', 'x_get_quote_tweets'];

function postCandidate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const author = raw.author ?? raw.user ?? raw.username ?? raw.authorUsername ?? raw.screen_name;
  const authorText = typeof author === 'object' ? (author.username ?? author.screen_name ?? author.handle ?? '') : String(author ?? '');
  const username = normalizeUsername(authorText);
  const body = String(raw.text ?? raw.fullText ?? raw.content ?? raw.body ?? '').trim();
  const rawUrl = String(raw.url ?? raw.permanentUrl ?? raw.tweet_url ?? raw.link ?? '').trim();
  let url = '';
  try { url = rawUrl ? canonicalPostUrl(rawUrl) : ''; } catch { url = ''; }
  const providerId = String(raw.id ?? (url ? postIdFromUrl(url) : '')).trim();
  if (!url && providerId && username) url = `https://x.com/${username}/status/${providerId}`;
  const timestamp = String(raw.timestamp ?? raw.created_at ?? raw.date ?? raw.timeParsed ?? '').trim();
  return { username, authorText, body, url, provider_id: providerId, timestamp };
}

function authorMatches(candidate, account) {
  const expected = normalizeUsername(account);
  if (candidate.username === expected) return true;
  return candidate.authorText.toLowerCase().split(/\s+/).some((token) => normalizeUsername(token.replace(/[(),]/g, '')) === expected);
}

function matchingCandidates(value, body, account, dispatchedAt, requireIdentity = true) {
  let rows;
  try { rows = arrayResult(value); } catch { return []; }
  return rows.map(postCandidate).filter(Boolean).filter((candidate) => {
    if (candidate.body !== body || !authorMatches(candidate, account)) return false;
    if (requireIdentity && (!candidate.provider_id || !candidate.url)) return false;
    if (!candidate.timestamp) return true;
    const timestamp = Date.parse(candidate.timestamp);
    return Number.isFinite(timestamp) && timestamp <= dispatchedAt + 120000 && timestamp >= dispatchedAt - 600000;
  });
}

function publishError(code, message, phase = 'dispatch') {
  const error = new Error(message || code);
  error.code = code;
  error.phase = phase;
  return error;
}

export class XActionsMcpPublisher {
  constructor(options = {}) {
    this.command = options.command;
    this.args = options.args ?? [];
    this.cwd = options.cwd;
    this.callTimeoutMs = options.callTimeoutMs ?? 60000;
    this.readbackAttempts = options.readbackAttempts ?? 3;
    this.readbackDelayMs = options.readbackDelayMs ?? 5000;
    this.interActionDelayMs = (options.interActionDelaySeconds ?? 5) * 1000;
    this.signal = options.signal;
    this.lastCall = 0;
    this.writeTools = { ...DEFAULT_WRITE_TOOLS, ...(options.writeTools ?? {}) };
    this.readbackTools = [...new Set(options.readbackTools ?? DEFAULT_READBACK_TOOLS)];
    this.allowedTools = new Set([...Object.values(this.writeTools), ...this.readbackTools]);
  }

  async connect() {
    if (this.client) return;
    const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM', 'PUPPETEER_EXECUTABLE_PATH'].flatMap((key) => process.env[key] ? [[key, process.env[key]] ] : []));
    this.transport = new StdioClientTransport({ command: this.command, args: this.args, cwd: this.cwd, env: { ...env, XACTIONS_MODE: 'local' }, stderr: 'pipe' });
    this.transport.stderr?.on('data', () => {});
    this.client = new Client({ name: 'x-growth-auto-publisher', version: '2.0.0' }, { capabilities: {} });
    try {
      await this.client.connect(this.transport, { timeout: this.callTimeoutMs });
      const listed = await this.client.listTools({}, { timeout: this.callTimeoutMs });
      const missing = [...this.allowedTools].filter((name) => !listed.tools.some((tool) => tool.name === name));
      if (missing.length) throw publishError('PUBLISHER_TOOL_MISSING', missing.join(','), 'preflight');
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;
    try { await client?.close(); } finally { await transport?.close(); }
  }

  async call(tool, args) {
    if (!this.allowedTools.has(tool)) throw publishError('PUBLISHER_TOOL_NOT_ALLOWLISTED', tool, 'preflight');
    throwIfAborted(this.signal);
    await delay(Math.max(0, this.lastCall + this.interActionDelayMs - Date.now()), this.signal);
    await this.connect();
    this.lastCall = Date.now();
    const controller = new AbortController();
    const stop = () => controller.abort(this.signal?.reason ?? new Error('INTERRUPTED'));
    const timer = setTimeout(() => controller.abort(publishError('PUBLISHER_TIMEOUT', 'publisher call timed out', 'dispatch')), this.callTimeoutMs);
    this.signal?.addEventListener('abort', stop, { once: true });
    try {
      const result = await this.client.callTool({ name: tool, arguments: args }, undefined, { signal: controller.signal, timeout: this.callTimeoutMs });
      return decodeToolResult(result);
    } catch (error) {
      if (error?.code === 'PUBLISHER_TIMEOUT' || controller.signal.aborted) throw error?.code ? error : publishError('PUBLISH_WRITE_UNKNOWN', error?.message, 'dispatch_unknown');
      throw publishError(errorCode(error), error?.message, 'dispatch_unknown');
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', stop);
    }
  }

  async publish(draft) {
    const tool = this.writeTools[draft.action_type];
    if (!tool) throw publishError('ACTION_TYPE_NOT_ALLOWLISTED', draft.action_type, 'preflight');
    const args = draft.action_type === 'POST_DRAFT'
      ? { text: draft.body }
      : draft.action_type === 'REPLY_DRAFT'
        ? { url: draft.target.post_url, text: draft.body }
        : { tweetUrl: draft.target.post_url, text: draft.body };
    let response;
    try { response = await this.call(tool, args); } catch (error) { throw error; }
    if (response?.success !== true) throw publishError('PUBLISH_PROVIDER_REJECTED', String(response?.message ?? 'provider returned unsuccessful result'), 'dispatch_known');
    return { response, dispatched_at: Date.now() };
  }

  async readbackOnce(draft, dispatchedAt) {
    const account = draft.publisher_account;
    if (draft.action_type === 'POST_DRAFT') {
      const result = await this.call('x_get_tweets', { platform: 'twitter', username: account, limit: 20 });
      const matches = matchingCandidates(result, draft.body, account, dispatchedAt);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw publishError('PUBLISH_READBACK_AMBIGUOUS', 'multiple matching posts found', 'readback');
      return undefined;
    }
    if (draft.action_type === 'REPLY_DRAFT') {
      const result = await this.call('x_get_replies', { tweetUrl: draft.target.post_url, limit: 20, sort: 'recent' });
      const matches = matchingCandidates(result, draft.body, account, dispatchedAt);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw publishError('PUBLISH_READBACK_AMBIGUOUS', 'multiple matching replies found', 'readback');
      return undefined;
    }
    const quoteResult = await this.call('x_get_quote_tweets', { tweetUrl: draft.target.post_url, limit: 20 });
    const quoteMatches = matchingCandidates(quoteResult, draft.body, account, dispatchedAt, false);
    if (quoteMatches.length > 1) throw publishError('PUBLISH_READBACK_AMBIGUOUS', 'multiple matching quotes found', 'readback');
    if (!quoteMatches.length) return undefined;
    const timeline = await this.call('x_get_tweets', { platform: 'twitter', username: account, limit: 20 });
    const ownMatches = matchingCandidates(timeline, draft.body, account, dispatchedAt);
    if (ownMatches.length === 1) return ownMatches[0];
    if (ownMatches.length > 1) throw publishError('PUBLISH_READBACK_AMBIGUOUS', 'multiple matching quote posts found', 'readback');
    return undefined;
  }

  async readback(draft, dispatchedAt) {
    for (let attempt = 1; attempt <= this.readbackAttempts; attempt += 1) {
      throwIfAborted(this.signal);
      const match = await this.readbackOnce(draft, dispatchedAt);
      if (match) return { provider_id: match.provider_id, permalink: match.url, attempt };
      if (attempt < this.readbackAttempts) await delay(this.readbackDelayMs, this.signal);
    }
    throw publishError('PUBLISH_READBACK_NOT_FOUND', 'no unique provider read-back match', 'readback');
  }

  async publishAndVerify(draft) {
    let published;
    try {
      published = await this.publish(draft);
    } catch (error) {
      const unknown = error?.phase === 'dispatch_unknown' || error?.code === 'PUBLISHER_TIMEOUT' || error?.code === 'SOURCE_TIMEOUT';
      return { status: unknown ? 'RECONCILIATION_REQUIRED' : 'FAILED', error_code: errorCode(error), error_message: error?.message };
    }
    try {
      const readback = await this.readback(draft, published.dispatched_at);
      return { status: 'PUBLISHED', provider_id: readback.provider_id, permalink: readback.permalink, readback_attempt: readback.attempt };
    } catch (error) {
      return { status: 'RECONCILIATION_REQUIRED', error_code: errorCode(error), error_message: error?.message };
    }
  }
}
