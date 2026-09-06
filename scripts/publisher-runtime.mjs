import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

function browserUseCommand() {
  return process.env.BROWSER_USE_BIN || '/Users/0x79de/.hermes/bin/browser-use';
}

function httpVersionUrl(cdpUrl) {
  const url = new URL(cdpUrl);
  if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) throw new Error('CDP_URL_INVALID');
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  url.pathname = '/json/version';
  url.search = '';
  url.hash = '';
  return url;
}

async function probeCdp(cdpUrl, timeoutMs) {
  const endpoint = httpVersionUrl(cdpUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`CDP_HTTP_${response.status}`);
    const value = await response.json();
    if (!value?.webSocketDebuggerUrl) throw new Error('CDP_WS_MISSING');
    return { status: 'passed', endpoint: endpoint.origin, browser: String(value.Browser ?? '') };
  } catch (error) {
    const message = error?.name === 'AbortError' ? 'CDP_HEALTH_TIMEOUT' : String(error?.message || error);
    throw new Error(message);
  } finally {
    clearTimeout(timer);
  }
}

export async function checkPublisherRuntime(config = {}) {
  const browser = config.publisher?.browser ?? {};
  const cdpUrl = process.env.XGE_CDP_WS || browser.cdp_url;
  const result = {
    status: 'passed',
    backend: browser.backend ?? 'browser-use',
    profile: browser.profile ?? 'Default',
    expected_account: browser.expected_account ?? 'nullquanty',
    cdp: { required: browser.require_health === true, configured: Boolean(cdpUrl) },
  };
  if (result.backend !== 'browser-use') throw new Error('BROWSER_BACKEND_UNSUPPORTED');
  if (browser.require_health !== true) return result;
  if (!cdpUrl) throw new Error('CDP_ENDPOINT_REQUIRED');
  result.cdp = { ...result.cdp, ...(await probeCdp(cdpUrl, browser.health_timeout_ms ?? 10000)) };
  const command = browserUseCommand();
  const executable = existsSync(command) ? command : 'browser-use';
  const version = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: browser.health_timeout_ms ?? 10000 });
  if (version.error || version.status !== 0) throw new Error('BROWSER_USE_BINARY_UNAVAILABLE');
  result.browser_use = String(version.stdout || version.stderr || '').trim().slice(0, 160);
  const health = spawnSync(executable, [], {
    input: `import time,json\nnew_tab("https://x.com/home")\nwait_for_load()\ndeadline=time.monotonic()+30\naccount=False\nwhile time.monotonic()<deadline:\n    account=js("(() => {const e=document.querySelector('[data-testid=\\\"SideNav_AccountSwitcher_Button\\\"]');return !!e && /(^|\\\\s)@nullquanty($|\\\\s)/i.test(e.innerText)})()")\n    if account: break\n    time.sleep(.5)\nprint(json.dumps({"account": "nullquanty" if account else None}))\n`,
    encoding: 'utf8',
    timeout: 45000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BU_CDP_WS: cdpUrl, BU_NAME: `xge_health_${process.pid}` },
  });
  const healthOutput = `${health.stdout ?? ''}\n${health.stderr ?? ''}`;
  if (health.error || health.status !== 0) throw new Error('BROWSER_USE_HEALTH_FAILED');
  if (!healthOutput.includes('"account": "nullquanty"')) throw new Error('BROWSER_ACCOUNT_MISMATCH');
  result.account = browser.expected_account;
  return result;
}

export function publisherRuntimeEnv(config = {}) {
  const browser = config.publisher?.browser ?? {};
  const cdpUrl = process.env.XGE_CDP_WS || browser.cdp_url;
  return {
    ...(cdpUrl ? { BU_CDP_WS: cdpUrl, BROWSER_CDP_URL: cdpUrl, XGE_CDP_WS: cdpUrl } : {}),
    BU_NAME: `xpub_worker_${process.pid}`,
  };
}

export { httpVersionUrl, probeCdp };
