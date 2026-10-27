# Run the phone path on Azure in C#

A 2026-10-07 study designed the phone path and its knowledge lookups as Azure Functions in C#, with no dashboard, and the maintainer chose Azure OpenAI's Realtime API over SIP as its voice ([Azure port](../research/azure-port.md)). A day later GPT-Live proved cheaper, better rated and less bound by quotas ([voice platforms](../research/voice-platforms.md#know-what-changed-the-ranking)), so a port now rests only on needs that Azure alone meets: Entra ID sign-in, one Azure bill, data zones, or C# on Functions.

- **Status:** on hold. The choice hasn't been revisited ([decisions](../project/decisions.md#choose-what-to-build)).
- **Effort:** 44 to 65 developer-days for one .NET developer, plus a two-week pilot.
- **Running cost:** at 1,000 four-minute calls a month, about $370 on `gpt-realtime-2.1` and $185 on its mini, against about $284 for GPT-Live on the same functions.

## Know the shape

A second Twilio trunk sends each call to Azure OpenAI's SIP endpoint in East US 2. Azure documents no recording, so the trunk records each call. Four functions do the rest: `IncomingCall` takes the webhook and accepts the call; `CallSession`, one execution per call started from a Service Bus queue, holds the call's control socket and runs the tools; `IngestDocument` indexes knowledge; and `AfterCall` copies recordings, writes summaries and sweeps calls left without an owner. PostgreSQL stays, with today's hybrid search ported. Browser calls, website chat, booking, texts and the dashboard are out of scope.

## Follow the phases

| Phase | Days | Gate |
| --- | --- | --- |
| 1. Prototype | 17 | What a dropped socket does to a call, and whether a second socket can attach; then the greeting within 2 seconds, a 30-minute call, 25 calls on one instance, and a deploy that cuts none |
| 2. Core call path | 12 to 20 | A deploy, a killed instance and a dropped socket mid-call cut no call, and recovery takes under 40 seconds |
| 3. Knowledge and after-call | 8 to 13 | The same passages from the ported search, and a recording, summary and email for every test call |
| 4. Hardening and pilot | 7 to 15, then two weeks | Two weeks of pilot calls for one or two businesses with none cut |

## Know what would reopen it

A customer that needs Azure, or a measured reason GPT-Live can't serve. Until then, the cheaper insurance is the [voice engine seam](voice-provider-seam.md), which keeps one TypeScript code base: with a C# port, every later fix to the call path would have to be ported by hand.

## Decide these

- Revisit the 2026-10-07 choice of Azure OpenAI over SIP given GPT-Live's lead, or close the port.
