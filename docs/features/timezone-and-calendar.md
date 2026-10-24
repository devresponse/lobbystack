# Set the business timezone and connect Google Calendar

The receptionist books appointments in the business's own timezone and, once Google Calendar is connected, checks free times there and writes each booking into it. This page covers both settings and what each symptom means when they go wrong. Checked against `main` at `da1f548`.

## Set the business timezone

A business starts with the timezone of the browser that created it, and every booking copies the business's timezone at the time it's made. Owners and admins change it in **AI settings** (`/agent/basic-settings`), from a list of every zone grouped by region with its offset. Saving checks the zone and refreshes the receptionist's saved context snapshot, so calls use it at once.

The picker came from this fork and was merged into the original as its #295, which moved it from Settings > Preferences to AI settings.

If bookings look a few hours off in Google Calendar but right in the dashboard, Google Calendar is displaying them in another zone: the worker sends Google each booking's moment in UTC without a zone label. Set the time zone in Google Calendar's own settings (**Settings > General > Time zone**), and in any separate booking calendar's settings.

## Connect Google Calendar

1. In Google Cloud, in the project that will own the OAuth client:
   - enable the Google Calendar API;
   - in Google Auth Platform, fill in **Branding** with the dashboard's domain under **Authorized domains**, and set **Audience** to External;
   - create a **Web application** OAuth client whose redirect URI is the dashboard's address plus `/api/calendar/google/callback`, exactly;
   - publish the app. An External app left in Testing gets refresh tokens that expire after 7 days for calendar scopes.
2. On the admin, set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` to the same values. The admin also uses `BETTER_AUTH_SECRET` to sign the OAuth state and `ENCRYPTION_KEY` to encrypt the tokens.
3. On the worker, set the same three Google variables (Railway references to the admin service work) and the same `ENCRYPTION_KEY`. Without them the worker skips calendar sync and checks.
4. In the dashboard, open **Integrations**, choose **Connect** on the Google Calendar card, allow every permission Google asks for, then pick a calendar the account owns or can write to. The choice saves on its own.

An operator can also send an owner a connect link: `POST /api/v1/calendars/google/connect` returns a link that works for 7 days. The callback switches the owner's dashboard to the business it was made for. Connecting another Google account retires the business's earlier connection.

## Know what the symptoms mean

| Symptom | Meaning | Fix |
| --- | --- | --- |
| "Google Calendar OAuth is not configured." | One of the three `GOOGLE_*` variables is empty on the admin. | Set them and redeploy. |
| The card says "Needs attention" and the calendar list is empty | The admin couldn't list the account's calendars: the Calendar API isn't enabled, or calendar permissions were left unticked on Google's consent screen. The connection still shows as connected. | Enable the API, or connect again and allow every permission. |
| The card stays on "Synchronizing" | The worker isn't syncing, most likely because it lacks the `GOOGLE_*` variables. | Set them on the worker. |
| A booking isn't in Google | It was made before a calendar was picked. The Appointments page's Calendar column shows its state. | Pick a calendar; the next sync fills in future bookings. |
| The receptionist takes messages instead of booking | The calendar hasn't synced in 20 minutes (`calendar_not_synced`), or booking is off. | Check the calendar card, **Booking > Appointments** set to "Books appointments", opening hours, and at least one active service. |

A receptionist that never books is often a business with no active services. Add one and it starts offering times.
