# Sample files

Drop the real source files here when working on the parsers:

- `TV_ChannelDetails_*.xlsx` — channel master data
- `TV_GrpDetails_*.xlsx` — programme ratings
- a campaign brief PDF
- an adex export workbook

**These are client data and are gitignored.** Nothing in this directory is
committed except this README.

The parsers do not read from this directory at runtime — adex arrives via the
Google Drive sync and the TVR/brief files arrive as uploads. This is purely a
place to keep real files while checking a parse.

To check a workbook against the parsers without starting the server:

```bash
node -e "
import('./src/parsers/adexParser.js').then(async (m) => {
  const fs = await import('node:fs/promises');
  const { rows, sheets, warnings } = await m.parseAdexWorkbook(
    await fs.readFile('samples/YOUR_FILE.xlsx'), { sourceFile: 'YOUR_FILE.xlsx' });
  console.log('sheets:', JSON.stringify(sheets, null, 2));
  console.log('warnings:', warnings);
  console.log('first row:', rows[0]);
  console.log('total rows:', rows.length);
});"
```

`sheets[].unmappedFields` tells you which schema columns the header detector
could not find — the usual fix is adding that sheet's wording to the synonym
list in the relevant parser (`ADEX_FIELDS` in `src/parsers/adexParser.js`,
`CHANNEL_FIELDS` in `tvChannelParser.js`, `GRP_LONG_FIELDS` in `tvGrpParser.js`)
rather than changing any parsing logic.
