import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { log } from '../util/logger.js';
import { asyncRoute } from '../util/asyncRoute.js';
import { parseChannelWorkbook } from '../parsers/tvChannelParser.js';
import { parseGrpWorkbook } from '../parsers/tvGrpParser.js';
import { persistTvUpload, tvFacets } from '../services/tvRepo.js';
import { pool } from '../db.js';

export const router = express.Router();

// ---------------------------------------------------------------------------
// Session-only TVR/channel uploads (Section 4).
//
// memoryStorage is deliberate: multer's disk engine would write the workbook to
// a temp path, and "delete it afterwards" is a promise that breaks on the first
// crash or early return. Holding the file as a Buffer means there is no file to
// forget to delete - it is parsed, the extracted rows go to Postgres, and the
// Buffer is dropped when the request ends. Only the numbers live on.
// ---------------------------------------------------------------------------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 4 },
  fileFilter: (_req, file, cb) => {
    const ok = /\.(xlsx|xlsm|xls)$/i.test(file.originalname);
    cb(ok ? null : new Error(`${file.originalname}: only .xlsx/.xlsm/.xls workbooks are accepted`), ok);
  },
});

/**
 * Upload one or more channel/TVR workbooks.
 *
 * Accepts them under any field name and decides what each one is by content
 * rather than by which field it arrived in - the channel and GRP workbooks are
 * routinely uploaded together and get mixed up.
 */
router.post('/tv', upload.any(), asyncRoute(async (req, res) => {
  const files = req.files || [];
  if (!files.length) {
    return res.status(400).json({ error: 'No workbook uploaded. Attach at least one .xlsx file.' });
  }

  const channels = [];
  const ratings = [];
  const perFile = [];

  try {
    for (const file of files) {
      const detail = { file: file.originalname, size_bytes: file.size, parsed_as: null, warnings: [] };

      // Try both parsers and keep whichever recognised the sheet. A GRP
      // workbook has a channel column too, so the ratings result decides.
      const [channelResult, grpResult] = await Promise.all([
        parseChannelWorkbook(file.buffer, { sourceFile: file.originalname }).catch((err) => ({
          channels: [], sheets: [], warnings: [`channel parse failed: ${err.message}`],
        })),
        parseGrpWorkbook(file.buffer, { sourceFile: file.originalname }).catch((err) => ({
          ratings: [], sheets: [], warnings: [`GRP parse failed: ${err.message}`],
        })),
      ]);

      if (grpResult.ratings.length) {
        ratings.push(...grpResult.ratings);
        detail.parsed_as = 'programme_ratings';
        detail.ratings_found = grpResult.ratings.length;
        detail.sheets = grpResult.sheets;
        detail.warnings.push(...grpResult.warnings);
      }
      // A ratings sheet has a channel column, so the channel parser "succeeds"
      // on it too - but those rows carry only a name, with the rest of the
      // ratings row dumped into `raw`. Taking them would bury the real channel
      // master data under junk, so ratings sheets contribute ratings only.
      // Channels named there still get stub rows via ensureChannels().
      if (channelResult.channels.length && !grpResult.ratings.length) {
        channels.push(...channelResult.channels);
        detail.parsed_as = detail.parsed_as ? `${detail.parsed_as}+channels` : 'channels';
        detail.channels_found = channelResult.channels.length;
        detail.channel_sheets = channelResult.sheets;
        detail.warnings.push(...channelResult.warnings);
      }
      if (!detail.parsed_as) {
        detail.parsed_as = 'unrecognised';
        detail.warnings.push(
          'Neither a channel list nor a ratings table was recognised in this workbook. ' +
          'Check that the header row names a channel and a programme column.',
        );
        detail.sheets = grpResult.sheets;
      }
      perFile.push(detail);
    }

    if (!channels.length && !ratings.length) {
      return res.status(422).json({
        error: 'No channel or rating rows could be extracted from the upload.',
        files: perFile,
      });
    }

    const result = await persistTvUpload({ channels, ratings });
    log.info('tv upload ingested', {
      files: files.length,
      channels: result.channelsUpserted,
      ratings: result.ratingsUpserted,
    });

    res.json({
      ok: true,
      files: perFile,
      persisted: result,
      // Stated explicitly so the guarantee is visible to whoever calls the API.
      source_files_retained: false,
      facets: await tvFacets(pool),
    });
  } finally {
    // Drop the references so the buffers are collectable as soon as the
    // response is written, rather than lingering on req for the request's life.
    for (const file of files) file.buffer = null;
    req.files = [];
  }
}));

/** What TVR data is currently loaded - drives the in-app filter controls. */
router.get('/tv/summary', asyncRoute(async (_req, res) => {
  res.json(await tvFacets(pool));
}));

/**
 * Clear TVR data.
 *
 * Ratings are a point-in-time survey; when a new survey supersedes the old one
 * a planner needs to be able to start clean rather than blend two periods.
 */
router.delete('/tv', asyncRoute(async (req, res) => {
  if (req.query.confirm !== 'true') {
    return res.status(400).json({
      error: 'Refusing to delete rating data without ?confirm=true',
    });
  }
  const ratings = await pool.query('DELETE FROM tv_programme_ratings');
  const channels = req.query.channels === 'true'
    ? await pool.query('DELETE FROM tv_channels')
    : { rowCount: 0 };
  res.json({ ratings_deleted: ratings.rowCount, channels_deleted: channels.rowCount });
}));
