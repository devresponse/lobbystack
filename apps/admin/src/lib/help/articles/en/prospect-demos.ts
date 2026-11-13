import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "prospect-demos",
  title: "Prospect demos",
  section: "account",
  summary: "Prepare a private demo receptionist from a prospective customer's website, then publish a secure link they can open to try it with a live call and claim it.",
  screenPaths: ["/demos"],
  location: ["No link in the app", "Open /demos in the address bar"],
  access: "Only the one account set up as the app's demo operator can use this screen. For anyone else it shows **Unable to load prospect demos. Try refreshing.** and can't create demos.",
  purpose: [
    "A prospect demo is a private, temporary workspace whose receptionist answers from a prospective customer's public website. You prepare it here, publish it and share its secure link. The prospect opens the link, talks to the receptionist from the browser and can claim it into an account of their own.",
    "Demos are limited on purpose: live calls work, but the receptionist doesn't book appointments, transfer calls or send texts. A demo closes by itself 30 days after it was created, published or not: its link stops working, and within the hour the list shows it as **revoked**.",
    "No menu links to this screen. To open it, replace everything after the dashboard's address in the browser's address bar with `/demos`, then bookmark the page.",
  ],
  areas: [
    { name: "Demo list", description: "One card per demo you prepared, newest first, under the number of demos and **Refresh**. It says **Loading demos...** while it loads and **No prospect demos have been prepared yet.** when there are none. The list doesn't update by itself, so select **Refresh** to see progress." },
    { name: "Demo card", description: "The business name, the website and the demo's status: **preparing**, **active**, **claimed** or **revoked**. **Ingestion** shows how far reading the website has got, from **queued** through **crawling** and **indexing** to **completed**, or **failed**. **Snapshot** reads **ready** once the app has put together what the receptionist knows about the business, and **pending** until then. **Prompts** reads **ready** when at least two suggested prompts are set, **missing** otherwise. A card with no link from this visit reminds you to rotate the link before publishing or sharing it, because the app never stores links." },
    { name: "Rotate link", description: "Makes a new secure link for the demo, and the old link stops working at once. It isn't available once a demo is claimed or revoked." },
    { name: "Publish", description: "Makes the demo live, so its link opens the receptionist instead of a page saying the demo is being prepared. It turns on once **Ingestion** reads **completed**, **Snapshot** and **Prompts** read **ready** and the demo's link was made on this visit to the screen, and it turns off again once the demo is **active**." },
    { name: "Revoke", description: "Turns the demo off for good, straight away and without asking you to confirm: its link stops working and its workspace leaves your businesses. A claimed demo can't be revoked." },
    { name: "Open secure link", description: "Opens the demo page in a new tab, where you can copy its address to share. It shows only after you create the demo or rotate its link, until you leave or reload the screen." },
    { name: "Error messages", description: "When the list can't load or an action fails, the message shows in red at the bottom of the **Prepare a demo** form, under **Create isolated demo**, not on the demo's card. On smaller screens the form sits below the list, so scroll down to read it." },
  ],
  fields: [
    {
      title: "Prepare a demo",
      description: "The form beside the list, or below it on smaller screens. A new demo stays private while the app reads the website. If creating it fails, the form keeps what you entered.",
      fields: [
        { name: "Business name", requirement: "required", description: "The prospect's business name, which the demo page shows and the receptionist uses." },
        { name: "Website URL", requirement: "required", description: "The prospect's public website, in full, such as `https://example.com`. The receptionist answers from what the app reads there." },
        { name: "Greeting", requirement: "optional", description: "What the receptionist says when a call starts. Left empty, it thanks the caller for calling the business by name." },
        { name: "Suggested prompts", requirement: "required", description: "Questions the prospect can try, one per line. Empty lines are dropped and the first six questions are kept. The demo page lists only the first three, under the heading **Try asking:**, so put the best ones first. A demo needs at least two to be published, and this screen can't change them later." },
      ],
    },
  ],
  tasks: [
    {
      title: "Prepare and share a demo",
      steps: [
        "In the browser's address bar, replace everything after the dashboard's address with `/demos` and press Enter.",
        "In **Prepare a demo**, fill in **Business name**, **Website URL** and **Suggested prompts**, and a **Greeting** if you want one.",
        "Select **Create isolated demo**. The demo shows in the list as **preparing**.",
        "Select **Refresh** until **Ingestion** reads **completed** and **Snapshot** and **Prompts** read **ready**.",
        "Select **Publish**. The status changes to **active**.",
        "Select **Open secure link**, then copy the address of the page that opens and send it to the prospect.",
      ],
    },
    {
      title: "Get a new link for a demo",
      steps: [
        "Select **Rotate link** on the demo's card. Anyone holding the old link can no longer open the demo.",
        "Select **Open secure link** and share the new address.",
      ],
    },
    {
      title: "Turn a demo off",
      steps: [
        "Select **Revoke** on the demo's card. It acts straight away, without asking you to confirm.",
        "The status changes to **revoked** and the link stops working. A revoked demo can't be turned back on.",
      ],
    },
  ],
  notes: [
    "The app never keeps a copy of a demo's link. It's available only right after you create the demo or rotate its link, until you leave or reload the screen. After that, **Rotate link** makes a new one and turns the old one off.",
    "Each demo is a workspace of its own. While it's open, it shows in the business menu at the top of the sidebar, with your other businesses.",
    "A demo speaks the dashboard's language at the time you create it: French when the dashboard is in French, English otherwise.",
    "When a prospect claims a demo, its workspace becomes a business in their own account, with them as its owner. The demo shows **claimed**, and it leaves your businesses.",
  ],
  troubleshooting: [
    {
      question: "Why can't I select Publish?",
      answer: "It needs the website read, with **Ingestion** reading **completed**, **Snapshot** and **Prompts** reading **ready**, and a link made on this visit to the screen. Select **Refresh** to update the card, and **Rotate link** if **Open secure link** isn't showing. An **active** demo is already published.",
    },
    {
      question: "Prompts reads missing. What do I do?",
      answer: "A demo needs at least two suggested prompts, and this screen can't change them once the demo exists. Prepare the demo again with two or more lines in **Suggested prompts**, and revoke the old one.",
    },
    {
      question: "Ingestion reads failed. What can I do?",
      answer: "The app couldn't read the website, or found no readable text on it. Check that the address is right and that the site is public, then prepare the demo again and revoke the one that failed.",
    },
    {
      question: "The prospect says the link shows that the demo is being prepared.",
      answer: "The demo isn't published yet. Select **Publish** once it's ready.",
    },
    {
      question: "It says Unable to publish the demo. Please try again. Why?",
      answer: "The link this screen holds may be out of date, because the demo's link was rotated in another tab or browser after you got yours. Select **Rotate link**, then **Publish** again. If it still fails, the demo may be more than 30 days old: no new link can fix that, so prepare a new demo.",
    },
    {
      question: "It says Unable to create the demo. Your entries have been kept; please try again. Why?",
      answer: "The app couldn't create the demo. Check that **Website URL** is a public website's address: local network addresses, bare IP addresses and addresses with a user name or password aren't accepted. Your entries are still in the form, so correct them and select **Create isolated demo** again. If the list can't load either, you aren't signed in as the app's demo operator, the only account that can create demos.",
    },
    {
      question: "It says Unable to rotate the demo link or Unable to revoke the demo. What now?",
      answer: "Select **Refresh**. The prospect may have claimed the demo, or it may have closed, since the list last loaded: a claimed demo can't be revoked, and a claimed or revoked demo can't get a new link. Otherwise try again.",
    },
    {
      question: "It says Unable to load prospect demos. Try refreshing. What does that mean?",
      answer: "Select **Refresh**. While the list can't load, it may also say **No prospect demos have been prepared yet.** If the message stays, you're signed in with an account that isn't the app's demo operator, and only that account can use this screen.",
    },
  ],
  related: ["prospect-demo", "claim-demo", "knowledge", "ai-settings", "sign-up", "account"],
  keywords: ["demo", "prospect", "sales demo", "demo link", "secure link", "claim demo", "trial receptionist", "demo operator"],
};

export default article;
