import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "qr-code",
  title: "QR code",
  section: "settings",
  summary: "Print signs and download QR codes that open your business page, make a link for each sign to count its scans and, with several receptionists, choose who answers each one.",
  screenPaths: ["/settings/qrcode"],
  location: ["Sidebar", "Manage", "Settings", "QR code"],
  access: "Everyone on the team can open **QR code**, copy addresses, print signs and download codes. Only owners and admins can make, edit, pause and resume links.",
  purpose: [
    "A QR code opens your business page when someone points their phone's camera at it. This screen makes printable signs with the code, in a few designs and sizes, and lets you download the code alone for your own designs, such as flyers or menus.",
    "Your business page has a code of its own, but its scans aren't counted. For each sign you put up, such as one on the front door and one on the counter, make a link instead: each link has its own short address and code, and counts its scans, so you can see which sign people use.",
    "When the business has several AI agents, each link names the receptionist that answers: its code opens the page of that receptionist, so visitors reach the right one for that place.",
    "Codes open your public profile, so publish it on the **Public profile** screen before you put signs up. You can print them before that.",
  ],
  areas: [
    { name: "Your public profile isn't published yet", description: "A notice shown while your business page isn't published. Anyone who scans a code sees a page-not-found message until it is. Owners and admins get a link to publish it, **Publish it in Public profile**, and everyone else sees a note that an owner or admin can publish it in **Public profile**." },
    { name: "Your QR codes", description: "The table of codes. The first row, **Business page**, is the code of the page itself, marked **Not counted**. It's left out while you search, go past the first page or filter to a receptionist other than the default one. Below it is a row for each link, newest first, with its label, a **Paused** badge when it's paused, its short address under **Opens**, and its scans in the last 30 days under **Scans, 30 days**, with a small chart. Select a row to show its sign below the table. Before the first link, the table says **No links yet.**, and it says **No links match.** when a search or filter finds none. A line under the table sums up what each row's menu does and what a paused link opens." },
    { name: "Answered by", description: "A column shown when the business has several AI agents, with the receptionist each code is for. When another receptionist stands in, a line under the name says who answers for now, and a receptionist that was archived shows as **Archived receptionist**." },
    { name: "New link", description: "Opens the form for a new link. Only owners and admins see it." },
    { name: "Search and Receptionist filter", description: "The search box shows once the business has more than 10 links, or while the list is filtered, and finds links by label or by the code at the end of their address. With several AI agents, the **Receptionist** filter shows only the links of one receptionist, or **All receptionists**." },
    { name: "More options", description: "The menu at the end of each row. Everyone can select **Copy address**. Owners and admins also see **Edit** and **Pause** or **Resume** on a link's row." },
    { name: "Pages", description: "Below the table, when there are more than 10 links: how many show out of the total, and buttons for the previous and next page." },
    { name: "Sign", description: "The card below the table, titled **Business page sign** or after the chosen link. It shows the address the code opens, with **Open page**, or **Preview** while your page isn't published. For a paused link, or one whose receptionist is paused or archived, a note under the address says what opens instead. Then come the sign's settings, a preview of the printed sheet and the buttons to print and download." },
    { name: "Scans per day", description: "Under a link's sign, a chart of its scans on each of the last 30 days, with the total and the busiest day. The business page's sign shows a note instead, because its scans aren't counted." },
  ],
  fields: [
    {
      title: "New link and Edit link",
      description: "The form that opens from **New link**, or from **Edit** in a link's menu.",
      fields: [
        { name: "Label", requirement: "required", description: "A name for the link, such as where its sign hangs: `Front window`. Only your team sees it, here and in the scan counts. Up to 80 characters. Without one, the form asks you to give the link a label." },
        { name: "Answered by", description: "Shown when the business has several AI agents. Scans open the page of the receptionist you pick, and while it's paused, the default receptionist answers. It starts with the receptionist the table is filtered to, or the default one." },
        { name: "Address", description: "The link's short address, which its code holds. It's made for you when you create the link and never changes, so signs you've printed keep working after you edit the link." },
      ],
    },
    {
      title: "Sign",
      description: "The sign's settings, in the card below the table. Nothing here is saved: choose them each time you print or download.",
      fields: [
        { name: "Link", description: "Which code the sign holds: **Business page**, one of the links on the table's current page, as searched and filtered, or the link already chosen. It shows when there's a link to choose, and selecting a row in the table chooses it too." },
        { name: "Template", description: "The sign's design: **Signal**, a yellow sign, **Front desk**, white, which uses less toner, or **Night**, black, for dim rooms. **Signal** is chosen to start with." },
        { name: "Message", description: "The words printed on the sign, up to 80 characters: the headline on **Signal** and **Night**, and the line under your business name on **Front desk**, where the name is the headline. Press Enter to start a new line. It starts with a short invitation to ask a question, which names the receptionist on a link to another receptionist than the default one. It follows the sign's **Language** until you type, and starts over when you choose another code." },
        { name: "Size", description: "How big each sign is and how many fit on one A4 sheet: **Full page · A4** for 1, **Half page · A5** for 2, **Quarter page · A6** for 4 or **Cards · A7** for 8. Each choice says how big its code is and from about how far it scans. **Full page · A4** is chosen to start with." },
        { name: "Inside the code", description: "What sits in the middle of the code: **Name**, the app's name, **Logo**, the app's logo when it has one, or **Nothing**. **Name** is chosen to start with. When the address is too long to leave room, the screen says so and the code is plain." },
        { name: "Language", description: "The language of the words printed on the sign: **English**, **Français**, **Español** or **Srpski**, each named in its own language. It starts with your dashboard language." },
      ],
    },
  ],
  tasks: [
    {
      title: "Print a sign for your business page",
      steps: [
        "Open **Settings** in the sidebar and select the **QR code** tab.",
        "In the sign card, choose a **Template**, change the **Message** if you like and choose a **Size**.",
        "Choose what goes **Inside the code** and the sign's **Language**.",
        "Select **Print**. In the print window, print at actual size (100%), not Fit to page, on A4 paper.",
        "Scan the printed sign with two phones before you put it up.",
      ],
    },
    {
      title: "Make a link for a sign",
      steps: [
        "Select **New link**.",
        "Enter a **Label**, such as where the sign will hang.",
        "With several AI agents, choose who answers in **Answered by**.",
        "Select **Create link**. The new link's sign shows below the table.",
        "Print the sign, or download its code.",
      ],
    },
    {
      title: "Download a code for your own design",
      steps: [
        "Select the row of the code you want, or choose it in **Link**.",
        "Choose what goes **Inside the code**.",
        "Select **Code as PNG** for an image, or **Code as SVG** for a file that stays sharp at any size.",
      ],
    },
    {
      title: "See how often a sign is scanned",
      steps: [
        "Find the link's row. **Scans, 30 days** shows its scans in the last 30 days.",
        "Select the row to see **Scans per day** under its sign.",
      ],
    },
    {
      title: "Change a link's label or receptionist",
      steps: [
        "Open **More options** at the end of the link's row and select **Edit**.",
        "Change the **Label** or, with several AI agents, **Answered by**.",
        "Select **Save**. The code stays the same, so signs you've printed keep working.",
      ],
    },
    {
      title: "Pause or resume a link",
      steps: [
        "Open **More options** at the end of the link's row and select **Pause**.",
        "The row shows **Paused**, and the link's sign opens your business page until you resume it.",
        "To turn it back on, open the same menu and select **Resume**.",
      ],
    },
    {
      title: "Copy a code's address",
      steps: [
        "Open **More options** at the end of the row and select **Copy address**.",
        "Paste the address where you need it, such as in a message or on your website.",
      ],
    },
  ],
  notes: [
    "Links can't be deleted, so a code you've printed keeps opening a page as long as your business page is published. A business can keep up to 1,000 links. When it has that many, change a paused one instead of making a new one.",
    "Scans are counted for each day and kept for 13 months. Days follow UTC time, which can differ from your own. Scans only count while your business page is published.",
    "Checking a link with **Open page** isn't counted as a scan, because it opens the page directly. Opening the link's own address any other way, such as from a copied address, counts like a scan.",
    "A paused link opens your business page. With several AI agents, a link whose receptionist is paused or archived opens your page answered by the default receptionist.",
    "While your business page isn't published, a link's code says the QR code doesn't open a page, and the business page's code says the page doesn't exist.",
    "Each sign prints your business name, your message, the code, a line inviting people to scan, the code's address and, at the bottom, **Answered by** with the app's name. The line reads **Scan to chat with us** when your page has a chat, naming the receptionist on a link to another receptionist than the default one, and **Scan to visit our page** when it doesn't.",
    "For the best results, print at actual size (100%), not Fit to page, on A4 paper. Matte paper scans best. For a PDF, choose Save as PDF in the print window.",
    "Nothing about a sign is saved. Print it or download its code once it looks right.",
  ],
  troubleshooting: [
    {
      question: "People who scan my code see a page-not-found message. Why?",
      answer: "Your business page isn't published. Publish it on the **Public profile** screen, then scan the code again. Signs you've already printed start working as soon as the page is published.",
    },
    {
      question: "Why does a link's sign open my business page instead of its receptionist?",
      answer: "The link is paused, so its sign opens your business page until you resume it. With several AI agents, it also opens as the default receptionist while its own receptionist is paused or archived. Resume the receptionist, or choose another one with **Edit**.",
    },
    {
      question: "It says \"Your business has 1,000 QR links, the most it can keep.\" What can I do?",
      answer: "Links can't be deleted, so a business can keep up to 1,000. Edit a paused link to give it a new label and receptionist, then resume it. Signs already printed with its code will open what you choose now.",
    },
    {
      question: "It says \"A new code couldn't be made just now. Try again.\" What do I do?",
      answer: "Wait a moment and select **Create link** again.",
    },
    {
      question: "Why don't I see New link, Edit or Pause?",
      answer: "Only owners and admins can make and change links. Everyone on the team can copy addresses, print signs and download codes.",
    },
    {
      question: "Why aren't the scans of my business page sign counted?",
      answer: "Only links count their scans. Make a link for each sign and print the link's code instead of the business page's.",
    },
    {
      question: "It says \"The file couldn't be made. Try again, or use Print.\" What can I do?",
      answer: "Select **Code as PNG** or **Code as SVG** again. If it still fails, select **Print** and choose Save as PDF in the print window.",
    },
    {
      question: "Why is the code plain when I chose Name or Logo?",
      answer: "The address is too long to leave room inside the code, and the screen says so under **Inside the code**. The plain code scans just as well.",
    },
    {
      question: "My printed code doesn't scan well. What can I check?",
      answer: "Print at actual size (100%), not Fit to page, on matte paper. Make sure the sign is big enough for how far away people stand: each **Size** says from about how far its code scans.",
    },
    {
      question: "It says \"The address couldn't be copied.\" What can I do?",
      answer: "Your browser didn't let the page copy it. The message shows the address, and so does the sign card: select the row and copy the address shown beside **Opens** yourself.",
    },
    {
      question: "It says \"Your QR links can't be loaded right now.\" What can I do?",
      answer: "Select **Try again** beside the message. If the whole screen says \"Your QR code can't be loaded right now.\", reload the page. If it keeps happening, check your connection and try again later.",
    },
  ],
  related: ["public-profile", "website-widget", "ai-agents"],
  keywords: ["QR", "QR sign", "printable sign", "poster", "door sign", "table sign", "scan code", "scan count", "download QR code", "QR link", "tracking link", "flyer"],
};

export default article;
