"""Execute inside Hermes browser_exec with Browser Use's documented helpers.

The caller supplies XGE_REQUEST_PATH. Never generate browser code per action.
The submit marker is persisted BEFORE the click; an uncertain request cannot
be submitted again, even if Hermes restarts. Receipts use the engine contract.
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


def execute(request_path, api):
    request_path = Path(request_path).resolve()
    req = json.loads(request_path.read_text())
    action = req['action']
    journal = request_path.with_suffix('.execution.json')
    marker = request_path.with_suffix('.submit-started')
    phase = 'VALIDATED'
    def record(stage):
        nonlocal phase
        phase = stage
        temporary = journal.with_suffix('.tmp')
        with temporary.open('w') as stream:
            json.dump({'request_id': req['request_id'], 'request_hash': req['request_hash'], 'phase': stage}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(journal)

    def receipt(status, code=None, message=None, permalink=None):
        result = {k: req[k] for k in ('request_id', 'publisher_account', 'idempotency_key', 'action_hash', 'request_hash')}
        result.update(schema_version='2.0', message_type='X_PUBLICATION_RECEIPT', action_id=action['action_id'], status=status, observed_at=datetime.now(timezone.utc).isoformat())
        if code:
            result.update(error_code=code, error_message=f'{phase}: {message or code}')
        if permalink:
            result.update(provider_id=permalink.rsplit('/', 1)[1], permalink=permalink)
        return result

    def probe(expression, seconds=45):
        deadline = time.monotonic() + seconds
        while True:
            value = api['js'](expression)
            if value:
                return value
            if time.monotonic() >= deadline:
                raise RuntimeError('ELEMENT_OR_EVIDENCE_MISSING')
            time.sleep(.5)

    def click(selector):
        probe('''(() => {const e=document.querySelector(%s);if(!e)return false;e.scrollIntoView({block:'center',behavior:'instant'});return true})()''' % json.dumps(selector))
        time.sleep(.5)
        point = probe('''(() => {const nodes=[...document.querySelectorAll(%s)];
          const el=nodes.find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'});
          if(!el)return null;const r=el.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;
          if(!el.contains(document.elementFromPoint(x,y)))return null;return {x,y};})()''' % json.dumps(selector))
        api['click_at_xy'](point['x'], point['y'])

    def js_click(selector, text=None):
        expression = """(() => {const nodes=[...document.querySelectorAll(%s)];const el=nodes.find(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'%s});if(!el)return false;el.click();return true})()""" % (json.dumps(selector), (f" && (e.innerText||'').trim()==={json.dumps(text)}" if text is not None else ''))
        if not api['js'](expression):
            raise RuntimeError('CONTROL_NOT_ACTIVATED')

    def identity():
        # A mention in a feed or profile title is not signed-in identity.
        return probe("(() => {const e=document.querySelector('[data-testid=\"SideNav_AccountSwitcher_Button\"]');return e && /(^|\\s)@nullquanty($|\\s)/i.test(e.innerText)})()")

    def evidence():
        return api['js']('''(() => {const wanted=%s;const matches=[];
          for(const a of document.querySelectorAll('article')) {
            const t=a.querySelector('[data-testid="tweetText"]');
            if(!t||t.innerText!==wanted)continue;
            const link=[...a.querySelectorAll('a[href]')].find(l=>/^\\/nullquanty\\/status\\/\\d+$/.test(l.getAttribute('href')));
            if(link)matches.push(link.href);
          } return [...new Set(matches)];})()''' % json.dumps(action['body']))

    try:
        if marker.exists():
            return receipt('RECONCILIATION_REQUIRED', 'SUBMISSION_ALREADY_STARTED')
        if req['publisher_account'] != 'nullquanty' or action['action_type'] not in ('REPLY_DRAFT', 'QUOTE_DRAFT'):
            return receipt('FAILED', 'UNSUPPORTED_ACTION')
        if datetime.fromisoformat(req['grant']['expires_at'].replace('Z', '+00:00')) <= datetime.now(timezone.utc):
            return receipt('FAILED', 'PUBLICATION_GRANT_EXPIRED')
        record('VALIDATED')
        api['new_tab'](action['target']['post_url'])
        api['wait_for_load']()
        identity()
        record('ACCOUNT_VERIFIED')
        # Use X's inline reply textbox, scoped to the target conversation.
        if action['action_type'] == 'QUOTE_DRAFT':
            if not api['js']("document.querySelector('[data-testid=\"tweetTextarea_0\"]')"):
                js_click('[data-testid="retweet"]')
                record('RETWEET_MENU_OPENED')
                js_click('[role="menuitem"]', 'Quote')
                record('QUOTE_COMPOSER_OPENED')
                time.sleep(1)
                try:
                    tabs=api['list_tabs']()
                    compose=next((t for t in tabs if '/compose/post' in str(t.get('url',''))),None)
                    if compose: api['switch_tab'](compose.get('targetId') or compose.get('target_id'))
                except Exception:
                    pass
        elif not api['js']("document.querySelector('[data-testid=\"tweetTextarea_0\"]')"):
            js_click('[data-testid="reply"]')
            record('REPLY_CONTROL_CLICKED')
        probe("document.querySelector('[data-testid=\"tweetTextarea_0\"]') !== null")
        record('COMPOSER_FOUND')
        api['fill_input']('[data-testid="tweetTextarea_0"]', action['body'], True, 15)
        record('BODY_INSERTED')
        probe("document.querySelector('[data-testid=\"tweetTextarea_0\"]').innerText.trim() === " + json.dumps(action['body']))
        record('COMPOSER_READY')
        identity()
        if datetime.fromisoformat(req['grant']['expires_at'].replace('Z', '+00:00')) <= datetime.now(timezone.utc):
            return receipt('FAILED', 'PUBLICATION_GRANT_EXPIRED')
        # O_EXCL prevents two executions of the same request from submitting.
        descriptor = os.open(marker, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.write(descriptor, req['request_hash'].encode())
        os.fsync(descriptor)
        os.close(descriptor)
        record('SUBMIT_STARTED')
        if not api['js']("(() => {const xs=[...document.querySelectorAll('[data-testid=\"tweetButtonInline\"],[data-testid=\"tweetButton\"]')];const e=xs.find(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0&&!x.disabled&&x.getAttribute('aria-disabled')!=='true'});if(!e)return false;e.click();return true})()"):
            raise RuntimeError('SUBMIT_CONTROL_NOT_ACTIVATED')
        record('SUBMIT_RETURNED')
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            links = evidence()
            if len(links) == 1:
                api['goto_url'](links[0])
                api['wait_for_load']()
                time.sleep(2)
                if evidence() == links:
                    record('READBACK_VERIFIED')
                    return receipt('PUBLISHED', permalink=links[0])
            time.sleep(1)
        api['new_tab']('https://x.com/nullquanty/with_replies')
        api['wait_for_load']()
        time.sleep(3)
        links=evidence()
        if len(links)==1:
            record('READBACK_VERIFIED')
            return receipt('PUBLISHED', permalink=links[0])
        return receipt('RECONCILIATION_REQUIRED', 'READBACK_MISSING')
    except Exception as error:
        # Only exception type is retained; browser errors can contain secrets.
        return receipt('RECONCILIATION_REQUIRED' if marker.exists() else 'FAILED', 'BROWSER_EXECUTION_FAILED', type(error).__name__)


if 'XGE_REQUEST_PATH' in globals():
    print(json.dumps(execute(XGE_REQUEST_PATH, globals()), ensure_ascii=False))
