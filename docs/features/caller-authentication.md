# Verify callers before appointment changes

A caller can cancel or reschedule an appointment on a call. Before it acts, the receptionist checks that the caller is who they say they are, in one of four ways a business picks in **AI settings > Caller verification**. This page covers the modes, the keypad PIN the fork added, how to set PINs in bulk, and what is still untested. Checked against `main` at `da1f548`.

## Pick a verification mode

| Mode | What the caller does | Good for |
| --- | --- | --- |
| `phone_match_and_facts` | Calls from the number on the appointment and confirms its details. The default. | Low-risk bookings. |
| `otp_required` | Types a code that the business texts to the number on the appointment. | Businesses that send texts. |
| `passcode_required` | Types their own keypad PIN, then the pound key (fork PR #13). | Callers who share a phone or call from another one. |
| `operator_only` | Nothing: the receptionist takes a message for the team. | Businesses that make every change themselves. |

The website widget never offers the PIN or the text code, since a browser has no keypad and no verified number. Website visitors who want a change get a message taken for the team.

## Know why a PIN and not a spoken passcode

The caller's number alone is weak: the admin reads it from the call's SIP `From` header and trusts it, and nothing checks the carrier's STIR/SHAKEN rating (`X-Twilio-VerStat`) or that the call came through Twilio. Hardening that is about 2 days of work and wasn't chosen.

A spoken passcode was ruled out because GPT-Live hears it, the transcript and summary keep it, and OpenAI's own retention of call data applies to it. A keypad PIN never reaches GPT-Live: the worker reads the key presses, and the transcript says only `[typed a PIN]`.

## Know how the PIN works

[The voice runtime](../voice/runtime.md#keypad-pins) has the full detail. In short:

- `contact_passcodes` (migration `0097`) keeps a salted scrypt hash of each contact's PIN, with `OTP_HASH_SECRET` in the input. Changing that secret makes every saved PIN stop matching, so keep it the same on the admin and the worker and never rotate it casually.
- A PIN has 4 to 8 digits. The caller gets 3 tries per change, and 5 wrong PINs in a row, across calls, lock the contact's PIN until someone sets a new one.
- An accepted PIN counts for that appointment and caller on the same call for 10 minutes. Another call from the same number has to type it again (migration `0104` records the call).
- In this mode every key press is masked as `[pressed a key]` in the transcript for the whole call.

## Set PINs

- **One contact:** an owner or admin opens the contact in the dashboard and sets the PIN on its **Details** tab.
- **Many contacts, through the v1 API** (fork PR #14), with an owner's or admin's API key:
  - `POST /contacts/passcodes` sets or removes (with `null`) up to 100 PINs, all or nothing.
  - `POST /contacts/passcodes/generate` gives contacts random PINs and returns them once. Without `contact_ids`, it picks contacts that have a phone number and no PIN, oldest first, 100 per request, and says how many remain.
  - A contact shows `passcode: { set_at, locked }` or `null`, never the PIN.
  - Both ignore `Idempotency-Key`, because a stored response would keep the PINs.
- **From the command line:** `lobbystack contacts set-pins` and `lobbystack contacts generate-pins --all`.

Send each contact their PIN yourself; LobbyStack doesn't text or email it.

## Know what is untested

- No real phone call has typed a PIN yet. The first test on a deployment should be a call that cancels a test appointment with a correct PIN, then one with a wrong PIN three times.
- `pnpm voice:eval` has no PIN scenario, and it wasn't run for fork PRs #13 or #42.
- Nobody is alerted when a PIN locks; the contact's Details tab shows it.
