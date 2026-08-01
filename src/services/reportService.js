import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { config, ROOT } from '../config.js';
import { log } from '../util/logger.js';
import { getPlan } from './planService.js';
import { getBrief } from './briefRepo.js';

// ---------------------------------------------------------------------------
// PDF generation (Section 6).
//
// The charts are matplotlib and the layout is reportlab, so the renderer is
// Python and Node drives it as a subprocess. The worker gets a JSON payload on
// disk and no database credentials - it can only draw what has already been
// stored on the plan, which keeps the PDF and the audit trail in agreement.
// ---------------------------------------------------------------------------

const SCRIPT = path.join(ROOT, 'report', 'build_report.py');

/**
 * Render the PDF for a stored plan.
 *
 * @returns {Promise<{path: string, cleanup: () => Promise<void>, filename: string}>}
 */
export async function generateReport(planId) {
  const plan = await getPlan(planId);
  if (!plan) throw Object.assign(new Error(`Plan ${planId} not found`), { status: 404 });

  const brief = await getBrief(plan.brief_id);
  const stored = plan.chart_data || {};

  const payload = {
    brief: brief || {},
    plan: {
      id: plan.id,
      recommended_lineup: plan.recommended_lineup || [],
      overall_rationale: plan.overall_rationale,
      competitor_analysis: plan.competitor_analysis,
      confidence: plan.confidence,
      gaps_or_caveats: plan.gaps_or_caveats,
      model_used: plan.model_used,
      created_at: plan.created_at,
    },
    // chart_data holds the derived series plus the aggregates the model saw.
    chart_data: {
      competitor_spend: stored.competitor_spend,
      programme_ratings: stored.programme_ratings,
      medium_split: stored.medium_split,
    },
    aggregated: stored.aggregated || {},
    meta: stored.meta || { model_used: plan.model_used },
  };

  const workDir = path.join(config.report.workDir, `plan-${planId}-${randomUUID()}`);
  await fs.mkdir(workDir, { recursive: true });

  const payloadPath = path.join(workDir, 'payload.json');
  const outPath = path.join(workDir, 'report.pdf');
  await fs.writeFile(payloadPath, JSON.stringify(payload), 'utf8');

  const started = Date.now();
  await runPython(['--payload', payloadPath, '--out', outPath, '--charts-dir', workDir]);
  log.info('report rendered', { planId, ms: Date.now() - started });

  const brandSlug = (brief?.brand || 'media-plan')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'media-plan';

  return {
    path: outPath,
    filename: `${brandSlug}-media-plan-${planId}.pdf`,
    // The caller streams the file, then drops the whole working directory -
    // charts and payload included.
    cleanup: () => fs.rm(workDir, { recursive: true, force: true }).catch(() => {}),
  };
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.report.pythonBin, [SCRIPT, ...args], {
      cwd: path.dirname(SCRIPT),
      env: {
        ...process.env,
        // matplotlib writes a font cache; give it somewhere writable on a
        // read-only or ephemeral container filesystem.
        MPLCONFIGDIR: process.env.MPLCONFIGDIR || path.join(os.tmpdir(), 'mpl-cache'),
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Report generation timed out after ${config.report.timeoutMs}ms`));
    }, config.report.timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error(
              `Python not found at "${config.report.pythonBin}". Set PYTHON_BIN, and install ` +
              'report/requirements.txt (matplotlib, reportlab).',
            )
          : err,
      );
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      reject(new Error(`Report worker exited with code ${code}: ${stderr.trim().slice(0, 1000)}`));
    });
  });
}

/** Confirm the Python side is installed - surfaced on /health. */
export async function reportWorkerHealth() {
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(config.report.pythonBin, [
        '-c',
        'import matplotlib, reportlab; print(matplotlib.__version__, reportlab.Version)',
      ]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `exit ${code}`)),
      );
    });
    const [matplotlib, reportlab] = out.split(/\s+/);
    return { ok: true, matplotlib, reportlab };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
