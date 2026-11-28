# The Call details screen in the RealInfoBot app

Open one call to read the transcript, play or download the recording, follow the steps the call went through and close the follow-ups your AI receptionist took.

- Where to find it: Sidebar > General > Calls > Select a call
- Who can use it: Everyone on the team can open a call, read its transcript and play or download its recording. Owners, admins and schedulers can mark follow-ups done, and only owners and admins can archive and restore calls.
- Address: `/calls/{callId}`

Also known as: call page, transcript, call recording, download recording, follow-up, mark done, archive call, restore call, call events, callback, call ID, copy phone number, keypad.

## What the Call details screen is for

A call's page shows one call: who called, when and for how long, which receptionist answered when the business has several AI agents, what was said, the recording, and any message or request the receptionist took for your team that is still open.

You reach it by selecting a call on the **Calls** screen, the title of a callback or cancellation request that came from a call in **Action required** on **Home**, or a call on a contact's **Activity** tab. The email your team can get after a call the caller spoke on links to it too.

Use it to check how the receptionist handled a caller, to follow up on a message, and to keep the **Calls** list tidy by archiving calls you don't need there, such as your own test calls.

## What you see on the Call details screen

- **Calls**: The link at the top goes back to the **Calls** list.
- **Caller**: The caller's name as the page title. Without a saved name, it shows their number or email address, or **Phone caller** or **Web caller** when the caller left no details. **Blocked** shows, with a date, when the caller is blocked or the call was blocked. **Archived** shows, with the date, when the call has been archived.
- **Archive and Restore**: Owners and admins see **Archive** beside the caller's name, or **Restore** on an archived call.
- **Call events**: The steps the call went through, from left to right, each with its time when known: **Received**, **Connected**, **Transferred** when the receptionist tried to transfer the call, then **Completed** or **Failed**. **Failed** marks a call that was missed, busy, cancelled or couldn't start because of a technical problem, and **Transferred** has a red cross when the transfer didn't go through. A call from a blocked contact goes from **Received** straight to **Blocked**. A green check marks a step the call reached, a red cross a step that failed, and a grey circle a step not reached yet, such as **Completed** while the call is still going.

## What you see on the Call details screen (continued)

- **Transcript**: The tab that opens first. It shows the conversation turn by turn: the caller's words on the left, marked **Caller**, and the receptionist's on the right, marked **Assistant**. Keys pressed on a phone keypad show in square brackets, such as `[pressed 1]`. When the business takes keypad PINs, the keys are hidden and show as `[pressed a key]` or `[typed a PIN]`. A key pressed in the first moment of a phone call can show as `[pressed a key]` too.
- **Recording**: A player for the call's audio: **Play** and **Pause**, a bar to move through the call, the time left, and **Download audio** to save the file. Until the recording is ready, or when there is none, the tab says **No recording is available for this call**.
- **Details**: The call's open follow-ups, each with **Mark done**, and **Call information**: the call's technical references, which support may ask for, and its **Duration**.

## Below the caller's name, on the Call details screen

A row of facts about the call.

- **From**: The caller's phone number, with a button to copy it. A browser call from a caller without a saved number shows **Web call** instead, and a phone call with no number to show, such as one from a hidden number, shows **No number**. These have no copy button.
- **Receptionist**: The receptionist that answered the call. It only shows when the business has several AI agents.
- **Duration**: How long the call lasted, in minutes and seconds. A dash shows while the call is in progress or when no length was recorded.
- **Started**: The date and time the call started.
- **ID**: The call's reference, shortened to fit, with a button that copies it in full. Give it to support when you ask about a call.

## Details, on the Call details screen

The third tab of the page.

- **Follow-up task**: Each open message or request the receptionist took on this call, such as a message to call the customer back or book a time, or a request to cancel an appointment. The heading reads **Follow-up tasks** when there are several. Each starts with who it is from, such as **Voice message from** and the caller's name. Below come, when the caller gave them, the number to call back, how urgent it is and when they would like the call, then what they said. A request to cancel says **Cancellation request**, followed by the appointment the caller described. When the call left nothing open, the tab says **No follow-up task for this call**.
- **Call information**: References for the call from the phone and voice services, such as **Gateway session** or **Provider call ID**, and the call's **Duration**. You only need them when support looks into a call.

## How to read what was said on a call, on the Call details screen

1. Open **Calls** in the sidebar and select the call.
2. Read the conversation on the **Transcript** tab, which opens first.

## How to listen to or download the recording, on the Call details screen

1. Select the **Recording** tab.
2. Select **Play**. Drag the bar to jump to another part of the call.
3. To keep a copy, select **Download audio**.

## How to mark a follow-up done, on the Call details screen

1. Select the **Details** tab.
2. Read the follow-up and deal with it, for example by calling the customer back.
3. Select **Mark done**. The follow-up closes and leaves **Action required** on **Home**.

## How to archive a call, on the Call details screen

1. Select **Archive** beside the caller's name. Only owners and admins see it.
2. In **Archive this call?**, select **Archive call**, or **Cancel** to keep it.
3. **Call archived.** shows, and you return to the **Calls** list, which no longer shows the call.

## How to restore an archived call, on the Call details screen

1. Open the caller on the **Contacts** screen and select the call on their **Activity** tab, where it is marked **Archived**.
2. Select **Restore**. **Call restored.** shows, the call goes back to the **Calls** list, and you stay on its page.

## How to copy the caller's number or the call's reference, on the Call details screen

1. Select the copy button beside **From** or **ID**.
2. A check mark shows for a moment once it is copied.

## Good to know about the Call details screen

- Archiving hides a call from the **Calls** list, its search and **Recent Calls** on **Home**. Nothing is deleted: the transcript, recording and follow-ups stay, the call still counts on **Home**, on the **Analytics** screen and in your usage, and its page still opens.
- There is no list of archived calls. Reach one from the caller's **Activity** tab on the **Contacts** screen, which lists their 25 latest calls, or from a link to it, such as a follow-up on **Home** or the email after the call.
- Marking the call's message done closes every message from that call. Each request to cancel an appointment is marked done on its own.
- **Mark done** on a request to cancel closes the request without cancelling the appointment, so cancel the appointment first. **Approve cancellation** on **Home**, or **Cancel** on the **Appointments** screen, cancels it and also closes a request that names the appointment.
- The page updates by itself while it is open. As the call ends, its steps, its length, the caller's name and the recording fill in.
- A recording is saved a short while after the call ends, usually within a few minutes, and the **Recording** tab shows it as soon as it is ready, without reloading the page.

## Good to know about the Call details screen (continued)

- Transcripts, recordings and follow-ups are kept for a limited time that depends on your plan. After that, the call's page stays without them, and a follow-up still open shows as **Expired voice message**, without what the caller said.
- Every call tells the caller, right after the greeting, that they're speaking with an AI and that the call is recorded and transcribed, unless **Tell callers about AI and recording** is turned off on the **AI settings** screen.
- Times show in your device's time zone, in the **Time format** chosen on the **Preferences** screen.

## The page says Call not found. Why? (Call details screen)

The call doesn't exist, or it belongs to another business. If you belong to several businesses, choose the one the call belongs to at the top of the sidebar, then open the link again. The page also says this when it couldn't load the call, so if the call should be there, reload the page.

## Why is there no transcript? (Call details screen)

The tab says **No transcript segments are available for this call yet** when nothing was said, for example on a call that never connected or came from a blocked contact. A transcript is also removed once it is older than your plan keeps it.

## Why is there no recording? (Call details screen)

Right after a call ends, the recording takes a few minutes to be saved, and the tab shows it by itself once it is ready. If the tab still says **No recording is available for this call** well after the call, the call wasn't recorded, for example because it never connected, or its recording is older than your plan keeps it.

## The recording won't play or download. What can I do? (Call details screen)

Reload the page and try again. The link to a recording only works for a few minutes after the page loads, so a page left open for a while needs a fresh one.

## I selected Mark done and got Something went wrong. Please try again. Why? (Call details screen)

Viewers can see follow-ups but can't mark them done. Ask an owner, admin or scheduler to do it, or ask an owner or admin to change your role on the **Team** screen. If you are an owner, admin or scheduler, check your connection and try again.

## Why can't I see the Archive button? (Call details screen)

Only owners and admins can archive calls, because it hides the call from the whole team. Ask an owner or admin to archive it, or to change your role on the **Team** screen.

## Archiving shows Couldn't archive the call, or restoring shows Couldn't restore the call. (Call details screen)

Nothing changed, and the call stays where it was. Check your connection and try again. If your role was changed meanwhile, only owners and admins can archive or restore a call.
