import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-number",
  title: "Pick your AI's phone number",
  section: "getting-started",
  summary: "Choose the local phone number callers dial to reach your AI receptionist, or skip the step and pick one after setup.",
  screenPaths: ["/onboarding/number"],
  location: ["Sign up", "Onboarding", "Step 7 of 8"],
  access: "Only owners and admins of the business can see the numbers on offer, pick one or skip this step. Others on the team see a message that numbers couldn't be loaded in place of the numbers. Setup only comes to this step when the business's plan includes a phone number.",
  purpose: [
    "This step gives your AI receptionist a phone number of its own. Callers dial it to reach your business, and the receptionist answers.",
    "The list starts with local numbers in the country your business's time zone points to. You can search another country, and in the United States and Canada an area code, then select the number you want. The app then sets the number up for your business, which takes a moment.",
    "You only come to this step when your plan includes a phone number. If you'd rather choose later, select **I'll add a number later** and pick one after setup on the **Phone Number** tab in **Settings**.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's own logo and name, as on the sign-in page." },
    { name: "Country", description: "The country to search in. It starts on the country your business's time zone is in, or the US when the time zone doesn't point to one of the countries on offer." },
    { name: "Area code", description: "Shown only when the country is the US or Canada, for finding numbers with a particular area code." },
    { name: "Search", description: "Looks for numbers in the country and area code you chose, and replaces the list with what it finds. It shows a spinner while it works." },
    { name: "Phone number list", description: "Up to 10 numbers at a time, each with its city and region where they're known, and a **Select** button. Placeholder bars show while the list loads. When the list is full, **Load more** at the bottom adds more numbers, up to 20. When nothing is found, the list says **No numbers matched that search.** in place of numbers." },
    { name: "Messages under the list", description: "Say in red when numbers couldn't be loaded, searched or set up, and what to do. A message about a failure on the app's side ends with an **Error ID** to give to support." },
    { name: "I'll add a number later", description: "The link at the bottom. It goes on to the last step without a number, and says **Skipping...** while it works. It's turned off while a number is being set up." },
    { name: "Selected number", description: "When the business already has its number, for example when you come back to this step later in setup, the title reads **Your AI's phone number** and the step shows the number under **Selected number**, with **Continue** to go on to the last step." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step is the seventh. From the second dot on, the dot of a step your business has already reached opens that step." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at the step your business is on." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "Pick your AI's phone number",
      fields: [
        { name: "Country", description: "The country the number is in: **US** for the United States, **CA** for Canada, **UK** for the United Kingdom or **AU** for Australia. Choose one, then select **Search**." },
        { name: "Area code", requirement: "optional", description: "For the US and Canada only. Type up to three digits to look for numbers with that area code, or leave it empty to see numbers from anywhere in the country. Anything that isn't a digit is left out." },
      ],
    },
  ],
  tasks: [
    {
      title: "Pick a number",
      steps: [
        "Look through the numbers the step suggests.",
        "To see others, choose a **Country**, type an **Area code** if you like, and select **Search**.",
        "Select the **Select** button beside the number you want. A spinner shows on it while the number is set up for your business.",
        "When the number is ready, the last step opens.",
      ],
    },
    {
      title: "See more numbers",
      steps: [
        "Select **Load more** at the bottom of the list.",
        "Pick from the longer list, or change your search and select **Search** again.",
      ],
    },
    {
      title: "Skip this step",
      steps: [
        "Select **I'll add a number later**.",
        "The last step opens. After setup, pick a number on the **Phone Number** tab in **Settings**.",
      ],
    },
    {
      title: "Pick a number after skipping, before you finish setup",
      steps: [
        "On the last setup step, select the seventh progress dot at the bottom.",
        "Pick a number as above. When it's ready, the last step opens again.",
      ],
    },
  ],
  notes: [
    "Every number on offer can take both calls and texts. The list shows local numbers only.",
    "A list of numbers is good for 5 minutes. If you wait longer before you pick one, search again first. A number isn't held for you until you select it, so someone else can take it in the meantime.",
    "This step picks the business's first number. Once it's set up, coming back to this step shows the number instead of the list.",
    "Each person can try 3 numbers an hour, failed tries included, and get 2 numbers in 24 hours and 5 in 30 days, across all of their businesses. Changing a number later counts too.",
    "Each person can search 20 times in 10 minutes, and load the step's suggested numbers 10 times in 10 minutes. Past that, the step asks you to wait a few minutes.",
    "If you reload the page while a number is being set up, the step shows a spinner until the number is ready.",
    "After setup, you can change the number once, on the **Phone Number** tab in **Settings**.",
    "If your plan doesn't include a phone number, setup skips this step. Choosing a plan that includes one, on the plan step or later on the **Plan** screen, lets you pick a number.",
  ],
  troubleshooting: [
    {
      question: "The step says \"That number was just taken.\" What now?",
      answer: "Someone else got that number first. The list has been refreshed, so pick another number from it.",
    },
    {
      question: "The step says \"This list of numbers has expired.\" What now?",
      answer: "A list is good for 5 minutes. Select **Search** to get a fresh list, then pick a number.",
    },
    {
      question: "The list says no numbers matched that search.",
      answer: "No numbers are free with that area code right now. Try another area code, or clear **Area code** and search the whole country.",
    },
    {
      question: "The step says the phone carrier couldn't search with that area code, or has no numbers of this kind in this country.",
      answer: "Check that the area code is right for the country you chose, or clear it and search again. If the carrier has no numbers in that country, choose another **Country**.",
    },
    {
      question: "The step says I've reached a limit on numbers. What can I do?",
      answer: "The message says which limit: 3 tries an hour, 2 numbers in 24 hours or 5 in 30 days. Wait as long as it says, or select **I'll add a number later** to finish setup and pick a number later on the **Phone Number** tab in **Settings**.",
    },
    {
      question: "The step says there were too many searches.",
      answer: "Wait a few minutes, then search again.",
    },
    {
      question: "The step says a dedicated business number needs a paid plan.",
      answer: "Your business's plan doesn't include a phone number. Go back to the plan step with the sixth progress dot and choose a plan that includes one, or select **I'll add a number later**.",
    },
    {
      question: "The step says another number for this workspace is still being set up.",
      answer: "A number you or someone else picked for this business is still being set up. Wait a few minutes, then reload the page.",
    },
    {
      question: "The step says this workspace already has a phone number.",
      answer: "The business got its number, for example from an earlier try that finished late. Reload the page: the step shows the number, with **Continue** to go on, or opens the last step by itself.",
    },
    {
      question: "The step says it couldn't provision that number.",
      answer: "The step waits up to two minutes for a number to be set up. Reload the page first: if the number was set up after all, the step shows it or moves on. Otherwise, select the number again or pick another one. If the message ends with an **Error ID**, give it to support.",
    },
    {
      question: "The step says phone numbers aren't set up yet.",
      answer: "Numbers can't be picked here right now. Select **I'll add a number later** to finish setup, and contact support.",
    },
    {
      question: "The step says it couldn't load or search numbers right now.",
      answer: "Check your connection and select **Search** to try again. If you joined a business someone else owns and it isn't set up yet, only its owners and admins can pick its number, so ask one of them.",
    },
    {
      question: "The step says it couldn't skip this step right now.",
      answer: "Check your connection and select **I'll add a number later** again. Only owners and admins of the business can skip the step.",
    },
  ],
  related: ["onboarding-plan", "onboarding-attribution", "phone-number", "plan", "calls"],
  keywords: ["phone number", "business number", "local number", "area code", "choose a number", "dedicated number", "skip number", "country", "number for calls"],
};

export default article;
