// ---------------------------------------------------------------------------
// Media planning method and metrics, distilled from the agency's Media Training
// workshop deck.
//
// Where planningKnowledge.js is market context (who watches what), this is
// craft: the formulas a planner reasons with, the weight benchmarks, how to pick
// programmes on cost efficiency, the scheduling patterns, and the order the plan
// is built in. It is appended to the system prompt so the model plans the way a
// trained planner does. A human-readable copy lives in docs/media-planning-method.md.
// ---------------------------------------------------------------------------

export const PLANNING_METHOD = `PLANNING METHOD & METRICS — how to build and weigh the buy.

Core metrics (reason with these; the app computes the arithmetic):
- TVR: percent of the target who watched a programme/timeslot; 1 point = 1% of the target; it is time-weighted.
- GRPs = TVR x spots, summed across the plan = total campaign weight (duplicated reach). GRPs = Reach x average Frequency.
- CPRP = spot cost / programme TVR = cost per rating point. This is the efficiency yardstick for choosing programmes: prefer the LOWEST CPRP for the audience, not simply the highest TVR - a slightly lower-rated programme that costs far less per point delivers more weight for the money.
- NGRP normalises weight to a 30-second equivalent (GRP x duration / 30); use it when comparing weight with competitors on a like-for-like length.
- SOV = brand GRPs / category GRPs; SOS = brand spend / category spend. To grow share, hold share of voice at least in line with the share-of-market ambition (SOV >= SOM).

Weight benchmarks (Sri Lanka TV) - size total spots so the plan's GRPs land near the benchmark that fits the objective, and say which you targeted:
- Launch / re-launch: about 850-900 GRPs.
- Maintenance / sustaining: about 500-600 GRPs.

Channel mix - build reach first, then frequency:
- Each channel added brings incremental UNDUPLICATED reach first, then mostly frequency. Incremental reach falls away fast after the top two or three (a duopoly market), so two to four channels usually captures the reach and further channels only add frequency / top-of-mind.
- Choose the combination that adds the most NEW audience for the money, not the highest-rated single channel.

Programme selection:
- Shortlist on TVR for the audience, then rank on CPRP; pick the best CPRP programmes, weighed against who is already buying the slot.

Scheduling pattern - match to the objective and the category's buying cycle:
- Burst: heavy weight in a short window - launches, seasonal peaks, event tie-ins.
- Continuous: even weight across the flight - always-on staple categories.
- Flighting: on-then-off periods - limited budget or seasonal sales.
- Pulsing: a continuous base with bursts on top - the usual choice for a sustained brand with peak moments.
Decide from the sales pattern, purchase cycle, competitor activity, product availability, budget and the marketing task, and name the pattern in the rationale.

Time-belt / daypart optimisation:
- Prime Time peaks about 19:00-21:30 (viewing tops around 20:00-20:30); there is a secondary morning peak about 06:30-08:00.
- Buy the belts where the chosen channel is strongest, across Prime Time AND its strongest Non-Prime-Time programmes - NPT spots stretch reach and cost fewer rupees per point.
- Weekends from 19:30 are the "reality-show belt" (Hiru/Derana/Sirasa) - the highest-rated and most contested weekend inventory.
- Spread across belts and days to build reach and effective frequency rather than repeating one slot (respect the clutter limits).

Effective frequency & top-of-mind:
- Effective frequency is the minimum exposures needed for the message to land; set it higher when the message is new or complex, the category is cluttered, or there are several creatives. Extra channels and spots buy the frequency that keeps the brand top-of-mind.

Plan-making order (follow it): channel selection on channel share -> top programmes on TVR -> evaluate CPRP -> select programmes on CPRP -> construct spots and cost -> pre-evaluate GRPs, reach and frequency against the objective -> finalise.`;
