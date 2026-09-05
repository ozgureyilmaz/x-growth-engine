import { canonicalPostUrl, postIdFromUrl, sha256, stableStringify } from './daily-contracts.mjs';
import { draftActionHash } from './daily-intelligence.mjs';

export const AUTO_POLICY_VERSION = 'v2.0';
const AUTO_ACTION_TYPES = new Set(['POST_DRAFT', 'REPLY_DRAFT', 'QUOTE_DRAFT']);

function policyMaterial(config) {
  return {
    version: AUTO_POLICY_VERSION,
    account: config.account,
    write_tools: Object.fromEntries(Object.entries(config.publisher.write_tools ?? {}).sort(([left], [right]) => left.localeCompare(right))),
    max_actions_per_run: config.publisher.max_actions_per_run,
    intelligence: {
      min_evaluation_score: config.intelligence.min_evaluation_score,
      max_spam_risk: config.intelligence.max_spam_risk,
      max_repetition_risk: config.intelligence.max_repetition_risk,
      max_unsupported_claim_risk: config.intelligence.max_unsupported_claim_risk,
    },
    content: {
      max_chars: config.content.max_chars,
      marx_mentions: config.content.marx_mentions,
      links_allowed: config.content.links_allowed,
      ctas_allowed: config.content.ctas_allowed,
      hashtags_allowed: config.content.hashtags_allowed,
    },
  };
}

function approvedFactIds(facts = [], now) {
  return new Set(facts.filter((fact) => fact?.status === 'APPROVED' && Date.parse(fact.expires_at) > now.getTime()).map((fact) => fact.fact_id));
}

function addTargetReasons(action, reasons) {
  if (action.action_type === 'POST_DRAFT') return;
  const target = action.target ?? {};
  if (!target.post_url || !target.username) {
    reasons.push('TARGET_REQUIRED');
    return;
  }
  try {
    const canonical = canonicalPostUrl(target.post_url);
    if (canonical !== target.post_url) reasons.push('TARGET_URL_NOT_CANONICAL');
    if (target.post_id && target.post_id !== postIdFromUrl(canonical)) reasons.push('TARGET_ID_MISMATCH');
  } catch {
    reasons.push('TARGET_URL_INVALID');
  }
}

function addFreshnessReasons(action, sourceContext, config, now, reasons) {
  if (!sourceContext?.post) return;
  const timestamp = Date.parse(sourceContext.post.timestamp);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime()) {
    reasons.push('SOURCE_TIMESTAMP_INVALID');
    return;
  }
  if (now.getTime() - timestamp > config.discovery.lookback_hours * 3600000) reasons.push('SOURCE_EVIDENCE_STALE');
}

export function evaluatePublicationPolicy(action, config, options = {}) {
  const now = options.now ?? new Date();
  const publisher = config.publisher ?? {};
  const reasons = [];
  const allowedTypes = new Set(Object.keys(publisher.write_tools ?? {}).filter((type) => AUTO_ACTION_TYPES.has(type)));
  const actionHash = (() => { try { return draftActionHash(action); } catch { return ''; } })();
  const policyHash = sha256(policyMaterial(config));

  if (publisher.enabled !== true) reasons.push('PUBLISHER_DISABLED');
  if (publisher.mode !== 'AUTOMATIC') reasons.push('PUBLISHER_MODE_NOT_AUTOMATIC');
  if (publisher.kill_switch === true) reasons.push('PUBLISHER_KILL_SWITCH_ENGAGED');
  if (action.publisher_account !== config.account || action.publisher_account !== 'nullquanty') reasons.push('PUBLISHER_ACCOUNT_MISMATCH');
  if (!allowedTypes.has(action.action_type)) reasons.push('ACTION_TYPE_NOT_ALLOWLISTED');
  if (!actionHash || action.action_hash !== actionHash) reasons.push('ACTION_HASH_INVALID');
  if (action.body_hash !== sha256(action.body)) reasons.push('BODY_HASH_INVALID');
  if (action.qa?.passed !== true || (action.qa?.reasons?.length ?? 0) > 0) reasons.push('DETERMINISTIC_QA_FAILED');

  const evaluation = action.evaluation ?? {};
  const minScore = config.intelligence.min_evaluation_score;
  if (evaluation.decision !== 'PUBLISHABLE') reasons.push('EVALUATION_NOT_PUBLISHABLE');
  for (const key of ['context_fit', 'usefulness', 'naturalness', 'marx_relevance']) if (!(Number(evaluation[key]) >= minScore)) reasons.push(`EVALUATION_${key.toUpperCase()}_LOW`);
  if (!(Number(evaluation.spam_risk) <= config.intelligence.max_spam_risk)) reasons.push('SPAM_RISK_HIGH');
  if (!(Number(evaluation.repetition_risk) <= config.intelligence.max_repetition_risk)) reasons.push('REPETITION_RISK_HIGH');
  if (!(Number(evaluation.unsupported_claim_risk) <= config.intelligence.max_unsupported_claim_risk)) reasons.push('UNSUPPORTED_CLAIM_RISK_HIGH');

  const factIds = new Set(action.fact_ids ?? []);
  if (!options.allowFixture && !factIds.size) reasons.push('FACT_REGISTRY_REQUIRED');
  const facts = approvedFactIds(options.facts, now);
  for (const factId of factIds) if (!facts.has(factId)) reasons.push('FACT_NOT_APPROVED_OR_EXPIRED');
  addTargetReasons(action, reasons);
  addFreshnessReasons(action, options.sourceContext, config, now, reasons);

  const priorActions = options.priorActions ?? [];
  if (priorActions.some((previous) => previous.action_hash === action.action_hash || (previous.body_hash === action.body_hash && stableStringify(previous.target ?? {}) === stableStringify(action.target ?? {})))) reasons.push('DUPLICATE_ACTION');
  const attempted = Number(options.attempted ?? 0);
  const maxActions = Number(options.maxActions ?? publisher.max_actions_per_run ?? 0);
  if (attempted >= maxActions) reasons.push('PUBLISH_CAP_REACHED');

  return { decision: reasons.length ? 'BLOCK' : 'ALLOW', policy_version: AUTO_POLICY_VERSION, policy_hash: policyHash, action_hash: action.action_hash, reasons: [...new Set(reasons)] };
}
