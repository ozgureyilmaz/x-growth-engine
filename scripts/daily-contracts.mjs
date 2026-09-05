import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export const MessageEnvelopeSchema = z.object({
  schema_version: z.literal('1.0'),
  message_type: z.string().min(1),
  event_id: z.string().min(1),
  run_id: z.string().min(1),
  created_at: z.string().datetime({ offset: true }),
  idempotency_key: z.string().min(1),
  payload: z.record(z.unknown()),
}).strict();

export const SourcePostSchema = z.object({
  provider_id: z.string().min(1),
  url: z.string().url(),
  username: z.string().regex(/^[a-z0-9_]{1,15}$/),
  text: z.string().trim().min(1),
  timestamp: z.string().datetime({ offset: true }),
  retrieved_at: z.string().datetime({ offset: true }),
  likes: z.number().nonnegative(),
  reposts: z.number().nonnegative(),
  replies: z.number().nonnegative(),
  query: z.string().min(1),
  bucket: z.string().min(1),
  evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const SourceAccountSchema = z.object({
  username: z.string().regex(/^[a-z0-9_]{1,15}$/),
  name: z.string(),
  bio: z.string(),
  website: z.string(),
  followers: z.number().nonnegative().nullable(),
  following: z.number().nonnegative().nullable(),
  retrieved_at: z.string().datetime({ offset: true }),
  evidence_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const DraftSchema = z.object({
  action_id: z.string().min(1),
  action_type: z.enum(['POST_DRAFT', 'REPLY_DRAFT', 'QUOTE_DRAFT']),
  publisher_account: z.literal('nullquanty'),
  target: z.object({
    post_id: z.string().min(1).optional(),
    post_url: z.string().url().optional(),
    username: z.string().regex(/^[a-z0-9_]{1,15}$/).optional(),
  }).strict(),
  body: z.string().trim().min(1).max(280),
  strategy_family: z.string().min(1),
  hook_family: z.string().min(1),
  source_record_ids: z.array(z.string().min(1)).min(1),
  fact_ids: z.array(z.string().min(1)),
  context_hash: z.string().regex(/^[a-f0-9]{64}$/),
  body_hash: z.string().regex(/^[a-f0-9]{64}$/),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  model: z.literal('gpt-5.6-luna'),
  reasoning_effort: z.literal('xhigh'),
  prompt_versions: z.record(z.string().min(1)),
  evaluation: z.object({
    context_fit: z.number().min(0).max(1),
    usefulness: z.number().min(0).max(1),
    naturalness: z.number().min(0).max(1),
    marx_relevance: z.number().min(0).max(1),
    spam_risk: z.number().min(0).max(1),
    repetition_risk: z.number().min(0).max(1),
    unsupported_claim_risk: z.number().min(0).max(1),
    decision: z.enum(['PUBLISHABLE', 'REGENERATE', 'NO_ACTION']),
  }).strict(),
  qa: z.object({ passed: z.boolean(), reasons: z.array(z.string()) }).strict(),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export const OpportunityAnalysisSchema = z.array(z.object({
  context_index: z.number().int().nonnegative(),
  opportunity_score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  recommended_action_type: z.enum(['POST_DRAFT', 'REPLY_DRAFT', 'QUOTE_DRAFT']),
  reason: z.string().min(1),
}).strict());

export const DraftGenerationSchema = z.array(z.object({
  context_index: z.number().int().nonnegative(),
  action_type: z.enum(['POST_DRAFT', 'REPLY_DRAFT', 'QUOTE_DRAFT']),
  body: z.string().trim().min(1).max(280),
  strategy_family: z.string().min(1),
  hook_family: z.string().min(1),
  fact_ids: z.array(z.string().min(1)).min(1),
}).strict());

export const EvaluationBatchSchema = z.array(z.object({
  draft_index: z.number().int().nonnegative(),
  scores: z.object({
    context_fit: z.number().min(0).max(1),
    usefulness: z.number().min(0).max(1),
    naturalness: z.number().min(0).max(1),
    marx_relevance: z.number().min(0).max(1),
    spam_risk: z.number().min(0).max(1),
    repetition_risk: z.number().min(0).max(1),
    unsupported_claim_risk: z.number().min(0).max(1),
  }).strict(),
  decision: z.enum(['PUBLISHABLE', 'REGENERATE', 'NO_ACTION']),
  reasons: z.array(z.string()),
}).strict());

export const NoActionSchema = z.object({
  action_id: z.string().min(1),
  action_type: z.literal('NO_ACTION'),
  reason: z.enum(['LOW_RELEVANCE', 'CONTEXT_MISSING', 'NO_NATURAL_MARX_BRIDGE', 'DUPLICATE', 'SPAM_RISK', 'UNSUPPORTED_CLAIM', 'MODEL_LIMIT', 'SOURCE_STOPPED', 'QUALITY_BELOW_THRESHOLD']),
  source_record_ids: z.array(z.string().min(1)),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export const ReviewBundleSchema = z.object({
  schema_version: z.literal('1.0'),
  message_type: z.literal('X_FOUNDER_REVIEW_BUNDLE'),
  run_id: z.string().min(1),
  mode: z.string().min(1),
  generated_at: z.string().datetime({ offset: true }),
  source_contexts: z.array(z.object({ provider_id: z.string().min(1), url: z.string().url(), username: z.string().min(1), text: z.string().min(1), timestamp: z.string().datetime({ offset: true }) }).strict()),
  drafts: z.array(DraftSchema),
  no_action_count: z.number().int().nonnegative(),
  source_health: z.string().min(1),
  status: z.string().optional(),
  context_details: z.array(z.record(z.unknown())).optional(),
  facts: z.array(z.record(z.unknown())).optional(),
  decisions: z.array(z.record(z.unknown())).optional(),
  model_calls: z.number().int().nonnegative().optional(),
  publisher_enabled: z.literal(false),
}).strict();

export const nowIso = () => new Date().toISOString();
export const normalizeUsername = (value) => String(value ?? '').trim().replace(/^@/, '').toLowerCase();
export const text = (value) => String(value ?? '').trim();

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex');
}

export function eventEnvelope(messageType, runId, payload, idempotencyKey) {
  return MessageEnvelopeSchema.parse({ schema_version: '1.0', message_type: messageType, event_id: `evt_${randomUUID()}`, run_id: runId, created_at: nowIso(), idempotency_key: idempotencyKey, payload });
}

export function canonicalPostUrl(value) {
  const parsed = new URL(text(value));
  const match = parsed.href.match(/^https:\/\/(?:www\.)?x\.com\/([a-z0-9_]{1,15})\/status\/(\d+)(?:[/?#].*)?$/i);
  if (!match) throw new Error('INVALID_X_POST_URL');
  return `https://x.com/${match[1].toLowerCase()}/status/${match[2]}`;
}

export function postIdFromUrl(value) {
  return canonicalPostUrl(value).match(/status\/(\d+)$/)?.[1] ?? '';
}

function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value);
  const match = text(value).replace(/,/g, '').match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

export function normalizePost(raw, query, bucket, retrievedAt = nowIso()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const author = raw.author ?? raw.user ?? raw.username;
  const username = normalizeUsername(typeof author === 'object' ? author.username ?? author.screen_name ?? author.handle : author);
  const url = text(raw.url ?? raw.permanentUrl ?? raw.tweet_url ?? raw.link);
  const timestamp = text(raw.timeParsed ?? raw.timestamp ?? raw.created_at ?? raw.date);
  if (!username || !url || !timestamp || !Number.isFinite(Date.parse(timestamp))) return undefined;
  let canonicalUrlValue;
  try { canonicalUrlValue = canonicalPostUrl(url); } catch { return undefined; }
  if (new URL(canonicalUrlValue).pathname.split('/')[1] !== username) return undefined;
  const providerId = text(raw.id) || postIdFromUrl(canonicalUrlValue);
  if (!providerId || providerId !== postIdFromUrl(canonicalUrlValue)) return undefined;
  const value = { provider_id: providerId, url: canonicalUrlValue, username, text: text(raw.text ?? raw.fullText ?? raw.content), timestamp: new Date(timestamp).toISOString(), retrieved_at: retrievedAt, likes: numeric(raw.likes ?? raw.likeCount), reposts: numeric(raw.retweets ?? raw.retweetCount ?? raw.reposts), replies: numeric(raw.replies ?? raw.replyCount), query, bucket };
  if (!value.text || !Number.isFinite(Date.parse(value.timestamp))) return undefined;
  const {retrieved_at, query: ignoredQuery, bucket: ignoredBucket, ...evidence} = value;
  const result = SourcePostSchema.safeParse({ ...value, evidence_hash: sha256(evidence) });
  return result.success ? result.data : undefined;
}

export function normalizeAccount(raw, fallbackUsername, retrievedAt = nowIso()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {};
  const username = normalizeUsername(raw.username ?? raw.author ?? raw.user ?? fallbackUsername);
  if (!username || !/^[a-z0-9_]{1,15}$/.test(username)) return undefined;
  const value = { username, name: text(raw.name ?? raw.displayName), bio: text(raw.bio ?? raw.description), website: text(raw.website ?? raw.url), followers: raw.followers == null && raw.followersCount == null ? null : numeric(raw.followers ?? raw.followersCount), following: raw.following == null && raw.followingCount == null ? null : numeric(raw.following ?? raw.followingCount), retrieved_at: retrievedAt };
  return SourceAccountSchema.parse({ ...value, evidence_hash: sha256(value) });
}
