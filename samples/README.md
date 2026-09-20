# Samples

Drop sample workbooks here for local testing (rate cards, adex, media-watch).
Everything in this folder except this README is git-ignored — client data must
never be committed.

Expected shapes:

- **Rate card** — one workbook, one sheet per channel. Row 0 title with
  `Effective: <date>`, row 1 headers, row 2+ data.
- **Adex** — columns: `Product_Group, Advertiser, Product, Advt_Theme,
  V/A | Com, Medium, Ads, Channel, Program, Dd, Mn, Yr, Day, Prog_time,
  Advt_time, AdPos, TotAds, BrkNo, PosinBrk, AdsinBrk, Lng, Dur, Cost`.
- **Media-watch** — columns: `Rank, Data Set, Channel, Date, Day, Start, End,
  Program, Duration, Category, TVR, Total TVR, TVR Share %, Reach, Reach %,
  Avg Time`.
