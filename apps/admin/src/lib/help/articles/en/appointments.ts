import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "appointments",
  title: "Appointments",
  section: "general",
  summary: "See the appointments that haven't ended yet, soonest first, check that each one reached your connected calendar, and cancel one when needed.",
  screenPaths: ["/appointments"],
  location: ["No link in the app", "Open /appointments in the address bar"],
  access: "Everyone on the team can see the appointments. Owners, admins and schedulers can cancel them. Viewers don't see the **Cancel** button.",
  purpose: [
    "Appointments lists the bookings that haven't ended yet, soonest first: the ones your AI receptionist booked on calls and in website chats, and the ones apps connected to your business booked. Cancelled appointments are left out.",
    "Use it to see who is coming and when, to check that each booking reached your connected calendar, and to cancel a booking the customer can't keep.",
    "No menu links to this screen. To open it, replace everything after the dashboard's address in the browser's address bar with `/appointments`, then bookmark the page. The **Upcoming** list on **Home** shows the next few appointments too.",
  ],
  areas: [
    { name: "Summary", description: "Under the title: the business's name and how many upcoming appointments the list holds." },
    { name: "Refresh", description: "Reloads the list. The list also updates by itself when an appointment is booked, moved or cancelled, or when its calendar status changes." },
    { name: "Appointments table", description: "One row per appointment, soonest first. The columns are described below. While the list loads it reads **Loading appointments**, and with nothing to show it reads **No upcoming appointments**." },
    { name: "Cancel", description: "The button at the end of each row, for owners, admins and schedulers. It opens **Cancel this appointment?**, which names the service, the customer and the time, and nothing is cancelled until you confirm." },
  ],
  fields: [
    {
      title: "Appointments table",
      description: "The columns of the list. They show what is booked and can't be edited here.",
      fields: [
        { name: "Time", description: "The day and start time, in the time zone the business had when the appointment was booked." },
        { name: "Customer", description: "The contact's name or, when no name is known, their phone number, their email, or a label such as **Phone caller**." },
        { name: "Service", description: "The service that was booked." },
        { name: "Staff", description: "The staff member the appointment is with." },
        { name: "Status", description: "The booking's status, normally **Confirmed**." },
        { name: "Calendar", description: "Whether the appointment reached your connected calendar. **Pending** means it is on its way, **Synced** means it is there, and **Failed** means it couldn't be written. **Not required** means no connected calendar covers it, for example because none is connected." },
      ],
    },
  ],
  tasks: [
    {
      title: "Open the Appointments screen",
      steps: [
        "Open any screen of the dashboard in your browser.",
        "In the address bar, replace everything after the dashboard's address with `/appointments` and press Enter.",
        "Bookmark the page so you can come back in one click.",
      ],
    },
    {
      title: "Cancel an appointment",
      steps: [
        "Find the appointment in the list and select **Cancel** at the end of its row.",
        "In the **Cancel this appointment?** dialog, check the service, customer and time.",
        "Select **Cancel appointment** to cancel it, or **Keep appointment** to leave it as it is.",
        "**Appointment cancelled** shows, and the appointment leaves the list.",
      ],
    },
    {
      title: "Check that a booking reached your calendar",
      steps: [
        "Find the appointment and read its **Calendar** column.",
        "If it reads **Failed**, open the **Integrations** screen and check the calendar connection.",
        "If it reads **Not required**, connect a calendar on the **Integrations** screen and pick one. Bookings that haven't ended yet are then added to it.",
      ],
    },
  ],
  notes: [
    "The list shows up to 100 appointments that haven't ended and aren't cancelled. An appointment in progress stays until its end time.",
    "Cancelling removes the appointment from your connected calendar, skips its reminder and closes any request the customer made to cancel it. If it hasn't started yet, and the customer agreed to texts and isn't blocked, they get a text saying it was cancelled.",
    "If someone else cancelled the appointment a moment before you, cancelling still shows **Appointment cancelled**.",
    "This screen can't book or move appointments. The receptionist books them when **Appointments** under **Booking** in **AI settings** is set to **Books appointments**. With several AI agents, each receptionist has its own **Appointments** setting instead, under **Each receptionist's own**. Callers can ask it to cancel or move theirs when **Allow AI cancellations** or **Allow AI rescheduling** is turned on under **Appointment changes** in **AI settings**.",
    "When **Appointments** is set to **Takes requests**, the receptionist passes appointment requests to your team instead of booking them, so they don't appear here. They show under **Action required** on **Home**, and a request taken on a call also shows in **Messages**.",
    "Past and cancelled appointments don't show here. Open the customer from the **Contacts** screen and look at their **Appointments** tab.",
    "When an appointment can't be written to your calendar, your team can get a **Calendar sync issue** alert, chosen on the **Notifications** screen.",
    "**Home** shows the next five appointments under **Upcoming**, with the same **Cancel** button.",
    "With several AI agents, the list shows every receptionist's appointments together. It has no receptionist filter.",
  ],
  troubleshooting: [
    {
      question: "I can't find Appointments in the menu.",
      answer: "No menu links to this screen. In the browser's address bar, replace everything after the dashboard's address with `/appointments`, then bookmark the page. **Upcoming** on **Home** also shows the next five appointments.",
    },
    {
      question: "The list says Appointments are unavailable.",
      answer: "The list couldn't load. Select **Refresh** or reload the page. If it keeps happening, try again in a few minutes.",
    },
    {
      question: "The list says No upcoming appointments, but I expected some.",
      answer: "Only appointments that haven't ended and aren't cancelled show here, so look for past or cancelled ones on the customer's page under **Contacts**. If the receptionist takes messages instead of booking, check the booking setting in **AI settings** and that the business has at least one active service on the **Services** screen. With a connected calendar, also check on the **Integrations** screen that it works, because the receptionist can't confirm times while it can't read the calendar.",
    },
    {
      question: "Why don't I see the Cancel button?",
      answer: "Viewers can't cancel appointments. Ask an owner, admin or scheduler to cancel it, or ask an owner or admin to change your role on the **Team** screen.",
    },
    {
      question: "Cancelling shows We couldn't cancel the appointment. Try again.",
      answer: "The cancellation didn't go through, and the appointment is still booked. Wait a moment and select **Cancel** again.",
    },
    {
      question: "An appointment shows Failed in the Calendar column.",
      answer: "It couldn't be written to your connected calendar. Check the connection on the **Integrations** screen.",
    },
    {
      question: "The time in my calendar app is a few hours off.",
      answer: "This screen shows each appointment in the time zone the business had when it was booked. When your calendar app shows another time, check the time zone set in the calendar app's own settings.",
    },
    {
      question: "The page says Choose a workspace to view appointments.",
      answer: "No business is selected. Pick one at the top of the sidebar, then come back to this page.",
    },
  ],
  related: ["home", "contact-details", "integrations", "ai-settings", "services", "notifications"],
  keywords: ["bookings", "schedule", "upcoming appointments", "appointment list", "calendar", "cancel a booking", "reservations", "calendar sync", "agenda"],
};

export default article;
