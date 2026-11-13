import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "ai-agents",
  title: "AI agents",
  section: "agent",
  summary: "Add a receptionist for each location, team or language, and edit, order, pause, archive or restore them, or choose the default one, within the number of active receptionists your plan includes.",
  screenPaths: ["/agent/receptionists"],
  location: ["Sidebar", "Agent", "AI agents"],
  access: "Everyone on the team can see the receptionists. Only owners and admins can add, edit, order, pause, resume, archive or restore them, or make one the default.",
  purpose: [
    "Every business starts with one receptionist, its default one, named Front desk or its translation in the business's language. It answers your phone numbers, your website widget and your business page. **AI agents** lists your receptionists and lets you add others, such as one for each location, team or language, so each can greet callers in its own way and answer from its own articles.",
    "This screen holds who each receptionist is: its name, what it helps with, the address of its own page, its language, which articles it answers from and whether visitors can choose it on your business page. How it answers, with its greeting, transfer number and booking, is set on the **AI settings** screen.",
    "Everything else belongs to the business and is shared by every receptionist: the business summary, what callers hear about AI and recording, the business's language and time zone, opening hours, the rules for changing appointments, services, rules and contacts.",
    "The default receptionist answers anything that names no receptionist and stands in for one that is paused or archived, so a phone number, a website widget or a printed QR code always reaches someone. You choose which receptionist answers each phone number, website widget and QR code on the **Phone Number**, **Website widget** and **QR code** screens.",
  ],
  areas: [
    { name: "Plan allowance", description: "At the top, a line says how many active receptionists your plan includes and how many are in use. When they're all in use, it says what you can do, and owners and admins see **See plans** or **Contact sales** beside it when a plan with more is available. When the business keeps the most receptionists it can, the line says so. When your plan includes one receptionist and a plan with more is available, a card shows instead: **A receptionist for each location, team or language**, with the same button for owners and admins and, for everyone else, a note to ask an owner or admin." },
    { name: "Search and status filter", description: "Shown once the business has more than one receptionist, archived ones included. The search box finds receptionists by their name or what they help with. The status filter beside it shows **All**, **Active**, **Paused** or **Archived**, each with how many there are. **All** lists every receptionist that isn't archived." },
    { name: "Sort A-Z and Add receptionist", description: "For owners and admins. **Add receptionist** opens the form for a new receptionist when the business has room for one. When it doesn't, a message says why, or, on a plan that includes one receptionist, the plans open so you can choose one that includes more. **Sort A-Z** shows once the business has three or more receptionists that aren't archived, unless the status filter shows **Archived**, and asks you to confirm before it lists them by name after the default one." },
    { name: "Receptionists table", description: "One row for each receptionist, the default first with a **Default** badge, then the others in your order. **Receptionist** shows its name and what it helps with. **Page** shows the address of its own page, or of the business page for the default one: select it to open the page in a new tab. **Not listed on the business page** under it means visitors can't choose it there. **Status** shows **Active**, **Paused** or **Archived** with the day it was archived. **Answers on** counts the phone numbers, website widgets and QR links that open it, or says **Its page only**. **Language** shows its own language, or **Business language**. An archived receptionist's row shows no page address and nothing under **Answers on**. When nothing matches the search or filter, the table says \"No receptionist matches that.\" in place of the rows, or \"No archived receptionists.\" when the **Archived** list is empty." },
    { name: "Order", description: "A column of up and down arrows that move a receptionist one place in the order. Owners and admins see it once the business has three or more receptionists that aren't archived, while the search box is empty and the status filter shows **All**. The default receptionist always stays first." },
    { name: "More options", description: "The menu at the end of each row, for owners and admins: **Edit details** and **AI settings**, and for every receptionist but the default, **Pause** or **Resume**, **Make default** for an active one, and **Archive**. An archived receptionist's menu has **Restore**." },
    { name: "Pages", description: "Below the table, choose in **Rows per page** how many receptionists show per page, from 10 to 50, and move between pages." },
  ],
  fields: [
    {
      title: "Add a receptionist and Edit details",
      description: "The form that opens from **Add receptionist**, or from **Edit details** in a row's menu, where it's titled with the receptionist's name. On the default receptionist, **Page address**, **Language** and **Listed on the business page** can't be changed.",
      fields: [
        { name: "Name", requirement: "required", description: "What the receptionist is called, such as the location or team it serves. Visitors see it when they choose who to talk to on your business page, and the other receptionists use it when they send someone to this one. Up to 80 characters." },
        { name: "What it helps with", requirement: "optional", description: "One line shown under its name, such as \"Bookings at our downtown clinic\". Visitors see it when they choose who to talk to, and the other receptionists read it to know when to send someone here. Up to 160 characters." },
        { name: "Page address", requirement: "optional", description: "The end of the receptionist's own page address, which the form shows after your business page's address. Use lower-case letters and digits joined by single dashes, such as `main-street`, up to 60 characters. Left empty on a new receptionist, it's made from the name, with a number added when another receptionist already uses it. A name with no Latin letters or digits, such as one written in Japanese, gives `receptionist`. Emptied on an existing one, it keeps the address it has. Changing it moves the page, so the old address no longer opens it, while QR links follow the change. On the default receptionist the field is turned off, because it answers the business page itself." },
        { name: "Language", description: "The language this receptionist's calls start in. Calls switch when a caller speaks another one. **Business language** follows the language set on the **AI settings** screen. The default receptionist always speaks the business's language." },
        { name: "Knowledge", description: "Which articles from the **Knowledge** screen it answers from. **Every article** uses them all. **Articles for everyone, and the ones chosen for it**, the choice a new receptionist starts with, uses the articles available to everyone plus the ones made available to this receptionist with **Available to** on the **Knowledge** screen." },
        { name: "Listed on the business page", description: "On to start with. Visitors to your business page can choose this receptionist under **You're talking to**. Its own page, phone numbers and QR links work either way. A paused receptionist stays off the business page until it resumes, and the default receptionist is always listed." },
        { name: "Copy settings from", description: "Only when adding. The receptionist whose greeting, booking, transfer and instructions the new one starts with, the default one unless you choose another. Change its greeting, transfer number and booking afterwards on the **AI settings** screen." },
      ],
    },
  ],
  tasks: [
    {
      title: "Add a receptionist",
      steps: [
        "Open **AI agents** in the sidebar and select **Add receptionist**.",
        "Enter a **Name** and, if you like, **What it helps with**.",
        "Leave **Page address** empty to make it from the name, or type your own.",
        "Choose its **Language** and **Knowledge**, and whether it's **Listed on the business page**.",
        "In **Copy settings from**, choose the receptionist whose greeting, booking, transfer and instructions it starts with.",
        "Select **Add receptionist**. It starts active, and a message confirms it was added. It goes last in the order, or takes its place by name while the list is in name order, as after **Sort A-Z**.",
        "To have it answer a phone number, a website widget or a QR code, choose it on the **Phone Number**, **Website widget** or **QR code** screen.",
      ],
    },
    {
      title: "Rename a receptionist or change its page",
      steps: [
        "Open **More options** at the end of its row and select **Edit details**.",
        "Change its **Name**, **What it helps with**, **Page address**, **Language**, **Knowledge** or **Listed on the business page**.",
        "Select **Save changes**. A message confirms it was saved.",
      ],
    },
    {
      title: "Choose which articles a receptionist answers from",
      steps: [
        "Open **More options** at the end of its row and select **Edit details**.",
        "Under **Knowledge**, choose **Articles for everyone, and the ones chosen for it**, then select **Save changes**.",
        "On the **Knowledge** screen, for each article only some receptionists should use, select **Available to** in the article's **More options** menu, choose **Chosen receptionists**, pick them and select **Save changes**. Articles left for **Everyone** stay available to every receptionist.",
      ],
    },
    {
      title: "Change a receptionist's greeting, transfer number or booking",
      steps: [
        "Open **More options** at the end of its row and select **AI settings**.",
        "The **AI settings** screen opens with that receptionist chosen under **Each receptionist's own**. Make your changes there.",
      ],
    },
    {
      title: "Pause or resume a receptionist",
      steps: [
        "Open **More options** at the end of its row and select **Pause**.",
        "Its phone numbers, website widgets and QR links now answer as the default receptionist, its own page sends visitors to your business page, and it no longer counts toward your plan.",
        "To bring it back, open the same menu and select **Resume**. Your plan needs room for another active receptionist.",
      ],
    },
    {
      title: "Archive and restore a receptionist",
      steps: [
        "Open **More options** at the end of its row, select **Archive** and confirm with **Archive**.",
        "To bring it back, set the status filter to **Archived**, open **More options** on its row and select **Restore**.",
        "It comes back last in the order, or in its place by name while the list is in name order. It comes back paused when your plan's active receptionists are all in use, or when it was paused before it was archived.",
      ],
    },
    {
      title: "Make another receptionist the default",
      steps: [
        "If the receptionist is paused, select **Resume** in its menu first.",
        "Open **More options** at the end of its row and select **Make default**.",
        "Confirm with **Make default**. It now answers your business page and anything that names no receptionist, in the business's language and from every article.",
      ],
    },
    {
      title: "Change the order",
      steps: [
        "Empty the search box and set the status filter to **All**.",
        "Use the up and down arrows in the **Order** column to move a receptionist one place at a time.",
        "Or select **Sort A-Z** and confirm to list them by name after the default one. Receptionists added, restored or renamed after that take their place by name, until you move one yourself.",
      ],
    },
  ],
  notes: [
    "Your plan includes a number of active receptionists, the default one included. Paused and archived receptionists don't count, so you can pause one to make room for another.",
    "A business can also keep only so many receptionists that aren't archived, paused ones included. When it has that many, the line at the top says so: archive one you no longer use to add or restore another.",
    "If your plan changes to one that includes fewer receptionists, the newest extra ones are paused. The default receptionist keeps answering and nothing is deleted, so you can choose which ones to resume.",
    "The default receptionist can't be paused, archived or moved, is always listed on the business page and always speaks the business's language. To change any of that, make another receptionist the default first.",
    "Making a receptionist the default doesn't move the shared settings, which belong to the business. The previous default keeps its phone numbers, website widgets and QR links, and gets a page of its own.",
    "A receptionist made the default gives up a language of its own and answers from every article, since anything that falls back to the default relies on them. To limit its articles again, use **Edit details**.",
    "An archived receptionist leaves every list and dropdown, its phone numbers, website widgets and QR links answer as the default receptionist, and its own page sends visitors to your business page. Its calls, chats and questions keep its name. When restored, it gets a numbered page address if another receptionist took its address meanwhile.",
    "When you pause or archive a receptionist, a visitor's open website chat with it ends at their next message, which starts a new chat with the default receptionist. A chat your team has taken over carries on.",
    "The order you set is the order of every receptionist dropdown in the dashboard and of the receptionists visitors can choose on your business page.",
    "Receptionists can't hand a call or a chat to each other. When someone needs another receptionist, a call names the right one and offers to take a message, and a website chat names it and, when it can, gives a link to its page. Each receptionist knows the others that are listed and active, up to 12 in this screen's order.",
    "A receptionist's page opens for visitors once your business page is published on the **Public profile** screen. Until then, only signed-in members of your team see it, as a preview.",
    "Choosing articles for a receptionist keeps them out of the other receptionists' answers, but it doesn't keep them private: the default receptionist answers from every article unless you limit it, and it answers for any receptionist that is paused or archived. Keep anything callers must never hear out of your knowledge.",
    "With several AI agents, the **Calls**, **Messages**, **Questions**, **Knowledge** and **QR code** screens can be filtered by receptionist. When more than one receptionist is active, a dropdown beside **Test Call** chooses who answers your test calls.",
  ],
  troubleshooting: [
    {
      question: "Why can't I see **Add receptionist**?",
      answer: "Only owners and admins can add or change receptionists. Ask an owner or admin of the business, or ask them to change your role on the **Team** screen.",
    },
    {
      question: "Why does **Add receptionist** open the plans instead of the form?",
      answer: "Your plan includes one receptionist. Choose a plan that includes more to add another.",
    },
    {
      question: "It says all the active receptionists are in use. What can I do?",
      answer: "Pause a receptionist you don't need right now, then add or resume the one you want: paused receptionists don't count. To have more active at once, owners and admins can select **See plans** to choose a plan that includes more, or **Contact sales** when the line offers it. When the line offers neither, pausing one is the way to make room.",
    },
    {
      question: "What does **This business keeps as many receptionists as it can** mean?",
      answer: "The business has the most receptionists it can keep that aren't archived, paused ones included. Archive one you no longer use, then add the new one or restore the one you want back.",
    },
    {
      question: "Why does it say **Another receptionist already uses this page address**?",
      answer: "Each receptionist needs its own page address. Type a different one, or on a new receptionist leave it empty to have one made from the name.",
    },
    {
      question: "Why does it say **Use lower-case letters and digits, joined by single dashes**?",
      answer: "A page address can only have letters and digits, which it keeps in lower case, with a single dash between words. It can't have spaces, accents or other symbols, or start or end with a dash. Type `main-street`, for example, rather than Main Street.",
    },
    {
      question: "Why is there no **Pause**, **Archive** or **Make default** for a receptionist?",
      answer: "The default receptionist always answers, so it has none of these: make another receptionist the default first. **Make default** also shows only for an active receptionist, so resume a paused one first.",
    },
    {
      question: "Why can't I move receptionists up or down?",
      answer: "The **Order** column shows to owners and admins once the business has three or more receptionists that aren't archived, while the search box is empty and the status filter shows **All**. The default receptionist always stays first.",
    },
    {
      question: "I restored a receptionist and it's paused. Why?",
      answer: "It comes back paused when your plan's active receptionists are all in use, or when it was paused before it was archived. Select **Resume** once your plan has room.",
    },
    {
      question: "Why can't visitors choose a receptionist on my business page?",
      answer: "Check that **Listed on the business page** is on in **Edit details** and that the receptionist is active: a paused one stays off the page until it resumes. Your business page also has to be published on the **Public profile** screen, where you can choose which receptionists are listed too.",
    },
    {
      question: "Calls to a receptionist's number are answered by the default receptionist. Why?",
      answer: "The receptionist is paused or archived, so the default one answers for it. Resume or restore it, then check **Answered by** for that number on the **Phone Number** screen.",
    },
    {
      question: "It says **Receptionists couldn't be loaded. Try again in a moment.** What should I do?",
      answer: "The list didn't load. Wait a moment and reload the page.",
    },
    {
      question: "It says **That receptionist isn't there any more. Refresh the page.** Why?",
      answer: "Someone else archived or restored that receptionist while you had the page open. Reload the page to see the current list.",
    },
    {
      question: "It says **Check the fields and try again.** or **That didn't work. Try again in a moment.** What should I do?",
      answer: "**Check the fields and try again.** means a field wasn't accepted: make sure the receptionist has a name and its page address follows the rules, then save again. **That didn't work.** means the change didn't go through, for example because someone else changed the list while you had the page open: reload the page and try again. When the message ends with an **Error ID**, note it for whoever helps you, because it points to what went wrong.",
    },
    {
      question: "How do I delete a receptionist?",
      answer: "Receptionists can't be deleted, so their calls, chats and questions always keep their name. Archive one you no longer need instead: it leaves every list and dropdown, the default receptionist answers in its place, and you can restore it from **Archived** in the status filter.",
    },
  ],
  related: ["ai-settings", "knowledge", "phone-number", "website-widget", "qr-code", "public-profile", "plan"],
  keywords: ["receptionists", "several receptionists", "multiple agents", "locations", "departments", "add receptionist", "rename receptionist", "default receptionist", "pause receptionist", "archive receptionist", "delete receptionist", "restore receptionist", "sort receptionists", "receptionist page", "page address", "plan limit"],
};

export default article;
