import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "integrations",
  title: "Integrations",
  section: "manage",
  summary: "Connect the app to the other tools your business uses: keep bookings in step with Google Calendar, send events to your own systems with webhooks, and connect Zapier or Make where your app offers them.",
  screenPaths: ["/integrations"],
  location: ["Sidebar", "Manage", "Integrations"],
  access: "Everyone on the team can open Integrations. Only owners and admins can connect, change or disconnect an integration. For everyone else the buttons are greyed out.",
  purpose: [
    "Integrations links the app to the tools your business already uses, so bookings, calls and messages reach them without anyone copying them by hand. Each tool has a card with a button to connect or manage it.",
    "Google Calendar works both ways. Your AI receptionist doesn't book over the busy events on the calendar you choose, and every appointment that is booked, moved or cancelled is added to, changed on or removed from that calendar. When the business has several AI agents, they all use the same calendar.",
    "The **Webhooks** card leads to the screen that sends events to your own systems. The **Zapier** and **Make** cards appear only when your app has its own Zapier integration or Make app. If you don't see them, they aren't offered for your app, and you can still connect other tools with webhooks and API keys.",
  ],
  areas: [
    { name: "Needs attention", description: "A red banner at the top, shown to owners and admins, when the app can't confirm it still has access to your Google calendar or the last sync failed. It asks you to retry the sync or reconnect your Google account." },
    { name: "Google Calendar", description: "The card's button shows the state of the connection: **Connect** when no Google account is connected, **Synchronizing** while the app reads a calendar you just chose, **Connected** while an account is connected and its last sync didn't fail, and **Reconnect Google** when the last sync failed and the connection needs fixing. **Connected** shows as soon as you connect an account, but nothing syncs until you choose a calendar. **Connect** takes you to Google to sign in. The others open the **Google Calendar** dialog." },
    { name: "Webhooks", description: "**Manage** opens the **Webhooks** screen, where you send calls, bookings and messages to your own tools." },
    { name: "Zapier", description: "Shown only when your app has its own Zapier integration, which connects the app to thousands of other apps without code. **Connect** opens the **Connect Zapier** dialog." },
    { name: "Make", description: "Shown only when your app has its own Make app, for visual scenarios that connect the app to your other apps. **Connect** opens the **Connect Make** dialog." },
    { name: "Google Calendar dialog", description: "Shows a warning when the connection needs attention, titled **Needs attention** or **Reconnect required**, with **Refresh** to try the sync again while the account is still connected. Below it you choose the **Google calendar**. At the bottom, **Disconnect** removes the connection and **Reconnect Google** signs in to Google again. If no account is connected yet, the dialog shows **Connect Google** instead." },
    { name: "Connect Zapier and Connect Make dialogs", description: "Each says what Zaps or scenarios can do and lists three steps: open the app in Zapier or Make, create an API key with **Create a key for Zapier** or **Create a key for Make**, and sign in from Zapier or Make with that key. A note at the bottom says when they can book appointments." },
  ],
  fields: [
    {
      title: "Google Calendar",
      description: "The dialog that opens from the Google Calendar card once a Google account is connected. It also opens by itself right after you connect one.",
      fields: [
        { name: "Google calendar", requirement: "required", description: "The calendar that receives bookings and whose busy events the receptionist won't book over. The list shows the calendars of the connected Google account, with (Primary) after its main calendar, and greys out the ones that account can't change. Nothing syncs until you choose one, and your choice saves as soon as you pick it." },
      ],
    },
  ],
  tasks: [
    {
      title: "Connect Google Calendar",
      steps: [
        "Open **Integrations** in the sidebar.",
        "On the **Google Calendar** card, select **Connect**.",
        "Sign in to Google with the account that holds the calendar, and allow every permission Google asks for. Finish within 10 minutes.",
        "Back in the app, the message **Google Calendar connected successfully.** shows and the **Google Calendar** dialog opens.",
        "Choose a calendar in **Google calendar**. It saves on its own, and the message **Saved Google calendar selection.** shows.",
        "Wait for the card's button to change from **Synchronizing** to **Connected**. The card updates by itself.",
      ],
    },
    {
      title: "Choose a different calendar",
      steps: [
        "Select **Connected** on the **Google Calendar** card.",
        "Choose another calendar in **Google calendar**. The app saves it and reads the new calendar from the start. Events already added to the earlier calendar stay there and aren't copied to the new one.",
      ],
    },
    {
      title: "Fix a connection that needs attention",
      steps: [
        "Select the button on the **Google Calendar** card to open the dialog.",
        "If the warning shows **Refresh**, select it to try the sync again. The sync runs in the background, so reload the page a minute later to see whether the warning has gone.",
        "If the warning stays, or it says **Reconnect required**, select **Reconnect Google** and sign in to Google again, allowing every permission.",
        "Check that the right calendar is chosen in **Google calendar**.",
      ],
    },
    {
      title: "Disconnect Google Calendar",
      steps: [
        "Select the button on the **Google Calendar** card to open the dialog.",
        "Select **Disconnect**. The connection is removed straight away, without a question to confirm it, and the message **Google Calendar disconnected.** shows.",
      ],
    },
    {
      title: "Connect Zapier",
      steps: [
        "On the **Zapier** card, select **Connect**. If there is no Zapier card, Zapier isn't offered for your app.",
        "Select the button that opens the app in Zapier, and accept the invitation there. Zapier asks you to sign in or create a free account first.",
        "Back in the dialog, select **Create a key for Zapier**. The **API keys** screen opens with **Create an API key** already set up for Zapier.",
        "Select **Create key** and copy the key. You see it only once.",
        "In Zapier, make a Zap and choose the app. When Zapier asks you to sign in, paste the key into **API Key** and check that the app's address is the address of this dashboard, which the **Connect Zapier** dialog shows.",
      ],
    },
    {
      title: "Connect Make",
      steps: [
        "On the **Make** card, select **Connect**. If there is no Make card, Make isn't offered for your app.",
        "Select the button that opens the app in Make, and install it in your Make organization. Make asks you to sign in or create a free account first.",
        "Back in the dialog, select **Create a key for Make**. The **API keys** screen opens with **Create an API key** already set up for Make.",
        "Select **Create key** and copy the key. You see it only once.",
        "In Make, add one of the app's modules to a scenario and choose **Create a connection**. Paste the key into **API key** and check that the app's address is the address of this dashboard, which the **Connect Make** dialog shows.",
      ],
    },
    {
      title: "Send events to your own system",
      steps: [
        "On the **Webhooks** card, select **Manage**.",
        "Select **Add endpoint** on the **Webhooks** screen and follow the form.",
      ],
    },
  ],
  notes: [
    "The app reads the busy times on the chosen calendar for the next 90 days and reads them again about every 15 minutes.",
    "Any event on the chosen calendar that shows as busy blocks its time, so an all-day event set to busy blocks the whole day. Events marked as free, cancelled events and events you declined don't block any time.",
    "After a failed sync, the app keeps trying at each sync, and the card goes back to **Connected** once one works. If it stays on **Reconnect Google**, reconnect the account.",
    "Each appointment appears on the chosen calendar under the service's name, with the customer's name in the description when it is known. Moving an appointment moves the event, and cancelling it removes the event.",
    "Upcoming appointments booked before you chose a calendar are added to it at the next sync.",
    "Once a calendar is chosen, the receptionist confirms a time only when the calendar has synced in the last 20 minutes, and only up to about 90 days ahead. Otherwise it offers to take the customer's name, number and preferred time so your team can book it.",
    "Connecting a different Google account replaces the one connected before, so choose a calendar again afterwards. Reconnecting the same account keeps the calendar you chose.",
    "Disconnecting stops the receptionist from checking Google Calendar and adding bookings to it. Events already on the calendar stay there, and they no longer change when those bookings are moved or cancelled.",
    "When a business is handed over to a new owner, a Google Calendar connected by the person who handed it over is disconnected, and the webhooks they or a partner set up are turned off. The new owner can connect their own calendar here and turn the webhooks back on from the **Webhooks** screen.",
    "When the calendar or a booking can't sync, everyone on the team who has **Calendar sync issue** turned on in **Notifications** gets an alert. The **Calendar** column on the **Appointments** screen shows whether each booking reached the calendar.",
    "Zaps can start when a call ends, an appointment is booked, moved or cancelled, a message is taken or a contact is added. They can also add and update contacts, book, move and cancel appointments, and add knowledge for the receptionist. Make scenarios can do the same and can also look up calls, appointments and contacts.",
    "Zaps and scenarios can book appointments only while **Appointments** on the **AI settings** screen is set to **Books appointments**. With several AI agents, the default receptionist's setting counts.",
    "A Zap or scenario that starts when something happens adds its own endpoint on the **Webhooks** screen, with a description that starts with `Zapier:` or `Make:`.",
  ],
  troubleshooting: [
    {
      question: "I see \"Unable to complete the Google Calendar connection.\" What went wrong?",
      answer: "The Google sign-in was cancelled or couldn't be finished. Select **Connect** or **Reconnect Google** to try again, and allow every permission Google asks for.",
    },
    {
      question: "After the Google sign-in, a page says \"Google OAuth state is invalid or expired.\" What happened?",
      answer: "Each Google sign-in started from this screen works once, for 10 minutes, and only for the person who started it. Go back to **Integrations**, select **Connect** or **Reconnect Google** again, and finish the Google sign-in within 10 minutes while signed in to the dashboard as the same person. The same applies when the page says the state has already been used or belongs to another user.",
    },
    {
      question: "I see \"Request failed.\" when I connect, refresh, choose a calendar or disconnect. What can I do?",
      answer: "The app couldn't finish the request, for example because Google didn't answer in time. Reload the page and try again a little later. If **Connect** keeps failing this way, Google Calendar may not be available for your app yet, so contact support.",
    },
    {
      question: "I see \"Too many calendar authorization attempts. Please try again later.\" What can I do?",
      answer: "The app limits how often a Google sign-in can be started. Wait up to an hour, then try again.",
    },
    {
      question: "The calendar list is empty, or every calendar is greyed out. Why?",
      answer: "Only calendars that the connected Google account owns or can make changes to can be chosen. If the list is empty, Google didn't give the app access to your calendars: select **Reconnect Google** and allow every permission. To use a calendar someone else owns, ask them to share it with that account with permission to make changes to events.",
    },
    {
      question: "Choosing a calendar fails with \"Select a calendar you can write to.\" What does it mean?",
      answer: "The connected Google account can only see that calendar, not change it. Choose a calendar the account owns or can make changes to.",
    },
    {
      question: "The receptionist takes messages instead of booking appointments. Why?",
      answer: "Once a calendar is chosen, the receptionist books only when the calendar has synced in the last 20 minutes. If the card shows **Reconnect Google** or the **Needs attention** banner, fix the connection. Also check that **Appointments** on the **AI settings** screen is set to **Books appointments**, that **Opening hours** are set there, and that the **Services** screen has at least one bookable service. With several AI agents, each receptionist has its own **Appointments** setting.",
    },
    {
      question: "The receptionist won't book times that look free in Google Calendar. Why?",
      answer: "Every event on the chosen calendar that shows as busy blocks its time, and an all-day event set to busy blocks the whole day. In Google Calendar, set such events to show as free, or choose a calendar that holds only the events that should block bookings. The receptionist also offers times only inside the **Opening hours** on the **AI settings** screen.",
    },
    {
      question: "A booking isn't in Google Calendar. What can I check?",
      answer: "Look at the **Calendar** column on the **Appointments** screen. **Pending** means it is on its way and **Synced** means it is there. **Not required** means no calendar was chosen when it was booked: once you choose one, bookings that haven't ended are added at the next sync. If it says **Failed**, open the **Google Calendar** dialog and fix the connection.",
    },
    {
      question: "Bookings show at the wrong time in Google Calendar. Why?",
      answer: "Google Calendar shows events in the time zone set in its own settings. If a booking is right in the dashboard but hours off in Google Calendar, correct the time zone in Google Calendar's settings. The time zone the receptionist books in is **Business timezone** on the **AI settings** screen.",
    },
    {
      question: "The card says Synchronizing. Is something wrong?",
      answer: "Usually not. The app is reading the calendar you chose, and the button changes to **Connected** by itself when it finishes. Until then the receptionist can't confirm appointment times. If it doesn't change after a few minutes, open the dialog, select **Reconnect Google** and sign in again. If it still doesn't change, contact support.",
    },
    {
      question: "Why are the buttons greyed out?",
      answer: "Only owners and admins can connect or change integrations. Other team members see every button turned off, and for them the **Google Calendar** card shows **Connect** even when a calendar is connected. Ask an owner or admin for help, or to change your role on the **Team** screen.",
    },
    {
      question: "I don't see Zapier or Make. Why?",
      answer: "Those cards appear only when your app has its own Zapier integration or Make app. Without them, you can still send events to other tools from the **Webhooks** screen, and give tools access to your data with a key from the **API keys** screen.",
    },
  ],
  related: ["webhooks", "api-keys", "appointments", "ai-settings", "services", "notifications"],
  keywords: ["Google Calendar", "calendar sync", "calendar not syncing", "reconnect Google", "Zapier", "Make", "connect apps", "third party tools", "automation", "calendar connection", "busy times", "sync bookings"],
};

export default article;
