# Take several receptionists further

Since fork PR #129 a business can have several receptionists, each with its own name, greeting, language, knowledge, page, numbers, widgets and QR links ([receptionists](../features/receptionists.md)). The design of 2026-11-02 left these for later, each its own pull request, to build when businesses ask for them. The efforts are the design's estimates for one developer.

- **Status:** ready when needed, except more numbers per business, which waits on a decision about plans.
- **Effort:** 2 to 5 days each, and 5 or more for team members limited to some receptionists.

## Know what's left

| Feature | What it gives | Effort |
| --- | --- | --- |
| A chat handed to another receptionist | The receptionist moves a website chat to the one that helps with it, instead of giving its page's link; the chat keeps its history and the visitor stays on the page. Calls would still offer a message | 3 to 4 days |
| Alerts per receptionist | Each person chooses the receptionists whose calls, messages and follow-ups they're told about, so a store's manager hears only about their store | 2 to 3 days |
| More numbers per business | A number for each receptionist. Since 2026-10-23 a plan allows 0 or 1 business numbers, so this needs a plan that allows more first ([decisions](../project/decisions.md#choose-what-to-build)) | 3 to 5 days |
| Opening hours per receptionist | Each store of a chain keeps its own hours and closures, which its receptionist's calls, booking and page follow, with the business's hours as the default | 3 to 5 days |
| Team members limited to some receptionists | A member who sees and answers only the calls, messages and questions of the receptionists they're given, which chains will ask for | 5 days or more |

## Know the smaller items

- **A voice for each receptionist** comes with a voice picker ([custom voices](custom-voices.md)).
- **A number per Enterprise customer:** every custom plan gets the deployment's cap, `MAX_RECEPTIONISTS_PER_BUSINESS`. Giving one Enterprise customer 10 receptionists and another 30 needs a number on the custom plan, which migration `0134`'s check refuses, and a way to set it for one customer. The maintainer chose the one cap on 2026-11-04, until the first Enterprise customer needs its own ([decisions](../project/decisions.md#choose-what-to-build)).
- **A very large snapshot:** each text entry is stored once in the business's snapshot, and each receptionist keeps its best 50. If a business's snapshot ever passes 1 MB, text entries should move to the database search that files already use.
