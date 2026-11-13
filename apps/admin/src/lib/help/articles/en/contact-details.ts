import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "contact-details",
  title: "Contact details",
  section: "general",
  summary: "See one contact's calls, messages and appointments in one place, check whether they can get texts, and set the keypad PIN they use to change appointments by phone.",
  screenPaths: ["/contacts/{contactId}"],
  location: ["Sidebar", "General", "Contacts", "Select a contact"],
  access: "Everyone on the team can open a contact's page. Only owners and admins can block, unblock or delete the contact, and set or remove its keypad PIN.",
  purpose: [
    "A contact's page gathers what your AI receptionist and your team know about one person: their phone number and email, how often they called, wrote and booked, and each of those in one timeline.",
    "Use it before you call a customer back, to check their appointments, or to find out why they don't get texts. The **Details** tab shows whether they agreed to texts, said no or texted STOP, and whether they are blocked.",
    "When **AI settings** ask callers for a keypad PIN before they cancel or move an appointment, owners and admins set each customer's PIN here.",
  ],
  areas: [
    { name: "Contacts", description: "The link at the top goes back to the list of contacts." },
    { name: "Header", description: "The contact's name, or their phone number or email, or **Phone caller**, **Web caller**, **Website visitor** or **Unknown contact** when nothing else is known. Icons below show each way they have reached you. A blocked contact shows **Blocked** and when it was blocked." },
    { name: "More options", description: "The menu at the top right: **Block contact**, or **Unblock contact** for a blocked contact, and **Delete contact**. Only owners and admins can use them." },
    { name: "Phone, Email and First seen", description: "The contact's phone number with a button to copy it, their email, and the date the contact was added. A dash means nothing is saved." },
    { name: "Totals", description: "**Calls**, **Messages**, **Appointments** and **Conversations** count everything on record for the contact. Each call, text thread and website chat counts as one conversation." },
    { name: "Activity", description: "The first tab. Calls, messages and appointments in one timeline, latest first, each with how long ago it happened. An appointment sits at its start time, so upcoming appointments come first and show how soon they start. A call shows **Inbound call** or **Web call**, its length and how it ended: **completed**, **failed**, **blocked** or **in progress**, with **Archived** when the call was archived. Select a call to open its page. A text shows **Inbound SMS** or **Outbound SMS**. Other messages show where they came from, such as **Website chat**, or **Dashboard** for a message the receptionist took for your team, with **Sent** or **Received**. An appointment shows **Appointment**, its service, staff member and status. With nothing on record, the tab reads **No interactions recorded yet**." },
    { name: "Appointments", description: "The second tab. One card per appointment, latest start time first, cancelled ones included. With none, it reads **No appointments for this contact**." },
    { name: "Details", description: "The third tab. The contact's saved information, whether they are blocked, their answer about texts, their keypad PIN and the record's own details." },
  ],
  fields: [
    {
      title: "Appointments tab",
      description: "Each card shows the service, the staff member and a status: **Confirmed**, or **Cancelled** for a cancelled appointment. Below them are these values, which can't be edited here.",
      fields: [
        { name: "Date & time", description: "When the appointment starts, in your device's time zone." },
        { name: "Calendar", description: "Whether the appointment reached your connected calendar: **Pending** while it is on its way, **Synced** once the calendar is up to date, which for a cancelled appointment means it was taken off, and **Failed** when it couldn't be written. **Not required** means no connected calendar covers it." },
        { name: "Channel", description: "Where the appointment was booked: **Phone call**, **Web call**, **Website chat**, or **API** when an app connected to your business booked it." },
      ],
    },
    {
      title: "Contact information",
      description: "On the **Details** tab. A dash means nothing is saved.",
      fields: [
        { name: "Name", description: "The contact's name. The receptionist saves a caller's name after a call when the contact has none, and a contact that starts with a booking or a website visitor's details gets the name given there." },
        { name: "Phone", description: "The phone number the contact called or texted from, or gave when booking." },
        { name: "Email", description: "The contact's email, such as one a website visitor filled in." },
        { name: "Timezone", description: "The contact's own time zone, when an app connected to your business saved one." },
        { name: "Preferred language", description: "The contact's language, when an app connected to your business saved one." },
      ],
    },
    {
      title: "Contact block",
      description: "On the **Details** tab.",
      fields: [
        { name: "Status", description: "**Active**, or **Blocked** when the contact is blocked." },
        { name: "Blocked at", description: "When the contact was blocked." },
        { name: "Blocked by", description: "Shows a dash: the page doesn't say who blocked a contact." },
      ],
    },
    {
      title: "SMS consent",
      description: "On the **Details** tab. Whether the contact agreed to get texts from your business.",
      fields: [
        { name: "Status", description: "**Subscribed** means the contact agreed to texts, such as appointment reminders. **Declined** means they were asked and said no. **Opted out** means they texted STOP or another opt-out word, such as UNSUBSCRIBE or CANCEL on its own. A dash means they were never asked." },
        { name: "Last updated", description: "When the status was last recorded." },
        { name: "Source", description: "A short code for what set the status, such as a booking, an answer given on a call, or a keyword like STOP that the contact texted." },
      ],
    },
    {
      title: "Keypad PIN",
      description: "On the **Details** tab, under a line that says what the PIN is for. Owners and admins also see **Set PIN**, or **Set new PIN** and **Remove PIN** when a PIN is set.",
      fields: [
        { name: "Status", description: "**Set**, **Not set**, or **Locked after too many wrong tries**." },
        { name: "Set on", description: "When the current PIN was saved. A dash means no PIN is set." },
      ],
    },
    {
      title: "Set keypad PIN",
      description: "The dialog that opens from **Set PIN** or **Set new PIN**. It reminds you to give the PIN to the customer, because it can't be shown again, and that a new PIN also unlocks a locked one. **Cancel** closes it without saving.",
      fields: [
        { name: "PIN", requirement: "required", description: "4 to 8 digits that the customer types on their phone keypad. The box takes digits only, **Save PIN** stays off until you type one, and fewer than 4 digits shows **Use 4 to 8 digits**. One digit repeated or digits in a row, such as 1111 or 1234, are refused because they are too easy to guess. **Generate** fills in a random 6-digit PIN." },
      ],
    },
    {
      title: "System",
      description: "On the **Details** tab.",
      fields: [
        { name: "Contact ID", description: "The contact's reference, shortened, with a button to copy it in full. Share it when you ask for help with this contact." },
        { name: "Created", description: "The date and time the contact was added." },
      ],
    },
  ],
  tasks: [
    {
      title: "Check whether a contact can get texts",
      steps: [
        "Open the contact from the **Contacts** screen and select the **Details** tab.",
        "Look at **Status** under **SMS consent**. Only **Subscribed** contacts get texts your business starts, such as appointment reminders.",
        "Look at **Status** under **Contact block**. A **Blocked** contact gets no texts at all.",
      ],
    },
    {
      title: "Set a keypad PIN",
      steps: [
        "Open the contact and select the **Details** tab.",
        "Under **Keypad PIN**, select **Set PIN**, or **Set new PIN** to replace one.",
        "Type 4 to 8 digits in **PIN**, or select **Generate** for a random one.",
        "Note the PIN or give it to the customer now. It can't be shown again after you save it.",
        "Select **Save PIN**. **PIN saved.** shows, and **Status** reads **Set**.",
      ],
    },
    {
      title: "Unlock a locked PIN",
      steps: [
        "On the **Details** tab, check whether **Status** under **Keypad PIN** reads **Locked after too many wrong tries**.",
        "Select **Set new PIN**, type or generate a new PIN, and select **Save PIN**. The new PIN replaces the locked one.",
        "Give the new PIN to the customer.",
      ],
    },
    {
      title: "Remove a keypad PIN",
      steps: [
        "On the **Details** tab, select **Remove PIN** under **Keypad PIN**.",
        "In the **Remove this PIN?** dialog, confirm with **Remove PIN**. Until a new PIN is set, this customer can't change appointments by phone while **AI settings** require a keypad PIN.",
      ],
    },
    {
      title: "Block or unblock the contact",
      steps: [
        "Open **More options** at the top right of the page.",
        "Select **Block contact**, or **Unblock contact** for a blocked contact.",
        "Confirm with **Block contact** or **Unblock contact** in the dialog. While the contact is blocked, the header shows **Blocked** and the date.",
      ],
    },
    {
      title: "Delete the contact",
      steps: [
        "Open **More options** at the top right of the page and select **Delete contact**.",
        "In the **Delete contact?** dialog, confirm with **Delete contact**.",
        "The contact is removed for good, and the **Contacts** list opens. A contact with calls, conversations or appointments can't be deleted: the dialog stays open, and **Something went wrong. Please try again.** shows.",
      ],
    },
  ],
  notes: [
    "The **Activity** tab shows the latest 25 calls and 50 messages. It and the **Appointments** tab show the 25 appointments with the latest start times. The totals above the tabs count everything.",
    "Dates and times on this page are in your device's time zone. The **Appointments** screen shows each appointment in the time zone the business had when it was booked.",
    "The keypad PIN is used only when **Caller verification** under **Appointment changes** in **AI settings** is set to **Keypad PIN**. Callers type it on their phone keypad and then press the pound key (#), so the receptionist never hears it, and the call's transcript only notes that a PIN was typed. A caller without a PIN is passed to your team.",
    "The PIN is stored in a form nobody can read back, so the page only shows whether one is set. The app doesn't send it to the customer: give it to them yourself.",
    "Five wrong PINs in a row, across calls, lock the PIN until someone sets a new one. Nobody is alerted when that happens, so check here when a customer says their PIN stopped working.",
    "In a text conversation where the contact has texted you, your team's replies reach them even when they never agreed to texts or said no, unless they texted STOP or are blocked.",
    "Blocking stops every text to the contact and hangs up their phone calls at once. It doesn't stop website chats or calls from a browser.",
    "A contact with calls, conversations or appointments can't be deleted, so your history stays complete.",
    "The page shows what was on record when it opened. Reload it to see a call or message that came in since.",
    "With several AI agents, the page shows the contact's calls, messages and appointments with every receptionist together, without saying which one answered.",
  ],
  troubleshooting: [
    {
      question: "The page says Contact not found.",
      answer: "The contact was deleted, it belongs to a business you aren't viewing or can't open, or the page couldn't load it. Reload the page, go back to **Contacts** and search for the person, or switch to the right business at the top of the sidebar.",
    },
    {
      question: "A customer says their PIN doesn't work.",
      answer: "Look at **Keypad PIN** on the **Details** tab. If it reads **Locked after too many wrong tries**, set a new PIN and give it to them. If it reads **Not set**, the receptionist passes their request to your team instead of changing the appointment. If it reads **Set**, they may have the wrong PIN, so set a new one.",
    },
    {
      question: "Saving the PIN shows That PIN is too easy to guess.",
      answer: "PINs with one digit repeated or digits counting up or down, such as 1111, 1234 or 4321, are refused because they would be tried first. Choose another one or select **Generate**.",
    },
    {
      question: "I don't see Set PIN, and Block contact is turned off.",
      answer: "Only owners and admins can set PINs, and block or delete contacts. Ask an owner or admin, or ask them to change your role on the **Team** screen.",
    },
    {
      question: "Deleting or blocking shows Something went wrong. Please try again.",
      answer: "The change didn't go through, and the dialog stays open. On this page the message doesn't say why. A contact with calls, conversations or appointments can't be deleted, because they keep it in your records: select **Cancel**, and block the contact instead to stop hearing from the person. If blocking or unblocking failed, select **Cancel**, reload the page and try again.",
    },
    {
      question: "Setting or removing a PIN shows The PIN couldn't be saved or The PIN couldn't be removed.",
      answer: "The change didn't go through, and the PIN is as it was. Check your connection, reload the page and try again.",
    },
    {
      question: "A customer says they don't get our texts.",
      answer: "Open the **Details** tab. Under **Contact block**, **Blocked** means they get no texts at all: unblock them from **More options**. Under **SMS consent**, **Opted out** means they texted STOP or another opt-out word, and they get texts again only after they text START. **Declined** or a dash means they never agreed, so they don't get reminders or other texts your business starts, though your team's replies reach them in a conversation they texted. If all looks right, check on the **Messages** screen whether your texts show **Failed to send** or **Not delivered**.",
    },
    {
      question: "Why can't I edit the contact's name or number?",
      answer: "Contact details can't be edited on this page. They come from calls, texts, chats and bookings, and apps connected to your business can change them.",
    },
  ],
  related: ["contacts", "messages", "calls", "call-details", "appointments", "ai-settings"],
  keywords: ["contact page", "customer profile", "customer history", "caller history", "keypad PIN", "passcode", "PIN locked", "SMS consent", "opt out", "texts not received", "unblock contact", "customer details"],
};

export default article;
