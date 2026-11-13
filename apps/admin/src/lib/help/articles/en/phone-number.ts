import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "phone-number",
  title: "Phone Number",
  section: "settings",
  summary: "See the number callers dial to reach your AI receptionist, get a number or change it once, keep a number that's set to be released and, with several receptionists, choose who answers each number.",
  screenPaths: ["/settings/phone-number"],
  location: ["Sidebar", "Manage", "Settings", "Phone Number"],
  access: "Everyone on the team can see the business's phone number and, with several AI agents, who answers it. Only owners and admins can get a number, change it, choose who answers each number, or use the buttons on a notice that the number will be released.",
  purpose: [
    "Your business number is the number callers dial to reach your AI receptionist. It's a local number in the US, Canada, the UK or Australia, and it takes both calls and texts. The receptionist answers the calls, and your team reads and answers the texts on the **Messages** screen.",
    "A business gets a number of its own when its plan includes one. You pick it from the numbers on offer, during setup or later on this screen, and you can change it once. After a change, the previous number keeps working for 30 days, so callers have time to learn the new one.",
    "When the business has several AI agents, each number names the receptionist that answers it. The screen shows who answers your number and lists the business's other numbers, each with its own receptionist.",
  ],
  areas: [
    { name: "Release notice", description: "Shown at the top when your number is set to be released, with the date. If the business's last prepaid pack ended, it asks you to buy a pack or choose a plan before then, with **Buy a pack**, which opens the **Plan** screen, and **Choose a plan**, which shows the plans on offer. Otherwise it asks you to move to a plan that includes a number, with **Upgrade to keep this number**, which shows the plans on offer too. Only owners and admins see the buttons." },
    { name: "Current phone number", description: "The number callers use to reach your AI receptionist, or **You don't have a number yet.** When the plan includes no number, it says so instead, and owners and admins see **View plans**, which shows the plans on offer. Otherwise owners and admins see **Get number**, or **Request change** once the business has a number." },
    { name: "Answered by", description: "Under the number, when the business has several AI agents. Owners and admins choose the receptionist that answers the number, and everyone else sees its name." },
    { name: "Other numbers", description: "Shown when the business has several AI agents and other active numbers, such as a previous number in its last 30 days. Each number has its own **Answered by**." },
    { name: "Choose a phone number", description: "The dialog that opens from **Get number**, titled **Choose a new phone number** when it opens from **Request change**. It lists numbers on offer, with **Country**, **Area code** and **Search** above the list." },
  ],
  fields: [
    {
      title: "Choose a phone number",
      description: "The dialog that opens from **Get number** or **Request change**. It starts with a list of numbers suggested for your business.",
      fields: [
        { name: "Country", description: "The country the number is in: **US** for the United States, **CA** for Canada, **UK** for the United Kingdom or **AU** for Australia. It starts on the country of your business's time zone, or on **US** when that time zone isn't in one of these countries. Choose one, then select **Search**." },
        { name: "Area code", requirement: "optional", description: "Shown for the US and Canada only. Type up to three digits to look for numbers with that area code, or leave it empty to see numbers from anywhere in the country." },
        { name: "Phone number", description: "The list of numbers on offer, up to 10 at a time, each with its city and region where they're known and a **Select** button. **Load more** at the bottom adds more, up to 20. When nothing is found, the list says **No numbers matched that search.** in place of numbers." },
      ],
    },
    {
      title: "Answered by",
      description: "Shown under each number when the business has several AI agents.",
      fields: [
        { name: "Answered by", description: "The receptionist that answers calls to this number. New text conversations on it are listed under that receptionist on the **Messages** screen. While it's paused, the default receptionist answers, and a note under the field says so. If the receptionist chosen was archived, the default receptionist answers, and a note asks you to pick another one. The choice saves as soon as you make it, and a message confirms who answers the number now." },
      ],
    },
  ],
  tasks: [
    {
      title: "Get a phone number",
      steps: [
        "Open **Settings** in the sidebar and select the **Phone Number** tab.",
        "Select **Get number**.",
        "Look through the numbers on offer. To see others, choose a **Country**, type an **Area code** if you like, and select **Search**.",
        "Select the **Select** button beside the number you want. A spinner shows on it while the number is set up for your business.",
        "When the number is ready, the dialog closes, a message says \"Phone number added.\" and the number shows under **Current phone number**.",
      ],
    },
    {
      title: "Change your phone number",
      steps: [
        "Select **Request change**. The dialog reminds you that you can change your number once.",
        "Find a number as above and select the **Select** button beside it.",
        "When it's ready, the new number shows under **Current phone number**, and a message says your previous number will stay active for 30 days.",
        "Update the number on your website, signs and listings before the previous one stops working.",
      ],
    },
    {
      title: "Choose who answers a number",
      steps: [
        "Find **Answered by** under the number. It shows only when the business has several AI agents.",
        "Choose the receptionist. A message confirms that calls and texts to the number go to that receptionist now.",
      ],
    },
    {
      title: "Keep a number that's set to be released",
      steps: [
        "Read the date in the notice at the top of the screen.",
        "If your last pack ended, select **Buy a pack** to buy one on the **Plan** screen, or **Choose a plan**.",
        "Otherwise, select **Upgrade to keep this number** and choose a plan that includes a number.",
        "Do it before the date in the notice, and the business keeps its number.",
      ],
    },
  ],
  notes: [
    "A business can change its number once. After that, **Request change** is greyed out.",
    "After a change, the previous number keeps taking calls and texts for 30 days. Then it's released and stops working for your business.",
    "A list of numbers is good for 5 minutes. The numbers aren't held for you, so someone else can take one in the meantime. If you wait longer before you pick one, select **Search** first.",
    "Setting up a number usually takes a moment. While a number you picked is being set up, **Get number** or **Request change** is greyed out for you, and the screen shows the number as soon as it's ready.",
    "To stop numbers from being used up, each person can try 3 numbers an hour, failed tries included, and get 2 numbers in 24 hours and 5 in 30 days, across all of their businesses. Searching many times in a few minutes asks you to wait a few minutes.",
    "Every number on offer is a local number that can take both calls and texts.",
    "When the business's last prepaid pack ends and its plan includes no number, the number stops answering calls and texts, and the notice gives the date it will be released, 30 days after the pack ended. Buying a pack or starting a plan that includes a number before then makes it answer again.",
    "The receptionist never answers texts. Your team reads and answers them on the **Messages** screen, and replies go out from your business number.",
    "Your public profile shows your number, and the website widget offers calls from the browser only while the business has a number.",
    "With several AI agents, a call already in progress keeps the receptionist it started with when you change **Answered by**.",
  ],
  troubleshooting: [
    {
      question: "Why is Get number or Request change greyed out?",
      answer: "**Request change** is greyed out once the business has used its one change, or when its plan doesn't include a number. Either button is greyed out while a number you picked is still being set up, so wait for it to finish. To change the number on a plan that doesn't include one, first choose a plan that does on the **Plan** screen.",
    },
    {
      question: "Why don't I see Get number or Request change?",
      answer: "Only owners and admins can get or change the business's number, and when the plan includes no number and the business has none, they see **View plans** instead. If you're not an owner or admin, ask one to make the change, or to change your role on the **Team** screen.",
    },
    {
      question: "It says \"That number was just taken.\" What now?",
      answer: "Someone else got that number first. The list has been refreshed, so pick another number from it.",
    },
    {
      question: "It says the list of numbers has expired.",
      answer: "A list of numbers is good for 5 minutes. Select **Search** to get a fresh list, then pick a number.",
    },
    {
      question: "It says this workspace already has a phone number.",
      answer: "Someone else got a number for the business while you were choosing. Reload the page to see it.",
    },
    {
      question: "The list says no numbers matched that search.",
      answer: "No numbers are free with that area code right now. Try another area code, or clear **Area code** and search the whole country.",
    },
    {
      question: "It says the phone carrier couldn't search with that area code.",
      answer: "Check that the area code is right for the country you chose, or clear it and search again.",
    },
    {
      question: "It says the phone carrier has no numbers of this kind in this country.",
      answer: "No numbers can be offered in that country right now. Choose another **Country** and select **Search**, or try again later.",
    },
    {
      question: "It says \"We couldn't load numbers right now.\" or \"We couldn't search numbers right now.\" What can I do?",
      answer: "The list of numbers couldn't be fetched. Wait a moment and select **Search** again, or close the dialog and open it again. If the message ends with an **Error ID**, give it to support.",
    },
    {
      question: "It says I've reached a limit on numbers. What can I do?",
      answer: "The message says which limit: 3 tries an hour, 2 numbers in 24 hours or 5 in 30 days. Wait as long as it says, then try again.",
    },
    {
      question: "It says there were too many searches.",
      answer: "Wait a few minutes, then search again.",
    },
    {
      question: "It says another number for this workspace is still being set up.",
      answer: "A number someone picked for this business is still being set up. Wait a few minutes, then reload the page.",
    },
    {
      question: "It says this workspace has already used its one number change.",
      answer: "A business can change its number only once, and this one already has. Keep using the current number.",
    },
    {
      question: "It says a dedicated business number needs a paid plan.",
      answer: "The business's plan doesn't include a phone number. Choose a plan that includes one on the **Plan** screen, then come back to get a number.",
    },
    {
      question: "It says it couldn't get or replace the number. What do I do?",
      answer: "Reload the page first, because a number that took longer than usual to set up may have arrived. If it hasn't, select the number again or pick another one. If the message ends with an **Error ID**, give it to support.",
    },
    {
      question: "It says phone numbers aren't set up yet.",
      answer: "Numbers can't be picked on this dashboard right now. Contact support.",
    },
    {
      question: "My number stopped answering calls. Why?",
      answer: "If the notice at the top says your last pack ended, the number doesn't answer until the business has a pack again or a plan that includes a number. Select **Buy a pack** or **Choose a plan** before the date in the notice to keep the number.",
    },
  ],
  related: ["plan", "ai-agents", "messages", "public-profile", "website-widget", "usage", "onboarding-number", "setup-guide"],
  keywords: ["business number", "phone number", "change number", "replace number", "new number", "local number", "area code", "number released", "which receptionist answers", "call routing", "dedicated number"],
};

export default article;
