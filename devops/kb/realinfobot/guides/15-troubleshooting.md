# RealInfoBot troubleshooting

Quick checks for the problems RealInfoBot users meet most often. Each screen's own guide has more answers. If a check doesn't solve it, email support@realinfobot.com with your account email, what you expected and when it happened.

## The assistant doesn't answer my phone number, or callers hear a busy signal

1. **Minutes:** on the **Usage** tab in **Settings**, **Voice minutes** saying **No minutes left** or **Limit reached** means calls get a busy signal until you buy a pack or a top-up on the **Plan** tab.
2. **Pack:** when your last pack ends, the number stops answering at once and is released 30 days later. The **Phone Number** tab shows the release date.
3. **Who answers:** check **Answered by** on the **Phone Number** tab. A paused agent's calls go to your default agent.
4. **Blocked caller:** calls from a blocked contact are hung up.

Then call the number from another phone. Note the time of a failed call for support.

Also asked as: number not working, no answer, busy signal, calls not going through, phone dead.

## The assistant gave a wrong answer, or said it didn't know

The assistant answers only from your knowledge and settings. Open the conversation on **Calls** or **Messages** to see what was said, then:

- Add or correct the fact on the **Knowledge** screen, or answer the question on the **Questions** screen.
- Check the document's status is **Ready**, not **Error**, **Queued**, **Indexing** or **Disabled**.
- With several listings, check the entry is available to that listing's agent.
- Delete an old document that still holds the old fact.
- Write a rule on the **Rules** screen if the problem was how it acted rather than what it said.

A call already in progress keeps what it started with, so test with a new call or chat.

Also asked as: incorrect answer, bot made a mistake, wrong price, outdated information, it didn't know.

## The assistant takes messages instead of booking showings

On the **AI settings** screen, check that **Appointments** is set to **Books appointments** for the agent that answers, that your opening hours are set, and that at least one service, such as a showing, is turned on and bookable on the **Services** screen. If Google Calendar is connected and hasn't synced recently, the assistant can't confirm times and offers to take a message. **Takes requests** never books: it sends the preferred time to your team to confirm.

Also asked as: not booking, can't schedule showings, appointments not working, booking off.

## Calls aren't being put through to my phone

Check that **Default transfer number** is saved on the **AI settings** screen, with + and the country code, for the agent that answers. Transfers happen only on phone calls to your RealInfoBot number, never in a test call, a browser call or a chat. Each one counts toward your plan's transfer attempts, and when they run out the assistant takes a message instead.

Also asked as: transfer not working, forward calls, live transfer, call me directly.

## My QR code or listing page doesn't open

- **Page-not-found:** your page isn't published. Select **Publish page** on the **Public profile** screen. Signs you already printed start working at once.
- **Opens the wrong listing:** the link is paused, or its agent is paused or archived, so the sign opens your business page or the default agent. Resume it, or choose another agent with **Edit** on the **QR code** screen.
- **Doesn't scan well:** print at actual size (100%), not Fit to page, on matte paper, big enough for how far away people stand.
- **No chat on the page:** the **Chat** setting on **Public profile** must name an active website widget.

Also asked as: QR not working, scan doesn't work, page not found, wrong listing opens, broken link.

## The chat doesn't show on my website

Check that the snippet is on the page and that your website builder published the change, then reload the live page, not a preview. If the chat opens but says **This website is not authorized to load this widget**, add the site's exact address to **Allowed origins** on the **Website widget** screen: an address with www and one without it are different, and so are http and https. **This widget is not available** means the widget is paused or revoked.

Also asked as: widget not showing, chat button missing, not authorized, embed not working.

## The chat doesn't offer a call from the browser

The call button shows only when your business has a phone number, browser calls are available for your account, and you have voice minutes left. The free plan has no number, so its chats don't offer calls. Get a number on the **Phone Number** tab with a listing pack, and check minutes on the **Usage** tab.

## I'm not getting alerts

On the **Notifications** tab in **Settings**, check that **Email** or **SMS** is on under **Channels** and that the alert is ticked in that column. The **SMS** column starts with nothing ticked, and a mobile number must be confirmed with a code first. Email alerts go to the address you sign in with, so check its spam folder. Choices apply only to the business you have open, so check each business. If the SMS switch says the workspace has no alert SMS sender, email support.

Also asked as: no notifications, no emails, no text alerts, missed inquiry alert.

## My uploaded document isn't used, or won't upload

- Wait until its status is **Ready**; **Error** shows the problem under it.
- A scanned PDF is read with text recognition up to 25 pages; a longer scan can't be read, so upload a text version.
- Files can be PDF, Word (DOCX), text or Markdown, up to 25 MB each.
- **Knowledge storage limit reached** means the plan's storage is full: delete documents you don't need, or buy a bigger pack.

Also asked as: upload failed, PDF not working, document error, storage full.

## I paid, but my pack doesn't show

Wait a minute and reload the **Plan** tab: a pack shows once the payment arrives, usually within moments. Check **Transaction history** on the same tab. If the screen says the payment was refunded or charged back before it arrived, no pack was added. If you were charged and nothing shows after a few minutes, email support@realinfobot.com with your order number.

Also asked as: payment not showing, charged but no pack, plan didn't change, missing purchase.

## A team member can't see a button or change a setting

Viewers can look but not change anything, and only owners and admins invite people, change settings, buy packs, make QR links and test calls. Only owners delete the business or cancel the account. Ask an owner or admin, or have them remove and re-invite the person as an admin.

Also asked as: greyed out, button missing, no access, permission denied, can't edit.

## The test call doesn't connect

Only owners and admins make test calls. Allow the browser to use your microphone, or try another browser. If it says your AI agent is unavailable, the business may have used its voice minutes, which the **Usage** tab shows. If it says too many test calls have been started, wait a little and try again.

Also asked as: test call not working, microphone blocked, can't hear the assistant.

## A text I sent from Messages failed

The reason shows under the text. **This number can't get texts** means the buyer's number can't receive texts, and **Your business's number isn't allowed to text this country** means your number can't text there. The reply box is off for a contact who is blocked, texted STOP, has no phone number, or hasn't texted you or agreed to texts. A contact who texted STOP gets texts again only after they text START.

Also asked as: SMS failed, text not delivered, can't text buyer, STOP.
