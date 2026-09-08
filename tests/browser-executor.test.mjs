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

test('executor requires the signed-in account control instead of arbitrary page text',()=>{
  const result=spawnSync('python3',['-c',`
import json, pathlib, runpy, tempfile
module=runpy.run_path('scripts/x-browser-executor.py')
execute=module['execute']
clock=[0.0]
module['time'].monotonic=lambda: clock[0]
module['time'].sleep=lambda seconds: clock.__setitem__(0, clock[0]+seconds)
class Api:
 def new_tab(self, url): pass
 def wait_for_load(self): pass
 def list_tabs(self): return [{'url':'https://x.com/builder/status/1','targetId':'tab'}]
 def switch_tab(self, target): pass
 def js(self, expression):
  if 'SideNav_AccountSwitcher_Button' in expression: return False
  return False
 def __getitem__(self, key): return getattr(self, key)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'request.json'
 req=dict(request_id='r',publisher_account='nullquanty',idempotency_key='i',action_hash='a'*64,request_hash='b'*64,action=dict(action_id='a',action_type='REPLY_DRAFT',body='exact body',target={'post_url':'https://x.com/builder/status/1'}),grant=dict(expires_at='2999-01-01T00:00:00Z'))
 p.write_text(json.dumps(req))
 result=execute(p, Api())
 assert result['status']=='FAILED', result
 assert result['error_code']=='BROWSER_EXECUTION_FAILED', result
 assert 'ELEMENT_OR_EVIDENCE_MISSING' in result['error_message'], result
`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('executor fails closed when the requested target tab cannot be selected',()=>{
  const result=spawnSync('python3',['-c',`
import json, pathlib, runpy, tempfile
module=runpy.run_path('scripts/x-browser-executor.py')
execute=module['execute']
class Api:
 def new_tab(self, url): pass
 def wait_for_load(self): pass
 def list_tabs(self): return [{'url':'https://x.com/other/status/2','targetId':'tab'}]
 def js(self, expression): raise AssertionError('identity must not run')
 def __getitem__(self, key): return getattr(self, key)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'request.json'
 req=dict(request_id='r',publisher_account='nullquanty',idempotency_key='i',action_hash='a'*64,request_hash='b'*64,action=dict(action_id='a',action_type='REPLY_DRAFT',body='exact body',target={'post_url':'https://x.com/builder/status/1'}),grant=dict(expires_at='2999-01-01T00:00:00Z'))
 p.write_text(json.dumps(req))
 result=execute(p, Api())
 assert result['status']=='FAILED', result
 assert 'TARGET_TAB_NOT_FOUND' in result['error_message'], result
`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});

test('executor refuses to submit when native input does not produce the exact body',()=>{
  const result=spawnSync('python3',['-c',`
import json, pathlib, runpy, tempfile
module=runpy.run_path('scripts/x-browser-executor.py')
execute=module['execute']
clock=[0.0]
module['time'].monotonic=lambda: clock[0]
module['time'].sleep=lambda seconds: clock.__setitem__(0, clock[0]+seconds)
class Api:
 def new_tab(self, url): pass
 def wait_for_load(self): pass
 def list_tabs(self): return [{'url':'https://x.com/builder/status/1','targetId':'tab'}]
 def switch_tab(self, target): pass
 def wait_for_load(self): pass
 def type_text(self, body): pass
 def js(self, expression):
  if 'SideNav_AccountSwitcher_Button' in expression: return True
  if 'e.focus()' in expression: return True
  if 'innerText ===' in expression: return False
  if 'tweetTextarea_0' in expression: return True
  return False
 def __getitem__(self, key): return getattr(self, key)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)/'request.json'
 req=dict(request_id='r',publisher_account='nullquanty',idempotency_key='i',action_hash='a'*64,request_hash='b'*64,action=dict(action_id='a',action_type='REPLY_DRAFT',body='exact body',target={'post_url':'https://x.com/builder/status/1'}),grant=dict(expires_at='2999-01-01T00:00:00Z'))
 p.write_text(json.dumps(req))
 result=execute(p, Api())
 assert result['status']=='FAILED', result
 assert result['error_code']=='BROWSER_EXECUTION_FAILED', result
 assert 'EXACT_BODY_NOT_VERIFIED' in result['error_message'], result
 assert not p.with_suffix('.submit-started').exists()
`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
});
