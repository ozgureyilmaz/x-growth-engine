import { access, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { DailyStore, withRunLock } from './daily-store.mjs';
import { XActionsMcpSource } from './daily-source.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CONFIG_PATH = path.join(ROOT, 'config/daily-experiment.json');

async function loadJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
function resolvePath(value) { return path.isAbsolute(value) ? value : path.join(ROOT, value); }
function commandPresent(command, args = ['--version']) { const result = spawnSync(command, args, { encoding: 'utf8', timeout: 10000 }); return !result.error && result.status === 0; }
function keychainPresent(service) { const account = String(spawnSync('/usr/bin/id', ['-un'], { encoding: 'utf8' }).stdout ?? '').trim(); if (!account) return false; const result = spawnSync('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service], { encoding: 'utf8', timeout: 10000 }); return result.status === 0; }

async function lockState(root) {
  try { const value = JSON.parse(await readFile(path.join(root, '.daily-run.lock', 'owner.json'), 'utf8')); const alive = Number.isInteger(value.pid) && spawnSync('kill', ['-0', String(value.pid)]).status === 0; return { present: true, alive, pid: value.pid, acquired_at: value.acquired_at }; } catch { return { present: false, alive: false }; }
}

export async function doctor(options = {}) {
  const config = options.config ?? await loadJson(CONFIG_PATH);
  const root = resolvePath(config.storage.root);
  const facts = config.facts_path ? await loadJson(resolvePath(config.facts_path)).catch(() => ({ facts: [] })) : { facts: [] };
  const checks = {
    node: process.versions.node,
    sqlite3: commandPresent('sqlite3'),
    codex: commandPresent(config.codex.binary ?? 'codex', ['--version']),
    codex_login: commandPresent(config.codex.binary ?? 'codex', ['login', 'status']),
    xactions_wrapper: await access(config.source.command).then(() => true).catch(() => false),
    comet: await access('/Applications/Comet.app/Contents/MacOS/Comet').then(() => true).catch(() => false),
    xactions_auth_token_present: keychainPresent('xactions-auth-token'),
    xactions_csrf_token_present: keychainPresent('xactions-csrf-token'),
    approved_marx_facts: Array.isArray(facts.facts) ? facts.facts.filter((fact) => fact.status === 'APPROVED').length : 0,
    publisher_disabled: config.publisher.enabled === false && config.publisher.mode === 'MANUAL_ONLY' && config.publisher.kill_switch === true,
    publisher_active: config.publisher.enabled === true && config.publisher.mode === 'AUTOMATIC' && config.publisher.kill_switch === false,
    lock: await lockState(root),
  };
  checks.lock_healthy = !checks.lock.present || checks.lock.alive;
  checks.facts_ready = checks.approved_marx_facts > 0;
  if (options.liveRead) {
    const source = new XActionsMcpSource({ command: process.env.XGE_XACTIONS_MCP_COMMAND ?? config.source.command, args: config.source.args, platform: config.source.platform, readTools: config.source.read_tools, callTimeoutMs: config.discovery.call_timeout_ms });
    try { checks.live_read_preflight = await source.preflight(`the lang:en since:${new Date(Date.now() - config.discovery.lookback_hours * 3600000).toISOString().slice(0, 10)}`); } catch (error) { checks.live_read_preflight = { status: 'failed', error: error instanceof Error ? error.message : String(error) }; } finally { await source.close().catch(() => undefined); }
  }
  if (options.auto) {
    checks.hermes_binary=commandPresent(process.env.HERMES_BIN||'hermes',['--help']);
    checks.hermes_skill=await access(path.join(ROOT,'hermes/skills/x-growth-publisher/SKILL.md')).then(()=>true).catch(()=>false);
    checks.hermes_model='gpt-5.6-luna'; checks.hermes_reasoning_effort='xhigh';
    checks.publisher_preflight=checks.hermes_binary&&checks.hermes_skill?{status:'passed',transport:'hermes_cli',model:checks.hermes_model,reasoning_effort:checks.hermes_reasoning_effort,skill:'x-growth-publisher'}:{status:'failed',error:checks.hermes_binary?'HERMES_SKILL_MISSING':'HERMES_BINARY_MISSING'};
  }
  const required = ['sqlite3', 'codex', 'codex_login', 'xactions_wrapper', 'lock_healthy', 'facts_ready'];
  if (options.auto) required.push('publisher_active'); else required.push('publisher_disabled');
  const ok = required.every((key) => checks[key] === true) && (!options.liveRead || checks.live_read_preflight?.status === 'passed') && (!options.auto || checks.publisher_preflight?.status === 'passed');
  return { status: ok ? 'PASS' : 'DEGRADED', checks, next: ok ? 'ready_for_selected_run_mode' : 'resolve_failed_checks_before_live_run' };
}

export async function recover(runId, options = {}) {
  if (!runId) throw new Error('RECOVER_REQUIRES_RUN_ID');
  const config = options.config ?? await loadJson(CONFIG_PATH);
  const root = resolvePath(config.storage.root);
  const lock = await lockState(root);
  if (lock.present && lock.alive) throw new Error(`DAILY_RUN_LOCKED_BY_LIVE_PID:${lock.pid}`);
  if (lock.present) await rm(path.join(root, '.daily-run.lock'), { recursive: true, force: true });
  const store = new DailyStore(resolvePath(config.storage.database), resolvePath(config.storage.events));
  await withRunLock(root, async () => { await store.markInterrupted(runId, 'OWNER_NOT_ALIVE'); await store.markClaimedForReconciliation(runId); });
  return { status: 'recovered', run_id: runId, previous_lock: lock, new_state: 'INTERRUPTED' };
}

export async function status(runId, options = {}) {
  const config = options.config ?? await loadJson(CONFIG_PATH);
  const store = new DailyStore(resolvePath(config.storage.database), resolvePath(config.storage.events));
  const selected = runId ?? (await store.latestRun())?.run_id;
  if (!selected) return { status: 'NO_RUNS' };
  return { status: 'ok', ...(await store.status(selected)) };
}

export async function verifyV1(options = {}) {
  const config = options.config ?? await loadJson(CONFIG_PATH);
  const store = new DailyStore(resolvePath(config.storage.database), resolvePath(config.storage.events));
  const gate = await store.v1Gate();
  const facts = config.facts_path ? await loadJson(resolvePath(config.facts_path)).catch(() => ({ facts: [] })) : { facts: [] };
  const factsApproved = Array.isArray(facts.facts) && facts.facts.some((fact) => fact.status === 'APPROVED');
  return { status: gate.status === 'PASS' && factsApproved ? 'PASS' : 'INCOMPLETE', gate, approved_facts: factsApproved };
}

export async function retention(options = {}) {
  const config = options.config ?? await loadJson(CONFIG_PATH);
  const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
  const store = new DailyStore(resolvePath(config.storage.database), resolvePath(config.storage.events));
  if (options.apply) { await store.purgeRaw(cutoff); return { status: 'APPLIED', cutoff, retained: 'provider IDs, hashes, timestamps, and audit metadata' }; }
  return { status: 'DRY_RUN', cutoff, next: 'rerun with --apply to purge raw post/account payloads' };
}
