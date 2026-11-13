import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "contacts",
  title: "Contacts",
  section: "general",
  summary: "See everyone who has called, texted, chatted with or booked through your AI receptionist, how they reach you, and when they last got in touch.",
  screenPaths: ["/contacts"],
  location: ["Sidebar", "General", "Contacts"],
  access: "Everyone on the team can see the contacts and open them. Only owners and admins can block, unblock or delete a contact.",
  purpose: [
    "Contacts lists the people your AI receptionist has talked to. A contact is added by itself when someone calls or texts your business number for the first time, calls from a browser, books an appointment, or leaves their details in a website chat. Apps connected to your business can add contacts too. You don't add or edit contacts on this screen.",
    "Use it to find a customer, see how they reach you and how often, and open their page with their whole history, their answer about texts and their keypad PIN. The contacts with the most recent activity come first.",
    "Owners and admins can also block a contact, which stops texts to them and hangs up their phone calls, and delete a contact that has no history.",
  ],
  areas: [
    { name: "Search contacts...", description: "Finds contacts whose name, phone number or email contains what you type." },
    { name: "Contacts table", description: "One row per contact, most recent activity first. Select a row to open the contact's page. The columns are described below." },
    { name: "More options", description: "The menu at the end of each row: **Block contact**, or **Unblock contact** for a blocked contact, and **Delete contact**. Only owners and admins can use them. For everyone else they are turned off." },
    { name: "Pages", description: "When there are more than 10 contacts, choose how many show at once, from 10 to 50, under **Rows per page**, and move between pages with the arrows or the page numbers." },
  ],
  fields: [
    {
      title: "Contacts table",
      description: "The columns of the list. They show what is on record and can't be edited.",
      fields: [
        { name: "Contact", description: "The contact's name. Without one, it shows their phone number, then their email, then how they reached you: **Phone caller** for a call from a hidden number, **Web caller** for a call from a browser, **Website visitor**, or **Unknown contact**. The phone number and email also show under the name when it isn't one of them, and a **Blocked** label marks a blocked contact." },
        { name: "Channels", description: "An icon for each way the contact has reached you: **Phone call**, **Web call** (a call from a browser), **SMS** or **Website chat**. Point at an icon to see its name. A dash means none is recorded." },
        { name: "Activity", description: "How many messages and calls the contact has, such as **12 messages** and **3 calls**. Messages count texts, website chat messages and messages the receptionist took for your team, in both directions." },
        { name: "Appointments", description: "How many appointments the contact has, cancelled ones included." },
        { name: "Last interaction", description: "When the contact last called, wrote or got a message, or had an appointment that has started. A contact with no activity yet shows when it was added." },
      ],
    },
  ],
  tasks: [
    {
      title: "Find a contact",
      steps: [
        "Open **Contacts** in the sidebar.",
        "Type part of a name, phone number or email in **Search contacts...**.",
        "Select the contact's row to open their page.",
      ],
    },
    {
      title: "Block a contact",
      steps: [
        "Open **More options** at the end of the contact's row and select **Block contact**.",
        "The **Block contact?** dialog says what blocking does. Confirm with **Block contact**, or select **Cancel**.",
        "The row shows **Blocked**. The contact gets no more texts from your business, and their next phone calls are hung up at once.",
      ],
    },
    {
      title: "Unblock a contact",
      steps: [
        "Open **More options** at the end of the contact's row and select **Unblock contact**.",
        "In the **Unblock contact?** dialog, confirm with **Unblock contact**. Their calls go through again, and your team can reply to their texts.",
      ],
    },
    {
      title: "Delete a contact",
      steps: [
        "Open **More options** at the end of the contact's row and select **Delete contact**.",
        "In the **Delete contact?** dialog, confirm with **Delete contact**. The contact is removed for good.",
        "If the contact has any call, conversation or appointment, a message says it can't be deleted, and the contact stays.",
      ],
    },
  ],
  notes: [
    "Blocking stops every text to the contact, your team's replies and appointment confirmations and reminders included, and hangs up their phone calls at once. Their texts still arrive in **Messages**, but your team isn't alerted. Blocking doesn't stop website chats or calls from a browser.",
    "The receptionist can block a caller by itself when it ends a phone call because the caller was abusive. Unblock the contact if that was a mistake.",
    "A contact can only be deleted when it has no calls, conversations or appointments, so your history stays complete. Contacts that came from a call, a text or a booking always have one.",
    "One phone number belongs to one contact, so calls and texts from the same number are grouped together. A call from a browser, or from a hidden number, has no number to group by, so each one adds its own contact.",
    "Contact details can't be changed on this screen. They come from calls, texts, chats and bookings: for example, the receptionist saves a caller's name after the call when the contact had none.",
    "The list updates by itself when a call ends or a message comes in.",
    "With several AI agents, the list shows the contacts of every receptionist together. It has no receptionist filter, and a contact doesn't say which receptionist it talked to.",
  ],
  troubleshooting: [
    {
      question: "Deleting shows This contact can't be deleted because it still has linked conversations or appointments.",
      answer: "A contact with any call, conversation or appointment stays, so your records remain complete. Select **Cancel** to close the dialog. To stop hearing from the person, block the contact instead.",
    },
    {
      question: "Blocking or unblocking shows Something went wrong. Please try again.",
      answer: "The change didn't go through, and the dialog stays open. Select **Cancel**, reload the page and try again. Only owners and admins can block or unblock contacts.",
    },
    {
      question: "Why are Block contact and Delete contact turned off for me?",
      answer: "Only owners and admins can block, unblock or delete contacts. Ask an owner or admin to do it, or to change your role on the **Team** screen.",
    },
    {
      question: "Why does a contact show Phone caller or Web caller instead of a name?",
      answer: "Neither a name nor a phone number is known for them. **Phone caller** means the call came from a hidden number, and **Web caller** means it came from a browser, which has no number. Test calls your team makes from the dashboard are browser calls too, so each one adds a **Web caller** contact, which can't be deleted because it has a call. The receptionist saves a caller's name after a call when they give it, and a website visitor's name comes from the details they fill in.",
    },
    {
      question: "The same person shows up as two contacts.",
      answer: "Each phone number is its own contact, so a person who calls or texts from two numbers has two. Every call from a hidden number or from a browser adds a new contact too. A website visitor's details join an existing contact only when the email or phone number they give matches it. Contacts can't be merged, so search for the person by name, number or email to see each one.",
    },
    {
      question: "Search doesn't find a phone number I typed.",
      answer: "Phone numbers are saved in international form: a plus sign, the country code and the number, with no spaces. Type a few digits in a row, without spaces, brackets or dashes.",
    },
    {
      question: "The list says No contacts match the current search.",
      answer: "Clear the search box to see every contact. The message also shows while the business has no contacts yet. Contacts appear after the first call, text or booking, or when a website visitor leaves their details.",
    },
  ],
  related: ["contact-details", "messages", "calls", "appointments", "team"],
  keywords: ["customers", "callers", "clients", "people", "address book", "customer list", "block a caller", "blocked numbers", "delete contact", "duplicate contacts", "CRM"],
};

export default article;
