import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "setup-guide",
  title: "Setup guide",
  section: "account",
  summary: "Finish setting up a new business after onboarding: read the rest of your website, upload a document, hear your AI receptionist on a test call and give it a phone number, or skip what you don't need.",
  screenPaths: ["/setup-guide"],
  location: ["Sidebar", "Getting started card"],
  access: "Only owners and admins can use the setup guide, and only until every step is done or skipped. Schedulers and viewers don't see the **Getting started** card, and the guide's address takes them to **Home**.",
  purpose: [
    "The setup guide, headed **Getting started**, lists what is left to do after onboarding so that your AI receptionist knows your whole business and can answer real callers. Each step says why it matters and has a button that does it, or that takes you to the screen where it's done.",
    "A step ticks itself off as soon as the app sees the work done, wherever you did it. When a step doesn't apply to you, skip it. Skipped steps count as complete in the progress.",
    "Open the guide from the **Getting started** card at the bottom of the sidebar, which shows your progress, such as **1 / 4 completed**. Each business has its own guide. Once every step is done or skipped, the guide closes for that business, **Home** opens and the card leaves the sidebar.",
  ],
  areas: [
    { name: "Progress", description: "A ring and a line such as **2 of 4 setup steps complete.** at the top of the guide. Skipped steps count as complete." },
    { name: "Skip tutorial", description: "Skips every step that is still open and opens **Home**, without asking you to confirm." },
    { name: "Add opening hours to book appointments", description: "A notice that shows when **Appointments** is set to **Books appointments** on the **AI settings** screen but the business has no opening hours. With several AI agents, it follows the default receptionist's **Appointments** setting. The receptionist offers times only inside opening hours, so until you add them it takes a message instead. **Add opening hours** opens the opening hours on the **AI settings** screen." },
    { name: "Steps", description: "The four steps, in order. An open step has a dashed circle and expands to show what it does, its button and **Skip**. The first open step is expanded for you. A step that is done or skipped has a tick, is crossed out and can't be expanded." },
    { name: "Read the rest of your site", description: "Ticked once the app has finished reading your website in full, up to 50 pages, or when no website has been read for the business, so most new businesses start with it ticked. It stays open when the app read only a sample of your site's pages, while a website is still being read and after a read failed. **Read the rest** reads the site again, up to 50 pages, in place of the sample, and opens the **Knowledge** screen, where you can follow its progress." },
    { name: "Add more sources", description: "Ticked once the business has an uploaded document, such as policies, FAQs or a price list, whether you uploaded it during onboarding or on the **Knowledge** screen. The step ticks as soon as the upload is saved, while the document is still being processed. **Upload document** opens the **Knowledge** screen with the **Upload Document** dialog open." },
    { name: "Hear your agent", description: "Ticked after you call your receptionist from the dashboard and the call connects and ends. **Start a call** starts the call from this browser without leaving the page. With several AI agents, the receptionist chosen beside **Test Call** at the top of the screen answers, or the default receptionist if you haven't chosen one." },
    { name: "Connect a phone number", description: "Ticked once the business has its own active phone number. **Choose a number** opens the **Phone Number** tab of **Settings**. If your plan doesn't include a phone number, it opens the **Upgrade plan** dialog instead, where you can choose a plan that does." },
  ],
  tasks: [
    {
      title: "Work through the setup guide",
      steps: [
        "Select the **Getting started** card at the bottom of the sidebar.",
        "Read the step that is expanded and select its button.",
        "Finish the job on the screen that opens, then come back with the **Getting started** card. The step is ticked once the app sees it done.",
        "Repeat for each open step, or select **Skip** on the ones you don't need.",
      ],
    },
    {
      title: "Hear your receptionist on a test call",
      steps: [
        "Expand **Hear your agent** and select **Start a call**.",
        "Allow the browser to use your microphone if it asks.",
        "Ask something only your business would know and listen to the answer.",
        "Select **Hang up**. The step ticks itself off a few moments after the call ends.",
      ],
    },
    {
      title: "Upload a document for your receptionist",
      steps: [
        "Expand **Add more sources** and select **Upload document**.",
        "In the **Upload Document** dialog, select **Choose File** or drag a file onto the dialog. PDF, DOCX, TXT and Markdown files of up to 25 MB are accepted.",
        "With several AI agents, **Available to** says which receptionists can use the document: leave **Everyone**, or select **Chosen receptionists** and pick them.",
        "Select **Save**. The step is ticked once the document is added.",
      ],
    },
    {
      title: "Skip a step you don't need",
      steps: [
        "Expand the step.",
        "Select **Skip**. The step is crossed out and the next open step expands.",
      ],
    },
    {
      title: "Skip the rest of the guide",
      steps: [
        "Select **Skip tutorial** at the top of the guide.",
        "Every open step is skipped, **Home** opens and the **Getting started** card leaves the sidebar.",
      ],
    },
  ],
  notes: [
    "Each business has its own setup guide. Switch business at the top of the sidebar to see another business's steps.",
    "A skipped step can't be reopened from the guide, but you can still do the work on its own screen: upload documents and read websites on **Knowledge**, call your receptionist with **Test Call** at the top of the screen, and get a number on the **Phone Number** tab of **Settings**.",
    "Only an uploaded document ticks **Add more sources**. A website or text you added, during onboarding or on **Knowledge**, doesn't, and neither does a document that failed to process or was cancelled.",
    "Only a call started from the dashboard ticks **Hear your agent**. Calls through your website widget or to your phone number don't count, and neither does a call that never connected.",
    "**Read the rest of your site** starts ticked for most new businesses, because onboarding saves your website's address without reading the site. To teach the receptionist from your website, import it on the **Knowledge** screen.",
    "A number that the **Phone Number** tab says will be released doesn't tick **Connect a phone number**.",
    "The steps are checked each time the guide loads, so a step that was done and not skipped can open again: **Read the rest of your site** while a website you added on **Knowledge** is being read or after its read failed, **Add more sources** when your only uploaded document fails to process, and **Connect a phone number** when the business's number is due to be released. The **Getting started** card then comes back too.",
  ],
  troubleshooting: [
    {
      question: "Why can't I see the Getting started card?",
      answer: "It shows only to owners and admins, and only until every step of the business's guide is done or skipped. It also hides while the sidebar is collapsed to icons: expand the sidebar to see it.",
    },
    {
      question: "I made a test call, but Hear your agent isn't ticked. Why?",
      answer: "The call has to start from the dashboard and connect: calls through the website widget or to your phone number don't count. Give it a few moments after the call ends, then reload the page. If the call couldn't start, it says why, such as **Microphone access was blocked.** Allow the browser to use your microphone and try again.",
    },
    {
      question: "I added knowledge, but Add more sources isn't ticked. Why?",
      answer: "Only an uploaded document ticks it. A website or a text entry doesn't. If you uploaded a document, check on the **Knowledge** screen that it didn't fail, and upload it again if it did.",
    },
    {
      question: "Why does Choose a number open Upgrade plan?",
      answer: "Your current plan doesn't include a phone number. Choose a plan that does, or select **Skip** to leave the step for now.",
    },
    {
      question: "Why is Read the rest of your site still open?",
      answer: "The app read only a sample of your site, is still reading it, or the last read failed. Select **Read the rest** to read the site again, and follow its progress on the **Knowledge** screen.",
    },
    {
      question: "I skipped a step by mistake. Can I undo it?",
      answer: "Not from the guide. Do the work on the step's own screen instead: the step counts as done either way.",
    },
    {
      question: "Selecting Skip, Skip tutorial or Read the rest shows Something went wrong. Please try again. What now?",
      answer: "That change didn't go through, so the step stays as it was. After **Skip tutorial**, the steps skipped before the error stay skipped and the guide stays open. Check your connection, reload the page and try again.",
    },
  ],
  related: ["home", "knowledge", "ai-settings", "phone-number", "plan"],
  keywords: ["getting started", "setup checklist", "onboarding checklist", "next steps", "first steps", "skip tutorial", "test call", "upload document", "connect phone number", "hear your agent", "read the rest of your site"],
};

export default article;
