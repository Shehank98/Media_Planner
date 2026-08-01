// Benchmark the configured providers on a real brief (Section 8).
//
//   npm run bench -- --brief 3 --providers gemini,ollama --runs 2
//
// Prints wall-clock time and tokens/sec per run so the Phase 2 model choice is
// made on measurements from your hardware rather than on a guess.

import { getBrief } from '../src/services/briefRepo.js';
import { buildAggregatedData } from '../src/services/aggregate.js';
import { analyzeAndRecommend } from '../src/llm/index.js';
import { config } from '../src/config.js';
import { close } from '../src/db.js';

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const briefId = Number(arg('brief'));
const providers = String(arg('providers', config.llm.provider)).split(',').map((s) => s.trim());
const runs = Number(arg('runs', 1));

if (!Number.isFinite(briefId)) {
  console.error('Usage: npm run bench -- --brief <id> [--providers gemini,ollama] [--runs 2]');
  process.exit(1);
}

const brief = await getBrief(briefId);
if (!brief) {
  console.error(`Brief ${briefId} not found. Upload and confirm a brief first.`);
  await close();
  process.exit(1);
}

console.log(`\nBenchmarking brief ${briefId} - ${brief.brand ?? '(no brand)'}\n`);
const aggregated = await buildAggregatedData(brief);
console.log(
  `Payload: ${aggregated.competitor_spend_by_quarter.length} competitor rows, ` +
  `${aggregated.programme_ratings.length} programme rows, ` +
  `${(JSON.stringify(aggregated).length / 1024).toFixed(1)} KB\n`,
);

const results = [];
for (const provider of providers) {
  for (let run = 1; run <= runs; run += 1) {
    process.stdout.write(`  ${provider} run ${run}/${runs}... `);
    const started = Date.now();
    try {
      const out = await analyzeAndRecommend(brief, aggregated, { provider });
      const wall = Date.now() - started;
      results.push({
        provider,
        run,
        model: out.meta.model,
        wall_ms: wall,
        model_ms: out.meta.elapsed_ms,
        tokens_per_sec: out.meta.tokens_per_sec,
        output_tokens: out.meta.output_tokens,
        lineup: out.recommended_lineup.length,
        confidence: out.confidence,
        ungrounded: out.grounding?.unmatched?.length ?? 0,
      });
      console.log(`${(wall / 1000).toFixed(1)}s`);
    } catch (err) {
      results.push({ provider, run, error: err.message });
      console.log(`FAILED - ${err.message}`);
    }
  }
}

console.log('\nResults\n');
console.table(results);
console.log(
  '\nRationale quality is not measurable here - read the actual output before\n' +
  'choosing. Speed only tells you what is tolerable, not what is good enough\n' +
  'for a client-facing report.\n',
);

await close();
