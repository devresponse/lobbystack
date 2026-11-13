import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "api-keys",
  title: "API keys",
  section: "settings",
  summary: "Create keys that let tools such as Zapier, Make or your own scripts work with this business through the app's API, choose what each key may do, and revoke keys you no longer need.",
  screenPaths: ["/settings/api-keys"],
  location: ["Sidebar", "Manage", "Settings", "API keys"],
  access: "Only owners and admins can see, create and revoke API keys. Everyone else sees a message asking an owner or admin to create a key for them.",
  purpose: [
    "An API key lets another tool work with your business without signing in as a person: an automation tool such as Zapier or Make, or a script someone on your team wrote. The tool sends the key with each request, and the app lets it do only what the key allows.",
    "Each key works for this business only. You choose its access when you create it, from reading calls and contacts to booking appointments or managing the team, so give each key only what its tool needs.",
    "The whole key is shown once, when you create it. After that the list shows only its first characters, so store the key somewhere safe, such as a password manager or the tool's own settings.",
  ],
  areas: [
    { name: "Create API key", description: "Opens **Create an API key**, where you name the key and choose its access." },
    { name: "Business ID", description: "Shows this business's ID with a **Copy** button. Tools that work through the API, such as the command-line tool, use it to know which business you mean." },
    { name: "API keys list", description: "One row for each key, newest first. **Name** is the name you gave it, **Key** shows its first characters, **Access** shows what it may do as short codes, **Created** shows the date and who made it, and **Last used** shows when a tool last used it, or **Never**." },
    { name: "Revoke", description: "The button at the end of a row. It asks you to confirm, then turns the key off for good. A revoked key stays in the list, marked **Revoked** with the date." },
    { name: "Empty list", description: "\"No API keys yet.\" shows until someone creates a key." },
  ],
  fields: [
    {
      title: "Create an API key",
      description: "The dialog that opens from **Create API key**. **Cancel** closes it without creating a key.",
      fields: [
        { name: "Name", requirement: "required", description: "A name you'll recognize, such as the tool that will use the key. Up to 120 characters. It can't be changed after the key is created." },
        { name: "Access", requirement: "required", description: "Tick each kind of access the key needs. Each choice shows a short code and what it allows. The first time you open the dialog, read access to calls, contacts, appointments, messages and the business is ticked. At least one choice must stay ticked." },
        { name: "Set up for Zapier", description: "Ticks exactly what Zapier needs for your Zaps and clears the rest. It also names the key Zapier, unless you already typed a name." },
        { name: "Set up for Make", description: "Ticks exactly what Make needs for your scenarios and clears the rest. It also names the key Make, unless you already typed a name." },
      ],
    },
    {
      title: "Access choices",
      description: "The choices under **Access**, with the code each one shows. The same codes show as badges in the list.",
      fields: [
        { name: "Business details", description: "`business:read` reads business details, hours, services, and receptionist settings and rules. `business:write` updates them, including where calls are transferred." },
        { name: "Calls", description: "`calls:read` reads calls, with their summaries and transcripts." },
        { name: "Contacts", description: "`contacts:read` reads contacts. `contacts:write` creates and updates contacts." },
        { name: "Appointments", description: "`appointments:read` reads appointments and open times. `appointments:write` books, cancels and reschedules appointments." },
        { name: "Messages", description: "`messages:read` reads the messages the receptionist took." },
        { name: "Knowledge", description: "`knowledge:read` reads knowledge entries, FAQs, websites and files. `knowledge:write` adds, edits and deletes them." },
        { name: "Webhooks", description: "`webhooks:manage` creates and deletes webhook endpoints. Zapier and Make need it to start an automation when something happens, such as a call ending." },
        { name: "Billing", description: "`billing:manage` sees the plan, sets the spending cap and starts checkouts." },
        { name: "Phone numbers", description: "`phone_numbers:manage` finds, buys, replaces and releases phone numbers." },
        { name: "Team", description: "`team:manage` invites and removes team members, changes roles and hands the business over to a new owner." },
      ],
    },
    {
      title: "Key is ready",
      description: "What the dialog shows once the key is created. Its title is the key's name followed by \"is ready\".",
      fields: [
        { name: "Key", description: "The whole key, with a **Copy** button. Copy it and store it in a password manager or your tool's settings before you select **Done** or close the dialog, because you won't see it again." },
      ],
    },
  ],
  tasks: [
    {
      title: "Create an API key",
      steps: [
        "Open **Settings** in the sidebar and select the **API keys** tab.",
        "Select **Create API key**.",
        "Enter a **Name** you'll recognize.",
        "Under **Access**, tick only what the tool needs and clear the rest.",
        "Select **Create key**.",
        "Select **Copy** and paste the key into your tool or a password manager.",
        "Select **Done**. The key won't be shown again.",
      ],
    },
    {
      title: "Create a key for Zapier or Make",
      steps: [
        "Select **Create API key**.",
        "Select **Set up for Zapier** or **Set up for Make**.",
        "Select **Create key**, then **Copy**.",
        "Paste the key where Zapier or Make asks for it, then select **Done**.",
      ],
    },
    {
      title: "Revoke an API key",
      steps: [
        "Select **Revoke** on the key's row.",
        "Confirm with **Revoke key**. Anything that uses the key stops working right away, and this can't be undone.",
        "A message confirms **API key revoked**, and the row shows **Revoked** with the date.",
      ],
    },
    {
      title: "Replace a lost key or change a key's access",
      steps: [
        "Create a new key with the access the tool needs.",
        "Put the new key into the tool in place of the old one.",
        "Revoke the old key.",
      ],
    },
    {
      title: "Copy the business ID",
      steps: [
        "Select **Copy** next to **Business ID**. The button shows **Copied** once the ID is on your clipboard.",
      ],
    },
  ],
  notes: [
    "The whole key is shown only once, right after you create it. If you lose it, revoke it and create a new one.",
    "A key's name and access can't be changed after it's created. To change them, create a new key and revoke the old one.",
    "Each key works for this business only, even if you belong to several businesses.",
    "The keys someone created are revoked automatically when that person leaves the team or stops being an owner or admin.",
    "Give `team:manage`, `billing:manage` and `phone_numbers:manage` only to tools you trust. They can change who has access, start plan purchases and set the spending cap, and buy or release the business's phone numbers.",
    "If the account is canceled from the **Team** tab, its API keys stop working. If the business is deleted, its keys are deleted with it.",
    "If your **Integrations** screen has a **Zapier** or **Make** card, its **Connect** steps include **Create a key for Zapier** or **Create a key for Make**. For an owner or admin, that opens this tab with **Create an API key** already set up for the tool.",
    "AI assistants connect another way: someone signs in from the assistant and approves its access, and it shows on the **Connected apps** tab.",
  ],
  troubleshooting: [
    {
      question: "I see \"Only owners and admins can manage API keys\". What can I do?",
      answer: "Your role on this business doesn't include API keys. Ask an owner or admin of the business to create a key for you.",
    },
    {
      question: "Why is Create key greyed out?",
      answer: "The key needs a **Name** and at least one choice ticked under **Access**. A name of only spaces doesn't count. The button is also greyed out while the key is being created.",
    },
    {
      question: "I lost a key. Can I see it again?",
      answer: "No. The whole key is shown only once. Create a new key, put it into your tool, and revoke the old one.",
    },
    {
      question: "A tool says the key isn't allowed to do something. Why?",
      answer: "The key doesn't have the access that action needs, which you can see in its **Access** badges. Create a new key with the right access, or with **Set up for Zapier** or **Set up for Make**, then revoke the old one.",
    },
    {
      question: "A key stopped working. Why?",
      answer: "Look at its row. **Revoked** with a date means the key was turned off, either by someone on this tab or automatically when the person who created it left the team or stopped being an owner or admin. Create a new key and put it into the tool.",
    },
    {
      question: "It says \"We couldn't revoke the key. Try again.\" What do I do?",
      answer: "The key still works. Check your connection and select **Revoke** again.",
    },
  ],
  related: ["connected-apps", "integrations", "webhooks", "team"],
  keywords: ["API", "API key", "access token", "Zapier", "Make", "automation", "integration", "business ID", "revoke key", "developer", "script", "command line"],
};

export default article;
