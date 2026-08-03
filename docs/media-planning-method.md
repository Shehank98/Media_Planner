# Media planning method — metrics, benchmarks & scheduling

Distilled from the agency's **Media Training workshop** deck. This is the craft
the assistant plans with — the formulas, the weight benchmarks, how to pick
programmes on cost efficiency, the scheduling patterns, and the order a plan is
built in. The machine-readable copy injected into the model prompt is
[`src/llm/planningMethod.js`](../src/llm/planningMethod.js) — **keep the two in
step**. Market context (who watches what) is the companion doc,
[`sl-media-landscape-2024-25.md`](./sl-media-landscape-2024-25.md).

## Core metrics

| Metric | Formula | Use |
|--------|---------|-----|
| **TVR** | % of the target who watched a programme/timeslot (1 pt = 1%, time-weighted) | Programme strength |
| **GRPs** | Σ (TVR × spots) = Reach × Frequency | Total campaign **weight** |
| **CPRP** | spot cost ÷ programme TVR | **Cost efficiency** — pick the *lowest* CPRP, not just the highest TVR |
| **NGRP** | GRP × (duration ÷ 30) | Compare weight with competitors at a like-for-like length |
| **SOV** | brand GRPs ÷ category GRPs | Share of voice |
| **SOS** | brand spend ÷ category spend | Share of spend |

To **grow share**, hold **SOV ≥ SOM** (share of voice at least in line with the
share-of-market ambition).

## Weight benchmarks (Sri Lanka TV)

Size total spots so the plan's **GRPs** land near the benchmark that fits the
objective:

- **Launch / re-launch:** ~**850–900 GRPs**.
- **Maintenance / sustaining:** ~**500–600 GRPs**.

The app computes the plan's GRPs (TVR × spots) and grades the weight —
`launch` (≥800), `maintenance` (≥450), or `light`.

## Channel mix — reach first, then frequency

- Each channel added brings incremental **unduplicated reach** first, then
  mostly frequency. Incremental reach falls away fast after the top two or three
  (a duopoly market), so **2–4 channels** usually captures the reach; more only
  add frequency / top-of-mind.
- Pick the combination that adds the most **new** audience for the money, not the
  highest-rated single channel.

## Programme selection

Shortlist on **TVR** for the audience, then rank on **CPRP** and pick the best
cost-per-point programmes, weighed against who is already buying the slot.

## Scheduling patterns

Match the pattern to the objective and the category's buying cycle:

- **Burst** — heavy weight in a short window (launches, seasonal peaks, events).
- **Continuous** — even weight across the flight (always-on staples).
- **Flighting** — on-then-off periods (limited budget, seasonal sales).
- **Pulsing** — a continuous base with bursts on top (sustained brand with peak
  moments) — the common default.

Decide from the sales pattern, purchase cycle, competitor activity, product
availability, budget and marketing task.

## Time-belt / daypart optimisation

- Prime Time peaks **~19:00–21:30** (viewing tops ~20:00–20:30); secondary
  morning peak **~06:30–08:00**.
- Buy where the chosen channel is strongest, across Prime Time **and** its
  strongest Non-Prime-Time programmes (NPT stretches reach, costs fewer rupees
  per point).
- **Weekends from 19:30** are the "reality-show belt" (Hiru/Derana/Sirasa) — the
  highest-rated, most contested weekend inventory.
- Spread across belts and days to build reach and effective frequency (respect
  the clutter limits: no belt >40%, ≤6 spots/belt/day, ≤3 channels/belt/day).

## Effective frequency & top-of-mind

Effective frequency is the minimum exposures for the message to land — set it
higher when the message is new/complex, the category is cluttered, or there are
several creatives. Extra channels and spots buy the frequency that keeps the
brand top-of-mind.

## Plan-making order

1. **Channel selection** — on channel share.
2. **Top programmes** — on TVR.
3. **Evaluate CPRP** — planning rates.
4. **Select programmes** — on CPRP.
5. **Construct** — number of spots, costing.
6. **Pre-evaluate** — GRPs, reach, frequency against the objective.
7. **Finalise** — to client.
