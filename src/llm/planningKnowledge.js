// ---------------------------------------------------------------------------
// Sri Lanka TV planning knowledge, distilled from the agency's 2024/25 Media
// Landscape deck (Kantar NDLS 2024/25, TG 15+).
//
// This is market context and planning doctrine, not data: it tells the model
// how to READ the supplied numbers - which channel indexes for whom, when the
// audience actually watches, how weight is normally split - so a plan reflects
// how Sri Lankan TV is really bought. It never overrides grounding: the model
// still recommends only channels, programmes and costs present in the supplied
// data. A human-readable copy lives in docs/sl-media-landscape-2024-25.md; keep
// the two in step when either changes.
// ---------------------------------------------------------------------------

export const PLANNING_KNOWLEDGE = `MARKET CONTEXT & PLANNING DOCTRINE — Sri Lanka TV (Kantar NDLS 2024/25, 15+).
Use this to interpret the supplied numbers and to justify channel, day, belt and length choices. It does NOT add channels or programmes: still recommend only those present in the supplied data, and only costs from the observed data.

Audience:
- 16.38M media population (15+); 52% female; median age ~33. TV skews female and older; time spent rises with age. 55% of women are full-time housewives - female daytime programming reaches them.
- Language: Sinhala is the main language for ~78%, Tamil for ~21%. Match the channel's language to the brief's audience/territory. Colombo/Western viewers code-mix Sinhala/English/Tamil.
- Region: Western ~30% of the audience (urban, higher SEC), Central ~12% (notable Tamil share), Southern ~12% (heavily Sinhala), Northern ~5% (almost entirely Tamil). Upper-SEC concentrates in Western/Central/Sabaragamuwa; the emerging middle class sits in SEC B and C (>50% of households).

TV market:
- 82% own a TV; 4.8M TV households; 76% watch weekly; ~2 hours a day. Nearly all free-to-air channels are entertainment; there is one dedicated news channel.
- It is a DUOPOLY: the top two channels hold ~40% of viewing and take over half of TV investment. Concentrating the majority of weight on the strongest one or two channels is normal and efficient - but spread enough across channels and belts to build reach rather than just repeat frequency (respect the clutter limits).
- Viewership follows PROGRAMME QUALITY, not channel loyalty. Pick the highest-rated programmes for the target audience regardless of which channel carries them.
- Prime time peaks on BOTH weekdays and weekends. Do not buy weekday-only when the brief needs reach; carry weight into the weekend prime band too.
- Channel character (use only if the channel is in the supplied data): Derana indexes urban; Hiru indexes rural; Sirasa and Swarnavahini are broad Sinhala; Shakthi and the South-Indian cable channels serve the Tamil audience; ITN/Rupavahini are more rural/national. Choose channels whose skew matches the brief's audience, region and language.

Spot-distribution doctrine:
- Choose channels first, weighted to audience share and reach, matched to the audience's region/language/SEC; usually two to four, weighted toward the strongest.
- Buy the best programmes within each channel on ratings and cost efficiency, not on channel loyalty.
- Spread spots across the flight and across weekday + weekend prime, and across more than one belt - front-load a launch week if the objective is awareness, then sustain.
- Use 30-second copy where the programme and rate justify the weight; use shorter 10-15s copy as reminders once awareness is built.
- Pay TV / cable & satellite and connected-TV keep growing and fragment younger, urban viewing; if the plan is TV-spot only, note that as a reach gap in the caveats rather than ignoring it.`;
