import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DailyStore, withRunLock } from './daily-store.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CONFIG_PATH = path.join(ROOT, 'config/daily-experiment.json');

async function loadJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

export async function importFounderReviews(file, options = {}) {
  const config = options.config ?? await loadJson(CONFIG_PATH);
  const input = await loadJson(file);
  const decisions = Array.isArray(input) ? input : input.reviews;
  if (!Array.isArray(decisions) || !decisions.length) throw new Error('FOUNDER_REVIEW_FILE_EMPTY');
  const store = new DailyStore(options.database ?? path.join(ROOT, config.storage.database), options.events ?? path.join(ROOT, config.storage.events));
  return withRunLock(path.dirname(store.database), async () => {
    let imported = 0;
    for (const decision of decisions) { await store.saveReviewDecision({ ...decision, reviewed_at: decision.reviewed_at ?? new Date().toISOString() }); imported += 1; }
    return { status: 'ok', imported, publisher_enabled: false };
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const fileAt = process.argv.indexOf('--file');
    if (fileAt < 0 || !process.argv[fileAt + 1]) throw new Error('usage: node scripts/review.mjs --file <founder-review-decision.json>');
    console.log(JSON.stringify(await importFounderReviews(path.resolve(process.argv[fileAt + 1]))));
  } catch (error) {
    console.error(JSON.stringify({ status: 'error', error: error instanceof Error ? error.message : String(error), publisher_enabled: false }));
    process.exitCode = 1;
  }
}
