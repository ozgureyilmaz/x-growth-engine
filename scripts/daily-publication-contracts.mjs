import { z } from 'zod';
import { DraftSchema, sha256, stableStringify } from './daily-contracts.mjs';
import { draftActionHash } from './daily-intelligence.mjs';

export const PublicationRequestSchema = z.object({
  schema_version: z.literal('1.0'),
  message_type: z.literal('X_PUBLICATION_REQUEST'),
  request_id: z.string().min(1),
  action: DraftSchema,
  publisher_account: z.literal('nullquanty'),
  idempotency_key: z.string().min(1),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  approval: z.object({ decision: z.literal('APPROVED'), approver_id: z.string().min(1), decided_at: z.string().datetime({ offset: true }), action_hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  grant: z.object({ grant_id: z.string().min(1), publisher_account: z.literal('nullquanty'), expires_at: z.string().datetime({ offset: true }), max_actions: z.number().int().positive() }).strict(),
  created_at: z.string().datetime({ offset: true }),
}).strict();

export const PublicationReceiptSchema = z.object({
  schema_version: z.literal('1.0'),
  message_type: z.literal('X_PUBLICATION_RECEIPT'),
  request_id: z.string().min(1),
  action_id: z.string().min(1),
  publisher_account: z.literal('nullquanty'),
  idempotency_key: z.string().min(1),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['PUBLISHED', 'FAILED', 'RETRYABLE', 'RECONCILIATION_REQUIRED']),
  provider_id: z.string().min(1).optional(),
  permalink: z.string().url().optional(),
  observed_at: z.string().datetime({ offset: true }),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
}).strict();

const GrantSchema = z.object({
  grant_id: z.string().min(1),
  publisher_account: z.literal('nullquanty'),
  expires_at: z.string().datetime({ offset: true }),
  max_actions: z.number().int().positive(),
}).strict();

export const AutoPublicationRequestSchema = z.object({
  schema_version: z.literal('2.0'),
  message_type: z.literal('X_PUBLICATION_REQUEST'),
  request_id: z.string().min(1),
  run_id: z.string().min(1),
  action: DraftSchema,
  publisher_account: z.literal('nullquanty'),
  idempotency_key: z.string().min(1),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  authorization: z.object({
    mode: z.literal('AUTOMATED_POLICY'),
    policy_version: z.string().min(1),
    policy_hash: z.string().regex(/^[a-f0-9]{64}$/),
    evaluated_at: z.string().datetime({ offset: true }),
  }).strict(),
  grant: GrantSchema,
  created_at: z.string().datetime({ offset: true }),
}).strict();

export const AutoPublicationReceiptSchema = z.object({
  schema_version: z.literal('2.0'),
  message_type: z.literal('X_PUBLICATION_RECEIPT'),
  request_id: z.string().min(1),
  action_id: z.string().min(1),
  publisher_account: z.literal('nullquanty'),
  idempotency_key: z.string().min(1),
  action_hash: z.string().regex(/^[a-f0-9]{64}$/),
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['PUBLISHED', 'FAILED', 'RECONCILIATION_REQUIRED']),
  provider_id: z.string().min(1).optional(),
  permalink: z.string().url().optional(),
  observed_at: z.string().datetime({ offset: true }),
  error_code: z.string().optional(),
  error_message: z.string().optional(),
}).strict();

export function requestHash(requestWithoutHash) { return sha256(stableStringify(requestWithoutHash)); }

export function buildPublicationRequest(action, approval, grant, now = new Date()) {
  const validAction = DraftSchema.parse(action);
  if (validAction.action_hash !== draftActionHash(validAction)) throw new Error('PUBLICATION_ACTION_HASH_INVALID');
  if (approval?.decision !== 'APPROVED' || approval.action_hash !== validAction.action_hash) throw new Error('PUBLICATION_APPROVAL_REQUIRED');
  if (grant?.publisher_account !== 'nullquanty' || Date.parse(grant.expires_at) <= now.getTime()) throw new Error('PUBLICATION_GRANT_INVALID');
  const material = { schema_version: '1.0', message_type: 'X_PUBLICATION_REQUEST', request_id: `pubreq_${validAction.action_id}`, action: validAction, publisher_account: 'nullquanty', idempotency_key: `x:publish:v1:${validAction.action_id}`, action_hash: validAction.action_hash, approval, grant, created_at: now.toISOString() };
  return PublicationRequestSchema.parse({ ...material, request_hash: requestHash(material) });
}

export function buildAutoPublicationRequest(action, policy, grant, now = new Date(), runId = 'automatic') {
  const validAction = DraftSchema.parse(action);
  if (validAction.action_hash !== draftActionHash(validAction)) throw new Error('PUBLICATION_ACTION_HASH_INVALID');
  if (policy?.decision !== 'ALLOW' || policy.action_hash !== validAction.action_hash) throw new Error('PUBLICATION_POLICY_REQUIRED');
  if (grant?.publisher_account !== 'nullquanty' || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= now.getTime()) throw new Error('PUBLICATION_GRANT_INVALID');
  const material = {
    schema_version: '2.0',
    message_type: 'X_PUBLICATION_REQUEST',
    request_id: `pubreq_${validAction.action_id}`,
    run_id: String(runId),
    action: validAction,
    publisher_account: 'nullquanty',
    idempotency_key: `x:publish:v2:${validAction.action_id}`,
    action_hash: validAction.action_hash,
    authorization: { mode: 'AUTOMATED_POLICY', policy_version: policy.policy_version, policy_hash: policy.policy_hash, evaluated_at: now.toISOString() },
    grant,
    created_at: now.toISOString(),
  };
  return AutoPublicationRequestSchema.parse({ ...material, request_hash: requestHash(material) });
}

export function verifyReceipt(request, receipt) {
  const validRequest = PublicationRequestSchema.parse(request);
  const validReceipt = PublicationReceiptSchema.parse(receipt);
  const { request_hash: ignoredRequestHash, ...requestMaterial } = validRequest;
  if (requestHash(requestMaterial) !== validRequest.request_hash) throw new Error('PUBLICATION_REQUEST_HASH_INVALID');
  if (validRequest.action_hash !== draftActionHash(validRequest.action) || validRequest.approval.action_hash !== validRequest.action_hash) throw new Error('PUBLICATION_ACTION_HASH_INVALID');
  if (validRequest.publisher_account !== validRequest.grant.publisher_account) throw new Error('PUBLICATION_GRANT_ACCOUNT_MISMATCH');
  if (validReceipt.request_id !== validRequest.request_id || validReceipt.action_id !== validRequest.action.action_id || validReceipt.publisher_account !== validRequest.publisher_account || validReceipt.idempotency_key !== validRequest.idempotency_key || validReceipt.action_hash !== validRequest.action_hash || validReceipt.request_hash !== validRequest.request_hash) throw new Error('PUBLICATION_RECEIPT_BINDING_MISMATCH');
  if (validReceipt.status === 'PUBLISHED' && (!validReceipt.provider_id || !validReceipt.permalink)) throw new Error('PUBLISHED_RECEIPT_MISSING_READBACK');
  return validReceipt;
}

export function verifyAutoReceipt(request, receipt) {
  const validRequest = AutoPublicationRequestSchema.parse(request);
  const validReceipt = AutoPublicationReceiptSchema.parse(receipt);
  const { request_hash: ignoredRequestHash, ...requestMaterial } = validRequest;
  if (requestHash(requestMaterial) !== validRequest.request_hash) throw new Error('PUBLICATION_REQUEST_HASH_INVALID');
  if (validRequest.action_hash !== draftActionHash(validRequest.action)) throw new Error('PUBLICATION_ACTION_HASH_INVALID');
  if (validRequest.publisher_account !== validRequest.grant.publisher_account) throw new Error('PUBLICATION_GRANT_ACCOUNT_MISMATCH');
  if (validReceipt.request_id !== validRequest.request_id || validReceipt.action_id !== validRequest.action.action_id || validReceipt.publisher_account !== validRequest.publisher_account || validReceipt.idempotency_key !== validRequest.idempotency_key || validReceipt.action_hash !== validRequest.action_hash || validReceipt.request_hash !== validRequest.request_hash) throw new Error('PUBLICATION_RECEIPT_BINDING_MISMATCH');
  if (validReceipt.status === 'PUBLISHED' && (!validReceipt.provider_id || !validReceipt.permalink)) throw new Error('PUBLISHED_RECEIPT_MISSING_READBACK');
  return validReceipt;
}
