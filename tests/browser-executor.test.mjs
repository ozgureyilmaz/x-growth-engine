import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {normalizeHermesReceipt} from '../scripts/hermes-x-publisher.mjs';

test('legacy failure_reason is preserved without changing outcome or relaxing identity validation',()=>{
  const value={schema_version:'2.0',message_type:'X_PUBLICATION_RECEIPT',request_id:'r',action_id:'a',publisher_account:'nullquanty',idempotency_key:'i',action_hash:'a'.repeat(64),request_hash:'b'.repeat(64),status:'RECONCILIATION_REQUIRED',observed_at:'2026-09-06T20:00:00Z',failure_reason:'INTERRUPTED'};
  const result=normalizeHermesReceipt(value);
  assert.equal(result.status,'RECONCILIATION_REQUIRED');
  assert.equal(result.error_message,'INTERRUPTED');
  assert.throws(()=>normalizeHermesReceipt({...value,action_id:null}));
  assert.throws(()=>normalizeHermesReceipt({...value,extra:'unexpected'}));
});

test('executor refuses expired grants and any request with a durable submit marker',()=>{
  const result=spawnSync('python3',['-c',`
import runpy, tempfile, pathlib, json
execute=runpy.run_path('scripts/x-browser-executor.py')['execute']
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'request.json'
 req=dict(request_id='r',publisher_account='nullquanty',idempotency_key='i',action_hash='a'*64,request_hash='b'*64,action=dict(action_id='a',action_type='REPLY_DRAFT'),grant=dict(expires_at='2000-01-01T00:00:00Z'))
 p.write_text(json.dumps(req))
 assert execute(p,{})['error_code']=='PUBLICATION_GRANT_EXPIRED'
 p.with_suffix('.submit-started').write_text('b'*64)
 assert execute(p,{})['status']=='RECONCILIATION_REQUIRED'
 assert execute(p,{})['error_code']=='SUBMISSION_ALREADY_STARTED'
`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
