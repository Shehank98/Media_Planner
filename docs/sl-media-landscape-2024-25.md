# Sri Lanka Media Landscape 2024/25 — planning knowledge base

Distilled from the agency's *2024/2025 Media Landscape* deck (Kantar NDLS
2024/25, target group 15+). This is the market intelligence and planning
doctrine the assistant uses when it recommends a plan. The machine-readable copy
that is injected into the model prompt lives in
[`src/llm/planningKnowledge.js`](../src/llm/planningKnowledge.js) — **keep the two
in step** when either changes.

It is *context*, not data: it shapes how the supplied ratings/cost numbers are
read and justified. It never lets the model invent channels, programmes or costs
that are not in the uploaded data.

## Audience

- **16.38M** media population (15+); **52% female**; median age ~33.
- TV skews **female and older**; time spent watching rises with age.
- **55% of women are full-time housewives** — female daytime programming reaches
  them, which matters for female-targeted brands.
- **Language:** Sinhala is the main language for ~78%, Tamil for ~21%. Match the
  channel's language to the brief's audience and territory. Western/Colombo
  viewers code-mix Sinhala/English/Tamil.
- **Region:** Western ~30% of the audience (urban, higher SEC), Central ~12%
  (notable Tamil share, ~24%), Southern ~12% (heavily Sinhala), Northern ~5%
  (almost entirely Tamil).
- **SEC:** the emerging middle class sits in **SEC B and C (>50%** of
  households); upper-SEC concentrates in Western, Central and Sabaragamuwa.
- Average monthly household income up ~20% in two years; >half of households
  earn 50k+.

## Television

- **82%** own a TV; **4.8M** TV households; **13.4M** individuals 15+ live in TV
  households; **76%** watch weekly; average **~2:06 per day**.
- Nearly all free-to-air channels are **entertainment**; there is **one
  dedicated news channel** (since Dec 2022).
- **Duopoly:** the **top two channels hold ~40% of viewing** (of 18 FTA
  channels) and take **over half of TV investment**.
- Viewership is driven by **programme quality, not channel loyalty**, and
  **peaks on both weekdays and weekends during prime time**.

### Channel tiers and skew (use only channels present in the uploaded data)

| Rank | Channel | Character |
|------|---------|-----------|
| #1 | TV Derana | Urban-skewed |
| #2 | Hiru TV | Rural-skewed |
| #3 | Sirasa TV | Broad Sinhala |
| #4 | Swarnavahini | Broad Sinhala |
| #5 | Shakthi TV | Tamil |
| #6 | ITN | Rural (Tier 2) |
| #7 | Siyatha | Tier 2 |
| #8 | Rupavahini | National (Tier 2) |

### Pay TV / cable & satellite / streaming

- ~half of households subscribe to pay TV; **Dialog TV** leads (~1.5M
  connections), **Peo TV** second (~650K); ~50% of connections are in the
  Western Province.
- C&S viewing share is **growing** (terrestrial vs C&S ≈ 56:44 → 54:46), time
  spent on C&S is high, and the Tamil C&S audience is driven by **South Indian
  channels**.
- Connected TV / streaming (Netflix, Prime) is rising; **planning for all TV
  screens (CTV, TV+)** matters to catch fragmented, younger, urban viewing.

## Spot-distribution doctrine

1. **Channels first**, weighted to audience share and reach and matched to the
   brief's region/language/SEC — usually **two to four**, weighted toward the
   strongest one or two (the market spends >50% on the top two).
2. **Programme-led buying:** pick the highest-rated programmes for the target
   audience on ratings and cost efficiency, regardless of channel loyalty.
3. **Spread** spots across the flight and across **weekday + weekend** prime, and
   across more than one time belt — front-load a launch week for awareness, then
   sustain. Respect the clutter limits (no belt >40%, ≤6 spots/belt/day, ≤3
   channels/belt/day).
4. **Copy lengths:** 30-second where the programme and rate justify the weight;
   shorter 10–15s reminders once awareness is built.
5. **Match skew to audience:** Derana for urban, Hiru for rural, Shakthi and
   South-Indian cable for Tamil, broad Sinhala (Sirasa/Swarnavahini) for mass
   Sinhala reach.
6. **All-screen gap:** if the plan is TV-spot only, note pay-TV/C&S/CTV as a
   reach gap in the caveats rather than ignoring it.
