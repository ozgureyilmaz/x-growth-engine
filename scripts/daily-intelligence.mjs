import { DraftSchema, NoActionSchema, normalizeUsername, sha256, stableStringify, nowIso } from './daily-contracts.mjs';

const AI_TERMS = ['ai', 'llm', 'gpt', 'claude', 'machine learning', 'agent', 'agentic', 'autonomous'];
const FINANCE_TERMS = ['trading', 'trader', 'crypto', 'quant', 'portfolio', 'market', 'backtest', 'defi', 'prediction market', 'execution', 'risk'];
const BUILDER_TERMS = ['built', 'building', 'shipped', 'launched', 'developer', 'engineer', 'founder', 'prototype', 'open source', 'mcp'];
const SPAM_TERMS = ['guaranteed profit', '100x', 'free alpha', 'signal group', 'join telegram', 'giveaway', 'airdrop'];
const GENERIC_OPENERS = /^(great|awesome|love|interesting)\s+(point|post|thread|idea)|^this is (huge|a game changer)|^game[- ]changer/i;
const HYPE = /\b(revolutionary|seamless|game[- ]changer|the future of|unlock unprecedented|guaranteed|risk[- ]free|always profitable|will make money)\b/i;
const CTA = /\b(click|sign up|join|try it|check it out|dm me|follow me|learn more)\b/i;

function contains(text, terms) { const lower = String(text ?? '').toLowerCase(); return terms.some((term) => lower.includes(term)); }
function tokens(text) { return new Set(String(text ?? '').toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []); }
function overlap(a, b) { const left = tokens(a); const right = tokens(b); if (!left.size || !right.size) return 0; return [...left].filter((item) => right.has(item)).length / Math.max(left.size, right.size); }

export function scoreOpportunity(post, account = {}, context = {}) {
  account = account ?? {};
  const body = `${post.text} ${account.bio ?? ''}`.toLowerCase();
  let score = 0;
  const reasons = [];
  if (contains(body, AI_TERMS)) { score += 0.2; reasons.push('AI/agent signal'); }
  if (contains(body, FINANCE_TERMS)) { score += 0.2; reasons.push('finance/trading signal'); }
  if (contains(body, AI_TERMS) && contains(body, FINANCE_TERMS)) { score += 0.25; reasons.push('AI-finance intersection'); }
  if (contains(body, BUILDER_TERMS)) { score += 0.15; reasons.push('builder signal'); }
  if ((post.likes + post.reposts + post.replies) > 5) { score += 0.05; reasons.push('conversation activity'); }
  if (contains(body, SPAM_TERMS)) { score -= 0.35; reasons.push('spam/signal-seller language'); }
  const replyCount = Array.isArray(context.replies) ? context.replies.length : 0;
  if (replyCount > 15) { score -= 0.1; reasons.push('thread may be saturated'); }
  return { score: Math.max(0, Math.min(1, score)), reasons, confidence: reasons.length >= 3 ? 0.8 : 0.45 };
}

export function chooseStrategy(score, index = 0, strategies = []) {
  const available = strategies.length ? strategies : ['EVIDENCE_AND_PROVENANCE', 'VALIDATION_AND_FAILURE_MODES', 'AGENT_WORKFLOW', 'RISK_AND_EXECUTION', 'USEFUL_COUNTERPOINT', 'SPECIFIC_CLARIFYING_QUESTION', 'RESEARCH_TO_ACTION_BRIDGE'];
  return available[index % available.length];
}

export function deterministicQa(body, context, priorBodies, options) {
  const text = String(body ?? '').trim();
  const lower = text.toLowerCase();
  const anchor = String(context?.post?.text ?? '').toLowerCase().split(/\W+/).filter((word) => word.length >= 5).some((word) => lower.includes(word));
  const marxMentions = (text.match(/\bmarx\b/gi) ?? []).length;
  const reasons = [];
  if (text.length < 40 || text.length > options.max_chars) reasons.push('LENGTH_INVALID');
  if (marxMentions !== options.marx_mentions) reasons.push('MARX_MENTION_COUNT');
  if (!anchor) reasons.push('MISSING_CONTEXT_ANCHOR');
  if (GENERIC_OPENERS.test(text)) reasons.push('GENERIC_OPENING');
  if (HYPE.test(text)) reasons.push('HYPE_OR_UNSUPPORTED_CLAIM');
  if (!options.links_allowed && /https?:\/\//i.test(text)) reasons.push('LINK_NOT_ALLOWED');
  if (!options.ctas_allowed && CTA.test(text)) reasons.push('CTA_NOT_ALLOWED');
  if (!options.hashtags_allowed && /(^|\s)#\w+/u.test(text)) reasons.push('HASHTAG_NOT_ALLOWED');
  if ((priorBodies ?? []).some((prior) => overlap(prior, text) >= 0.82)) reasons.push('NEAR_DUPLICATE');
  if (/(\b\w+\b)(?:\s+\1){2,}/i.test(text)) reasons.push('REPEATED_WORD');
  if (/\b(buy|sell|short|long|price target|guarantee returns)\b/i.test(text)) reasons.push('FINANCIAL_ADVICE');
  if (text.includes('\n\n')) reasons.push('FORMAT_INVALID');
  return { passed: reasons.length === 0, reasons };
}

export function buildDraft(candidate, context, evaluation, qa, metadata) {
  const body = String(candidate.body ?? candidate.comment ?? '').trim();
  const target = candidate.action_type === 'POST_DRAFT' ? {} : { post_id: context.post.provider_id, post_url: context.post.url, username: context.post.username };
  const actionId = `xact_${sha256({ run_id: metadata.run_id, type: candidate.action_type, target, body }).slice(0, 24)}`;
  const base = { action_id: actionId, action_type: candidate.action_type, publisher_account: 'nullquanty', target, body, strategy_family: candidate.strategy_family, hook_family: candidate.hook_family, source_record_ids: [context.post.provider_id], fact_ids: metadata.fact_ids ?? [], context_hash: context.context_hash, body_hash: sha256(body), model: 'gpt-5.6-luna', reasoning_effort: 'xhigh', prompt_versions: metadata.prompt_versions, evaluation, qa, created_at: nowIso() };
  return DraftSchema.parse({ ...base, action_hash: draftActionHash(base) });
}

export function draftActionHash(draft) {
  const hashMaterial = { action_id: draft.action_id, action_type: draft.action_type, publisher_account: draft.publisher_account, target: draft.target, body: draft.body, strategy_family: draft.strategy_family, hook_family: draft.hook_family, source_record_ids: draft.source_record_ids, fact_ids: draft.fact_ids, context_hash: draft.context_hash, body_hash: draft.body_hash, model: draft.model, reasoning_effort: draft.reasoning_effort, prompt_versions: draft.prompt_versions };
  return sha256(stableStringify(hashMaterial));
}

export function makeNoAction(reason, sourceRecordIds = []) {
  const createdAt = nowIso();
  return NoActionSchema.parse({ action_id: `xno_${sha256({ reason, sourceRecordIds }).slice(0, 24)}`, action_type: 'NO_ACTION', reason, source_record_ids: sourceRecordIds, created_at: createdAt });
}

export function normalizeCandidate(candidate, context, index, options) {
  const actionTypeValid = ['POST_DRAFT', 'REPLY_DRAFT', 'QUOTE_DRAFT'].includes(candidate?.action_type);
  const actionType = actionTypeValid ? candidate.action_type : 'REPLY_DRAFT';
  const body = String(candidate?.body ?? candidate?.comment ?? '').trim();
  const strategy = String(candidate?.strategy_family ?? chooseStrategy(0, index, options.strategies));
  const hook = String(candidate?.hook_family ?? 'specific_context');
  const qa = deterministicQa(body, context, options.priorBodies, options);
  if (!actionTypeValid) { qa.passed = false; qa.reasons.push('ACTION_TYPE_INVALID'); }
  const rawEvaluation = candidate?.evaluation && typeof candidate.evaluation === 'object' ? candidate.evaluation : {};
  const scoreSource = rawEvaluation.scores && typeof rawEvaluation.scores === 'object' ? rawEvaluation.scores : rawEvaluation;
  const scoreNames = ['context_fit', 'usefulness', 'naturalness', 'marx_relevance', 'spam_risk', 'repetition_risk', 'unsupported_claim_risk'];
  const values = Object.fromEntries(scoreNames.map((name) => [name, Number(scoreSource[name])]));
  const scoresValid = scoreNames.every((name) => Number.isFinite(values[name]) && values[name] >= 0 && values[name] <= 1);
  const evaluatorDecision = rawEvaluation.decision;
  const evaluationPasses = scoresValid && evaluatorDecision === 'PUBLISHABLE' && values.context_fit >= (options.min_evaluation_score ?? 0.72) && values.usefulness >= (options.min_evaluation_score ?? 0.72) && values.naturalness >= (options.min_evaluation_score ?? 0.72) && values.marx_relevance >= (options.min_evaluation_score ?? 0.72) && values.spam_risk <= (options.max_spam_risk ?? 0.2) && values.repetition_risk <= (options.max_repetition_risk ?? 0.25) && values.unsupported_claim_risk <= (options.max_unsupported_claim_risk ?? 0.15);
  if (!evaluationPasses) { qa.passed = false; qa.reasons.push('EVALUATION_INVALID'); }
  const evaluation = {
    context_fit: scoresValid ? values.context_fit : 0, usefulness: scoresValid ? values.usefulness : 0, naturalness: scoresValid ? values.naturalness : 0, marx_relevance: scoresValid ? values.marx_relevance : 0, spam_risk: scoresValid ? values.spam_risk : 1, repetition_risk: scoresValid ? values.repetition_risk : 1, unsupported_claim_risk: scoresValid ? values.unsupported_claim_risk : 1, decision: qa.passed && evaluationPasses ? 'PUBLISHABLE' : 'NO_ACTION',
  };
  return { actionType, body, strategy, hook, qa, evaluation };
}

export function contextHash(post, account, replies, timeline) { return sha256({ post, account, replies, timeline }); }
