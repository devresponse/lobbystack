import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "knowledge",
  title: "Knowledge",
  section: "agent",
  summary: "Give your AI receptionist the facts it answers from: upload documents, import the pages of your website and write short text entries.",
  screenPaths: ["/agent/knowledge"],
  location: ["Sidebar", "Agent", "Knowledge"],
  access: "Everyone on the team can see the knowledge and read the text of documents and website pages. Only owners and admins can add, edit, turn off or delete entries, stop a website import, or choose which receptionists use them, including with website rules.",
  purpose: [
    "Knowledge is what your receptionist knows about your business: opening hours, prices, policies, directions, answers to common questions and anything else a caller or website visitor may ask. The receptionist answers questions about the business only from your knowledge and your other settings, never from a guess, so a fact that isn't here is a fact it can't give.",
    "You can add knowledge in three ways: upload a document you already have, such as a price list or a policy, import the public pages of your website, or write a short text entry yourself.",
    "Knowledge is for facts. How the receptionist should act, such as when to offer a transfer, belongs on the **Rules** screen, and the services it books belong on the **Services** screen. Questions it couldn't answer appear on the **Questions** screen, and each answer you give there is added here as a text entry.",
    "When the business has several AI agents, they share this one list. Each entry can be available to every receptionist or only to the ones you choose, such as one location's pages for that location's receptionist.",
  ],
  areas: [
    { name: "Search", description: "Filters the list to entries whose title contains what you type. It also looks in the text of text entries and in the address of website pages, but not inside documents." },
    { name: "Receptionist filter", description: "Shows when the business has several AI agents. Choose a receptionist to see only the entries it can use, or **All receptionists** to see every entry. A line under the toolbar says what the list is showing." },
    { name: "Website rules", description: "Shows to owners and admins when the business has several AI agents and a website has been imported. It opens the rules that give a section of a website's pages to one receptionist." },
    { name: "Add Knowledge", description: "Opens a menu with the three ways to add knowledge: **Upload**, **Website** and **Text**. Only owners and admins see this button." },
    { name: "Knowledge list", description: "Shows every entry, newest first, with its **Title**, a **Preview** of its text, its **Status** and the date it was **Added**. An icon by the title shows whether the entry is a text entry, a website page or a document. When the business has several AI agents, the **Available to** column takes the place of **Preview** and shows who uses each entry: **Everyone**, the names of up to two receptionists and how many more, or **Default receptionist only** when none of the receptionists chosen for it is left. **by rule** marks a page that a website rule gave to a receptionist. An empty list says \"No knowledge added yet.\" before anything is added, and \"No matching entries found.\" when the search or the receptionist filter hides every entry." },
    { name: "Status", description: "**Ready** means the receptionist can use the entry. **Queued** and **Indexing** mean a document or page is still being read, and **In progress** means a website import is still reading pages. A progress bar shows how far a website import has got and, unless the business has several AI agents, how far an uploaded document has got. **Error** means a document or page couldn't be read. **Failed** means a website import didn't work, and its row says \"Import failed. Please try again.\" **Disabled** means the entry is turned off." },
    { name: "Reading a document", description: "Select a document or website page to open, under its row, the text the receptionist uses from it, and select it again to close it. Owners and admins select a text entry to edit it. When the business has several AI agents, everyone else can select a text entry to read it under its row." },
    { name: "Selected entries", description: "When the business has several AI agents, owners and admins can tick the box at the start of a row, or the one in the header for the whole page. A bar then shows how many entries are selected, with **Available to** to change who uses them all at once and **Clear** to clear the selection." },
    { name: "More options", description: "The menu at the end of each row, for owners and admins, with **Disable** or **Enable** and **Delete**. With several AI agents it also has **Available to**, and on the row of a website you imported, **Page rules**. While a website import is running, the menu has **Cancel import** instead, and **Delete** once the import has failed." },
    { name: "Pages", description: "Below the list, choose how many entries show per page and move between pages." },
  ],
  fields: [
    {
      title: "Upload Document",
      description: "Opens from **Add Knowledge**, then **Upload**.",
      fields: [
        { name: "File", requirement: "required", description: "Drag a file onto the box, or select **Choose File**. You can upload one PDF, DOCX, TXT or Markdown file of up to 25 MB at a time." },
        { name: "Title", requirement: "optional", description: "The name the document shows in the list. It is filled in from the file's name when you choose the file, and the file's name is used if you leave it empty." },
        { name: "Tags (optional)", requirement: "optional", description: "Comma-separated keywords to help categorize the document." },
        { name: "Available to", description: "Shows when the business has several AI agents. **Everyone** is chosen at first. To keep the document for some receptionists, choose **Chosen receptionists** and pick at least one." },
      ],
    },
    {
      title: "Import Website",
      description: "Opens from **Add Knowledge**, then **Website**.",
      fields: [
        { name: "Website URL", requirement: "required", description: "The full address of your public home page, or of the section of the site you want to import, such as `https://example.com`. It must start with `https://` or `http://`. The import starts from this page and reads up to 50 pages." },
        { name: "Page rules", requirement: "optional", description: "Shows when the business has several AI agents. Select **Add rule** to give a section of the site to one receptionist, then enter its path, such as `/stores/downtown/`, and choose who it **Goes to**. A rule with only a path or only a receptionist keeps the import from starting until you fill in the other or remove the rule with its X button. A rule left empty is skipped." },
      ],
    },
    {
      title: "Add Knowledge and Edit Knowledge",
      description: "The form that opens from **Add Knowledge**, then **Text**, or when an owner or admin selects a text entry in the list.",
      fields: [
        { name: "Title", requirement: "required", description: "A short, descriptive name, such as \"Opening Hours\". The receptionist reads it with the content, so make it say what the entry is about." },
        { name: "Content", requirement: "required", description: "The information itself, such as \"We are open Monday to Friday from 9am to 5pm.\" Write it the way the receptionist should give it, in full sentences." },
        { name: "Tags (optional)", requirement: "optional", description: "Comma-separated keywords to help categorize the entry." },
        { name: "Available to", description: "Shows when the business has several AI agents. A new entry starts with **Everyone**, and an entry you edit shows who uses it now. To keep the entry for some receptionists, choose **Chosen receptionists** and pick at least one." },
      ],
    },
    {
      title: "Available to",
      description: "The dialog that opens from **Available to** in a row's **More options** menu, when the business has several AI agents. Select **Save changes** to keep your choice.",
      fields: [
        { name: "Available to", description: "Choose **Everyone** so that every receptionist can use the entry, or **Chosen receptionists** and pick the ones that can. A receptionist set to answer from **Every article** on the **AI agents** screen uses the entry either way. On a page that a website rule gave to a receptionist, what you save stays if the rule is deleted, and the rule adds its receptionist again each time the site is read." },
      ],
    },
    {
      title: "Available to for selected entries",
      description: "The panel that opens from **Available to** in the bar above the list, after you select entries. You can change up to 500 entries at once. The button that reads **Apply to** and the number of entries, such as **Apply to 3 articles**, makes the change, and a line beside it sums it up.",
      fields: [
        { name: "Available to", description: "**Everyone** makes every selected entry available to every receptionist. **Chosen receptionists**, chosen at first, lets you pick receptionists and choose what to do with them." },
        { name: "Add, Remove or Replace", description: "Shows with **Chosen receptionists**, and **Add** is chosen at first. **Add** gives the selected entries to the receptionists you pick, and entries for everyone stay as they are. **Remove** takes them away, and entries for everyone become available to every other receptionist. **Replace** makes the entries available to those receptionists only. An entry left with no receptionist is used only by the default receptionist." },
      ],
    },
    {
      title: "Website rules",
      description: "The dialog that opens from **Website rules** above the list, or from **Page rules** on a website's row, when the business has several AI agents. It lists the rules already made, each with who it **Goes to** and how many pages it gives, five at first with a link to show them all, and the **Add rule** form adds one. The bin button beside a rule deletes it, once you confirm with **Delete rule**.",
      fields: [
        { name: "Website", description: "Shows when you open the dialog from **Website rules** and more than one website has been imported. Choose the site the rule is for." },
        { name: "Path", requirement: "required", description: "The start of the addresses of the pages that should go to one receptionist, such as `/stores/downtown/`. A path covers its own page and the pages under it: `/stores/downtown` covers `/stores/downtown/hours` but not `/stores/downtown-west`. A full page address works too, and `/` covers the whole site. A path can't have `?`, `#`, spaces or two slashes in a row, and can be up to 300 characters long." },
        { name: "Goes to", requirement: "required", description: "The receptionist that the matching pages go to." },
      ],
    },
  ],
  tasks: [
    {
      title: "Upload a document",
      steps: [
        "Select **Add Knowledge**, then **Upload**.",
        "Drag the file onto the box, or select **Choose File** and pick it.",
        "Check the **Title** and select **Save**.",
        "Wait for the status to change from **Queued** and **Indexing** to **Ready**. The receptionist uses the document from then on.",
      ],
    },
    {
      title: "Import your website",
      steps: [
        "Select **Add Knowledge**, then **Website**.",
        "In **Website URL**, enter the address of your home page, starting with `https://`.",
        "Select **Import Website**. A message says the import started, and a row for the site shows **In progress** while its pages are read.",
        "Each page appears in the list as its own entry when it is ready.",
      ],
    },
    {
      title: "Write a text entry",
      steps: [
        "Select **Add Knowledge**, then **Text**.",
        "Enter a **Title** and, in **Content**, the information the receptionist should give.",
        "Select **Save**. The entry shows **Ready** right away.",
      ],
    },
    {
      title: "Edit a text entry",
      steps: [
        "Select the entry in the list.",
        "Change the **Title**, **Content** or **Tags (optional)** and, with several AI agents, **Available to**.",
        "Select **Save changes**.",
      ],
    },
    {
      title: "Read what the receptionist uses from a document",
      steps: [
        "Select the document or website page in the list. Its text opens under the row.",
        "Select the row again to close it.",
      ],
    },
    {
      title: "Turn an entry off without deleting it",
      steps: [
        "Open **More options** at the end of the entry's row.",
        "Select **Disable**. The status changes to **Disabled** and the receptionist stops using the entry.",
        "To use it again, open the same menu and select **Enable**.",
      ],
    },
    {
      title: "Delete an entry",
      steps: [
        "Open **More options** at the end of the entry's row and select **Delete**.",
        "Confirm with **Delete**. A deleted entry can't be brought back.",
      ],
    },
    {
      title: "Stop a website import",
      steps: [
        "Open **More options** on the row that shows **In progress** and select **Cancel import**.",
        "Confirm with **Cancel import**. Pages that were already read stay in the list.",
      ],
    },
    {
      title: "Choose which receptionists use an entry",
      steps: [
        "Open **More options** at the end of the entry's row and select **Available to**.",
        "Choose **Everyone**, or **Chosen receptionists** and pick the receptionists.",
        "Select **Save changes**.",
      ],
    },
    {
      title: "Change who uses several entries at once",
      steps: [
        "Tick the box at the start of each entry's row, or the box in the header to select the whole page.",
        "Select **Available to** in the bar above the list.",
        "Choose **Everyone**, or choose **Chosen receptionists**, pick the receptionists and choose **Add**, **Remove** or **Replace**.",
        "Check the summary and select the button that reads **Apply to** and the number of entries.",
      ],
    },
    {
      title: "Give a section of your website to one receptionist",
      steps: [
        "Select **Website rules** above the list.",
        "Under **Add rule**, if more than one website has been imported, choose the site in **Website**.",
        "Enter the **Path** of the section, such as `/stores/downtown/`, and choose who it **Goes to**.",
        "Select **Add rule**. A message says how many pages now go to that receptionist.",
      ],
    },
    {
      title: "Delete a website rule",
      steps: [
        "Select **Website rules** above the list, or **Page rules** in the **More options** menu of the website's row.",
        "Select the bin button beside the rule.",
        "Confirm with **Delete rule**. The pages it gave to its receptionist go back to everyone, unless another rule or your own choice also gives them to someone.",
      ],
    },
    {
      title: "See what one receptionist can use",
      steps: [
        "Choose the receptionist in the filter above the list.",
        "Read the line under the toolbar. It says whether the receptionist answers from every entry, or from the entries for everyone and the ones chosen for it.",
        "Choose **All receptionists** to see every entry again.",
      ],
    },
  ],
  notes: [
    "A text entry you add or change reaches the receptionist within moments, for calls that start after you save and for the next message in a website chat. A document or website page is used as soon as its status is **Ready**.",
    "You can upload one file at a time. The upload takes PDF, DOCX, TXT and Markdown files of up to 25 MB.",
    "A scanned PDF, whose pages are only pictures, is read with text recognition, up to 25 pages, and a longer scan can't be read. Text recognition works best on English and French text.",
    "An import reads up to 50 pages, starting from the address you enter. Each page becomes its own entry, which you can turn off, delete or give to a receptionist like any other.",
    "If only a sample of your website was read when the business was set up, the **Getting started** guide shows **Read the rest of your site**. Its **Read the rest** button reads the site again, up to 50 pages.",
    "Importing an address you already imported, or the address of a page an import already read, doesn't read it again, even though the screen says the import started, unless that import failed or was cancelled. Imported pages aren't read again on their own when your website changes.",
    "Documents and website pages can't be edited here. To change a document, upload the new version and delete the old one.",
    "Each receptionist uses up to 50 text entries that are turned on. When there are more, it uses the entries added on this screen first, then the answers saved on the **Questions** screen and the text added during setup, the most recently changed first in each group. Keep each entry to one topic, put long material in a document, and turn off or delete entries you no longer need.",
    "Text pasted while the business was being set up is here as a text entry called **Onboarding notes**, which you can edit like any other.",
    "**Available to** chooses what is relevant to each receptionist. It doesn't keep anything private: a receptionist set to answer from **Every article** uses every entry, and the default receptionist answers for one that is paused or archived. Add only what the receptionist may tell callers and visitors.",
    "A website rule gives the matching pages to its receptionist as soon as you add it, and again each time the site is read. Deleting a rule gives its pages back to everyone, unless another rule or your own choice also gives them to someone.",
    "The app also reads your knowledge to fill in the **Business summary** and **Opening hours** on the **AI settings** screen, unless you've set them yourself. Only entries available to everyone are read for them.",
    "How much document and website text the business can keep depends on its plan, and **Knowledge base** on the **Usage** screen shows how much is used. Only the text read from each file counts, not the file's size, and documents that are turned off count too. Text entries don't count.",
  ],
  troubleshooting: [
    {
      question: "A document shows Error. What can I do?",
      answer: "Select the document to see why. \"We couldn't read the text in this document.\" or \"No readable text was extracted from the document.\" means the app found no text it could use, as with a scan of more than 25 pages: upload a copy that has its text, or paste the text into a text entry. \"Knowledge storage limit reached.\" means the business holds all the text its plan includes: delete documents you don't need, or move to a plan with more room on the **Plan** screen, then delete the failed document and upload it again. For any other message, delete the document and upload it again.",
    },
    {
      question: "My website import shows Failed. What can I do?",
      answer: "The app couldn't read the site, or found no text on it. Check that the address opens in a web browser for anyone, without signing in, then import the same address again, which tries it again. If it keeps failing, delete the failed row and add the information as documents or text entries instead.",
    },
    {
      question: "Import Website says my address isn't valid. What does it need?",
      answer: "Enter the full address of a public website, such as `https://example.com`, starting with `https://` or `http://`. \"Website URL must use a public hostname.\" means the address is written as an IP number or uses a local name such as `localhost`, which can't be imported. \"Website URL must not include credentials.\" means it has a user name or password in it: take them out.",
    },
    {
      question: "My file won't upload. What can I check?",
      answer: "The upload takes one PDF, DOCX, TXT or Markdown file of up to 25 MB. \"Documents must be 25 MB or smaller.\" or \"Supported document types are PDF, DOCX, TXT, and Markdown.\" means the file doesn't fit: split it, or save it as one of those types. If you see \"We couldn't upload this document. Please try again.\", check your connection and try again. If it keeps failing, check **Knowledge base** on the **Usage** screen: once the business holds all the document and website text its plan includes, new files can't be added until you delete documents you don't need or move to a plan with more room on the **Plan** screen.",
    },
    {
      question: "I changed my website, but the receptionist still gives the old information. Why?",
      answer: "Imported pages aren't read again on their own, and importing an address you already imported doesn't read it again. Delete the rows of the pages that changed and import their addresses again, or add the new information as a text entry.",
    },
    {
      question: "The receptionist doesn't use something I added. What can I check?",
      answer: "Make sure the entry shows **Ready**, not **Disabled**, **Queued**, **Indexing** or **Error**. With several AI agents, choose the receptionist in the filter to check that the entry is available to it. A call already in progress keeps the text entries it started with, so try a new call. If you have many text entries, turn off the ones you don't need, because each receptionist uses up to 50 of them.",
    },
    {
      question: "Adding a website rule says 0 pages go to the receptionist. Why?",
      answer: "No page read from that site so far has an address under the rule's **Path**. If the site is still being imported, the rule gives its receptionist the matching pages as they are read. Otherwise, search the list for part of the path, such as `/stores/`: the website pages whose address contains it show. If none show, check the pages' addresses in a web browser, then delete the rule and add it again with a path they start with.",
    },
    {
      question: "Saving says \"That didn't work. Try again in a moment.\" or \"Something went wrong. Please try again.\" What can I do?",
      answer: "The change didn't save. Check your connection and try again, refreshing the page first if it keeps happening. In a form, what you typed stays until you close it. \"One of the chosen receptionists was archived. Refresh the page and choose again.\" means a receptionist picked under **Available to** was archived meanwhile: refresh the page and pick again.",
    },
    {
      question: "Why can't I see the Add Knowledge button?",
      answer: "Only owners and admins can change knowledge. Ask an owner or admin of the business to make the change, or to change your role on the **Team** screen.",
    },
  ],
  related: ["questions", "rules", "services", "ai-settings", "ai-agents", "usage", "plan", "setup-guide"],
  keywords: ["knowledge base", "documents", "upload", "PDF", "website import", "crawl website", "FAQ", "text entries", "training", "train the AI", "available to", "website rules", "onboarding notes"],
};

export default article;
