import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { parseBriefPdf } from '../parsers/briefParser.js';
import { insertBrief, updateBrief, getBrief, listBriefs } from '../services/briefRepo.js';

export const router = express.Router();

// Brief PDFs are held in memory too. The parse result is returned for review
// and nothing is written until the planner confirms it.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.pdf$/i.test(file.originalname);
    cb(ok ? null : new Error(`${file.originalname}: only .pdf briefs are accepted`), ok);
  },
});

/**
 * Parse a brief PDF and return the proposed fields - saves nothing.
 *
 * Section 5 step 2: brief PDFs are messy multi-table layouts, so the parse is
 * shown back for confirmation before it becomes the basis of a plan. The
 * response carries `confidence` (what matched which label) and `warnings` so
 * the planner knows which fields to look at hardest.
 */
router.post('/parse', upload.single('file'), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No brief uploaded. Attach a .pdf file.' });

  try {
    const result = await parseBriefPdf(req.file.buffer, { sourceFile: req.file.originalname });
    res.json({
      fields: result.fields,
      matched_labels: result.confidence,
      warnings: result.warnings,
      // Handy when a field was missed and someone needs to see what the PDF
      // actually contained.
      extracted_lines: result.lines.slice(0, 200),
      saved: false,
      next: 'Review and correct these fields, then POST /api/briefs to save.',
    });
  } finally {
    req.file.buffer = null;
  }
}));

/** Save a confirmed brief. */
router.post('/', asyncRoute(async (req, res) => {
  const fields = req.body || {};
  const problems = validateBrief(fields);
  if (problems.length) return res.status(400).json({ error: 'Invalid brief', problems });
  res.status(201).json(await insertBrief(fields));
}));

router.get('/', asyncRoute(async (_req, res) => {
  res.json({ briefs: await listBriefs() });
}));

router.get('/:id', asyncRoute(async (req, res) => {
  const brief = await getBrief(Number(req.params.id));
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  res.json(brief);
}));

/** Correct a brief after the fact - a planner spotting a bad parse later. */
router.put('/:id', asyncRoute(async (req, res) => {
  const problems = validateBrief(req.body || {});
  if (problems.length) return res.status(400).json({ error: 'Invalid brief', problems });
  const brief = await updateBrief(Number(req.params.id), req.body);
  if (!brief) return res.status(404).json({ error: 'Brief not found' });
  res.json(brief);
}));

function validateBrief(fields) {
  const problems = [];
  if (!fields.brand || !String(fields.brand).trim()) {
    problems.push('brand is required - it drives the competitor set and the own-brand trend');
  }
  if (fields.budget_lkr_lakhs != null && !Number.isFinite(Number(fields.budget_lkr_lakhs))) {
    problems.push('budget_lkr_lakhs must be a number (in LKR lakhs)');
  }
  for (const key of ['period_start', 'period_end']) {
    const v = fields[key];
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) {
      problems.push(`${key} must be YYYY-MM-DD`);
    }
  }
  if (fields.period_start && fields.period_end && fields.period_start > fields.period_end) {
    problems.push('period_start must not be after period_end');
  }
  if (fields.medium_split != null && typeof fields.medium_split !== 'object') {
    problems.push('medium_split must be an object, e.g. {"tv":60,"radio":25,"press":15}');
  }
  return problems;
}
