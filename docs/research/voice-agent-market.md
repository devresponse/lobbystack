# Know the voice agent market, 2026

On 2026-10-08 a market study looked at how phone voice agents are hosted and sold: platforms, models, carriers and prices, the market's size and growth, vendors' revenue, named deployments, small-business receptionist pricing, and an illustrative profit and loss for LobbyStack. It drew on about 225 sources, mostly vendors' own pages, market reports and press. Every price is a list price on that date, vendor results are unaudited, and every profit input except LobbyStack's own prices is an assumption to replace with real usage data. The engineering side of the same study is in [voice platforms](voice-platforms.md).

## Know the answer

- **The voice model sets the margin, not the host.** Carriage costs about a third of a cent a minute and orchestration about a cent; a frontier voice model about five cents. Everything priced above that pays for tooling, integration and accountability.
- **GPT-Live is the strongest model to put behind a SIP trunk,** at a flat $0.05 a minute and the top independent quality score, and LobbyStack's own routes sit at the market's price floor: $0.03 to $0.11 a minute all in.
- **The market is small and fast-growing:** about $3.5 to 3.7 billion in 2026, growing 35% to 39% a year.
- **Small-business receptionists sell for $25 to $300 a month** and live or die on churn, which runs 6% to 12% a month below $250.
- **At LobbyStack's prices the business is thin:** on a placeholder cost of $0.08 a minute it loses money at every size modelled; on GPT-Live's real cost it earns about $42,000 a month at 10,000 customers.
- **The threat is distribution, not technology:** AI answering now arrives bundled into the call-tracking and field-service suites small businesses already pay for.

## Know the hosting tiers

| Tier | Leading options | All in, a minute | What the buyer still builds | Uptime commitment |
| --- | --- | --- | --- | --- |
| Carrier trunk straight into a realtime model | GPT-Live and `gpt-realtime-2.1` at OpenAI or Azure; Ultravox; AssemblyAI's agent API | $0.03 to $0.11 | Tools, call state, recovery, deploys, monitoring | None that names realtime audio |
| Open-source framework and its cloud | LiveKit Cloud, Pipecat Cloud | Adds $0.013 to $0.03 to the model | Agent code in Python, or Node on LiveKit | An objective without credits, or none |
| Hosted developer platform | Retell, Vapi, ElevenLabs Agents, Cartesia, Bland | $0.074 to $0.15 | Prompts, flows, integrations | Vapi 99% from $999 a month; Bland 99.9%; Retell none |
| Carrier-bundled agent | Telnyx, Twilio ConversationRelay, SignalWire | About $0.06 to $0.165 | Agent logic or configuration | Not published |
| Contact-centre suite or AI specialist | Amazon Connect, Google, Genesys, Microsoft, Salesforce; Sierra, Decagon, PolyAI, Parloa | $0.04 to $0.60, or $2 a conversation; specialists from about $150,000 a year | Integration and change management | Amazon Connect 99.99% with credits |

A company that already owns its agent logic, as LobbyStack does, belongs in the first two tiers: a platform would charge a fee on every minute for a flow builder it doesn't need.

## Price a phone minute

For 1,000 and 10,000 inbound US calls of four minutes a month. LobbyStack's own routes are priced in [voice platforms](voice-platforms.md#compare-the-four-routes): about $285 and $2,260 on GPT-Live.

| Option | All in, a minute | 1,000 calls | 10,000 calls | Catch |
| --- | --- | --- | --- | --- |
| A cascade (speech-to-text, fast text model, text-to-speech) on LiveKit Cloud | About $0.025 to $0.045 | $100 to $180 | $1,000 to $1,800 | Quality unbenchmarked; slower when stitched |
| Amazon Connect, AI included | About $0.040 | About $162 | About $1,610 | Agent tooling extra; its voice model unranked |
| Ultravox | About $0.055 | About $220 | About $2,290 | 5 calls at once on pay-as-you-go; new owner |
| Telnyx Voice AI Agents | About $0.06 | About $240 | About $2,400 | Billed in 60-second steps |
| Deepgram or AssemblyAI agent API, plus a trunk | $0.071 to $0.078 | $286 to $314 | $2,860 to $3,140 | No published uptime |
| Twilio ConversationRelay | $0.0785 plus the text model | About $314 plus | About $3,140 plus | You still run the agent |
| Vapi | $0.082 to $0.129 | $327 to $516 | $3,272 to $5,156 | HIPAA costs $2,000 a month |
| ElevenLabs Agents | About $0.088 plus the model | About $352 plus | About $3,520 plus | Minutes past its concurrency cap billed double |
| Retell | $0.088 to $0.149 | $353 to $596 | $3,528 to $5,960 | No EU hosting, no SLA |
| Bland | About $0.135 to $0.148 | About $592 | About $5,419 | Warm transfer and SIP need Enterprise |
| Microsoft Copilot Studio voice | About $0.28 | About $1,200 | About $11,200 | Premium voice $0.60 |
| Salesforce Agentforce | $2 a conversation | $2,000 | $20,000 | Plus seats |
| Sierra, PolyAI, Parloa | Contract | At least $12,500 to $25,000 | The same | Reported annual floors of $150,000 to $300,000 |

Hosted platforms' list prices understate real bills: production deployments on Vapi and Retell run $0.13 to $0.33 a minute once models, add-ons and billed silence are counted.

## Size the market

| Scope and publisher | 2025 | 2026 | 2030, implied | Growth a year |
| --- | --- | --- | --- | --- |
| AI voice agents, Grand View Research | $2.54B | $3.51B | About $13.1B | 39.0% |
| AI voice agents, SNS Insider | $2.75B | $3.70B | About $12.3B | 35.1% |
| Voice AI agents, broad scope, Globe Market Research | $5.1B | Not given | About $24.1B | 36.4% |
| Conversational AI, MarketsandMarkets | $17.05B | Not given | About $41.7B | 19.6% |
| Call-centre AI, GMI | $2.60B | $3.27B | About $6.1B | 17% |

The scopes overlap and can't be added, and nobody sizes the virtual-receptionist niche credibly. Adoption is broad but shallow: about one firm in five uses any AI in the US (19.8%), Canada (19.2%), the EU (19.95% of firms with ten or more staff) and France (18%). Voice is a sliver: among Canadian AI users, 28.2% run virtual agents or chatbots, about 5% of all businesses. North America accounts for 38% to 45% of voice-agent spending; financial services buy the most and healthcare grows fastest.

Callers accept AI on one condition: **87% say a company using AI for service must offer a route to a human** (Gartner, August 2026). Small-business vendors sell against the unanswered call, which vendor datasets put at 27% to 33% of calls, not the often-quoted 62%.

## Know the rules

- **US:** AI voices count as "artificial" under the TCPA, so outbound AI calls, callbacks and reminders included, need prior consent, and marketing calls written consent. Inbound answering is treated lightly. Maine and Utah require disclosure in some cases. In California, wiretapping claims against an AI vendor that could use call data to improve its models were allowed to proceed, at $5,000 per violation. Under HIPAA a vendor storing health information in calls needs a business associate agreement.
- **EU:** Article 50 of the AI Act has applied since 2026-08-02: people must be told they are dealing with AI at the first interaction.
- **France:** consumer telephone canvassing needs prior opt-in consent since 2026-08-11.
- **Quebec:** Law 25 requires notice of automated decisions and a privacy impact assessment before personal data leaves the province.

The cheapest cover across all of them: a spoken AI disclosure in English and French at the start of every call, no-training or zero-retention terms with the voice vendor, and consent records for any outbound callback.

## Know the vendors

| Company | Valuation | Revenue or ARR, 2026 |
| --- | --- | --- |
| ElevenLabs | $11B | Over $500M ARR |
| Sierra | $15.8B | $200M ARR |
| Decagon | $4.5B | Over $100M ARR |
| Deepgram | $1.3B | Over $100M ARR, cash-flow positive |
| Retell AI | Undisclosed | $50M ARR on $5.1M raised, profitable |
| Parloa | $3B | Over $50M ARR |
| PolyAI | $750M | Targeting over $40M ARR |
| LiveKit | About $1B to $1.45B | Over $10M run rate in 2024; runs ChatGPT's voice mode |

Private rounds price customer-experience agent leaders at 45 to 105 times ARR and infrastructure vendors at 13 to 25 times, while exits price far lower (NICE paid $955M for Cognigy, about 14 times its 2025 revenue). Incumbents' AI lines grow 50% to 80% a year from small bases. Small infrastructure vendors keep being absorbed: four went to larger companies within fifteen months, which makes API continuity a real risk when building on one.

## Know what deployments achieve

Named deployments answer close to every call but fully handle only part of them, by the vendors' own measures: about 25% to 45% where the agent mainly routes or works in clinical settings, and 65% to 80% in narrow, high-volume transactional flows. Waits fall by a third to a half and abandonment drops to single digits. For small businesses the evidence is thinner and points to coverage rather than containment: the agent answers everything, resolves about half, and earns its keep by writing straight into the booking system. Failures share causes: noisy, open-ended ordering, overstated automation, staff cut before deflection was measured, and no easy path to a human. In French, Doctolib sells doctors an AI phone assistant at €99 a month for four scenarios.

## Price a small-business receptionist

| Vendor | Plans a month | Effective price |
| --- | --- | --- |
| LobbyStack | $30 for 150 minutes; $100 for 500 | $0.20 a minute ($0.18 overage on Pro) |
| Rosie | $49 to $299 for 250 to 2,000 minutes | $0.15 to $0.20 a minute |
| Upfirst | $24.95 to $299 for 30 to 600 calls | $0.50 to $0.83 a call |
| Jobber add-on | $29 for 30 conversations | $0.79 per extra conversation |
| My AI Front Desk | $99 for 200 minutes | $0.25 a minute overage |
| Dialzara | $29 to $349 for 60 to 1,000 minutes | $0.35 to $0.48 a minute |
| Goodcall | $79 to $249 for 100 to 500 unique callers | Unlimited minutes |
| Smith.ai, AI plans | $150 for 75 calls; $500 for 300 | $1.67 to $2.00 a call |
| Human answering services (PATLive, Ruby, Smith.ai) | $99 to $6,899 | $1.38 to $5.00 a minute, or $7 to $10 a call |

LobbyStack's prices here are the code's built-in catalog in US dollars (`packages/shared/src/billing.ts`). The AlloPlace plans file sets the same amounts in Canadian dollars ([billing](../billing/README.md#know-the-plans)), which lowers revenue per customer in US terms; re-run the figures below in the plans' currency before relying on them.

A typical paying small business uses 40 to 100 calls a month at 2 to 3 minutes, or 100 to 300 minutes. **Churn is the binding constraint:** ChartMogul found AI-native products under $50 a month keep 23% of their revenue after a year (about 11.5% churn a month), those at $50 to $249 keep 45% (about 6.4%), and those above $250 keep 70%, with annual plans 10 to 20 points better. With churn near 10% a month paid acquisition rarely pays back, which pushes the segment toward cheap channels: affiliates (LobbyStack pays 20% of payments for 12 months, `packages/domain/src/server/affiliates.ts`), vertical-software partnerships, and agencies that resell receptionists at $250 to $500 a month.

## Estimate the profit

An illustrative monthly profit and loss built on those benchmarks. Assumptions: 70% of customers on Starter and 30% on Pro, a fifth paying yearly, so blended revenue of $53.88 per customer with overage and add-ons; about 250 cost minutes per customer (billable, non-billable and free use) at a placeholder $0.08 a minute; about $5 a customer of other variable cost (the number, alerts, payment fees, hosting); 7% monthly churn replaced at $150 a customer; fixed costs scaled by size.

| Monthly, base case | 100 customers | 1,000 customers | 10,000 customers |
| --- | --- | --- | --- |
| Revenue | $5,388 | $53,880 | $538,800 |
| Variable costs | $2,515 | $25,150 | $249,000 |
| Fixed infrastructure | $300 | $1,500 | $8,000 |
| Gross profit (margin) | $2,573 (48%) | $27,230 (51%) | $281,800 (52%) |
| Support | $1,000 | $7,500 | $50,000 |
| Sales and marketing to replace churn | $1,050 | $10,500 | $105,000 |
| Research, development and administration | $5,000 | $30,000 | $150,000 |
| **Operating result** | **−$4,477** | **−$20,770** | **−$23,200** |

Each customer contributes about $24 a month after support, which at 7% churn gives a lifetime value of about $343. At $150 to acquire a customer that is a ratio of about 2.3 with payback in about six months; at the B2B average of $239, payback stretches to about ten months.

Replacing the placeholder with each voice route's real cost a minute (model plus carriage) shows how much the voice decision matters. Each cent a minute is worth about $25,000 a month at 10,000 customers.

| Voice route, cost a minute | Gross margin | Operating result a month at 10,000 customers |
| --- | --- | --- |
| Azure OpenAI over SIP, mini ($0.029) | 75.9% | +$104,000 |
| Azure Voice Live Standard, mini ($0.041) | 70.4% | +$75,000 |
| LiveKit Cloud with the mini ($0.043) | 69.6% | +$70,000 |
| **GPT-Live over SIP ($0.054)** | **64.4%** | **+$42,000** |
| Azure OpenAI over SIP, `gpt-realtime-2.1` ($0.073) | 55.4% | −$7,000 |
| Retell with a fast text model on LobbyStack's own trunk ($0.077) | 53.9% | −$15,000 |
| Placeholder base case ($0.080) | 52.3% | −$23,000 |
| Azure Voice Live Pro ($0.083) | 51.0% | −$30,000 |
| LiveKit Cloud with `gpt-realtime-2.1` ($0.087) | 49.1% | −$40,000 |
| Vapi ($0.082 to $0.129) | 51.4% to 29.6% | −$28,000 to −$146,000 |

- **GPT-Live is the only top-rated model that keeps the business profitable at these prices:** at 10,000 customers it is worth about $49,000 a month and 9 points of gross margin over `gpt-realtime-2.1`.
- **At 1,000 customers no route breaks even,** since fixed costs dominate; GPT-Live still narrows the loss by about $5,000 a month.
- **The minis would add $28,000 to $62,000 a month more** at full scale, but only if they pass the golden tests on phone audio, which their 22.5% task score makes doubtful.
- **Capacity fits:** 10,000 customers make about 2.5 million minutes a month, about 190 calls at once on average and 380 at peak, within GPT-Live's 500 sessions on its Grow tier.
- **Price is the other lever:** each $10 of monthly revenue per customer adds about $100,000 a month at that size. Rivals price a middle tier at $129 to $299, where retention is also better.

## Know what it means for LobbyStack

For a company that already owns its agent logic, the only hosting decisions that move the business are which model to buy at the floor and how to price above it. On October's evidence that means GPT-Live behind the SIP trunk, a provider seam and a one-change Twilio fallback against vendor churn, and a product whose answered calls become bookings an owner can see, priced toward the middle band where retention and margin both improve. Undecided: whether to add a middle tier, and whether the minis and French pass the golden tests on phone audio ([open items](../project/open-items.md)).
