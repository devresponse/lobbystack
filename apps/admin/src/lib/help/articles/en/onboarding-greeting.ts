import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-greeting",
  title: "How should we greet your callers?",
  section: "getting-started",
  summary: "Write the first words your AI receptionist says when it answers a call, then go on to choose a plan.",
  screenPaths: ["/onboarding/greeting"],
  location: ["Sign up", "Onboarding", "Step 5 of 8"],
  access: "Anyone on the team of a business that hasn't finished setup is brought to its current step and can see the saved greeting here. Only owners and admins can save the greeting and go on from this step.",
  purpose: [
    "This step sets the greeting: the sentence your AI receptionist says as soon as it answers a call. It's the first thing every caller hears.",
    "The box starts with the greeting already saved for your business: for a new business, a short one in English that thanks callers for calling and names your business. Keep it, or write your own, for example one that names your business and offers help.",
    "Continuing also sets the language your calls open in. It becomes the language you're using the app in when calls can use that language, and English otherwise.",
    "You can change the greeting and the language at any time after setup, on the **AI settings** screen.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's own logo and name, as on the sign-in page." },
    { name: "Website reading progress", description: "Shows above the greeting only when a website has already been added to your business's knowledge, and the app is reading it or has read it. While it reads, it shows **Reading** with the site's address, a progress bar and counts of the pages read so far and the pages ready for questions, and it updates by itself. When it's done, it says how many pages are ready for questions. If reading failed, it says so and suggests adding your details by hand or trying the import again from the dashboard. It doesn't appear for an address saved on the website step, because that step doesn't read the site." },
    { name: "Greeting", description: "The box for the words your receptionist opens each call with. It holds the greeting saved for your business, which you can change. When it's empty, it shows an example." },
    { name: "Continue", description: "Saves the greeting and opens the next step, where you choose a plan. It stays off until the box has some text and the page has finished loading, and says **Saving...** while it works. A problem with saving shows just above it." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step is the fifth. From the second dot on, the dot of a step your business has already reached opens that step." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at the step your business is on." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "How should we greet your callers?",
      fields: [
        { name: "Greeting", requirement: "required", description: "The first thing your receptionist says on every call, such as \"Thanks for calling. How can I help?\" Write it in the language callers should hear first. Up to 2,000 characters, though a sentence or two works best." },
      ],
    },
  ],
  tasks: [
    {
      title: "Set your greeting",
      steps: [
        "Read the suggested greeting in **Greeting**, and change it if you like.",
        "Select **Continue**. The greeting is saved and the step for choosing a plan opens.",
      ],
    },
    {
      title: "Change the greeting during setup",
      steps: [
        "On a later setup step, select the fifth progress dot at the bottom.",
        "Change the text in **Greeting**.",
        "Select **Continue**. The new greeting is saved and the plan step opens. The steps you've already finished stay finished.",
        "To return to the step you were on, select its progress dot.",
      ],
    },
    {
      title: "Change the greeting after setup",
      steps: [
        "Open **AI settings** under **Agent** in the sidebar.",
        "With several AI agents, choose the receptionist in the **Receptionist** dropdown under **Each receptionist's own**.",
        "Beside **Greeting**, select **Edit**.",
        "Change the text and select **Save**. **Changes saved** shows under the setting.",
      ],
    },
  ],
  notes: [
    "The receptionist says the greeting once, at the very start of each call.",
    "A changed greeting reaches the receptionist moments after you save it, for calls that start after that. A call already in progress keeps the one it started with.",
    "Calls made from a web browser, such as a test call from the dashboard, open with the greeting too. Once setup is finished, owners and admins can hear it with **Test Call** at the top of the dashboard.",
    "Right after the greeting, calls say \"You're speaking with an AI assistant, and this call is recorded and transcribed.\" in the language the call opens in. Many places require telling callers that a call is recorded, so turn off **Tell callers about AI and recording** on the **AI settings** screen only if you tell them another way.",
    "Each time you continue from this step, the language your calls open in is set to the language you're using the app in, or English when calls can't use it. Calls still switch when a caller speaks another language. To choose another language, change **Default customer language** on the **AI settings** screen. With several AI agents, it's called **Business language**.",
    "Spaces at the start and end of the greeting are dropped when it's saved.",
    "This step sets the greeting of your business's default receptionist. If you add more AI agents later, each one has a greeting of its own, which you change on the **AI settings** screen.",
    "The chat window on your website doesn't show this greeting. It shows the **Greeting** set on the **Website widget** screen, if there is one.",
  ],
  troubleshooting: [
    {
      question: "The step says \"We couldn't save that greeting right now. Please try again.\" What can I check?",
      answer: "Check your connection and select **Continue** again. If the greeting is very long, shorten it to 2,000 characters or fewer. If you joined a business someone else owns and it isn't set up yet, only its owners and admins can finish its setup, so ask one of them.",
    },
    {
      question: "Why is the Continue button turned off?",
      answer: "The greeting is empty. Type the words your receptionist should open calls with, then select **Continue**. If the box has text and the button is still off, wait a moment for the page to finish loading.",
    },
    {
      question: "The suggested greeting is in English, but my callers speak another language. What should I do?",
      answer: "Replace it with your own words in their language, then select **Continue**. This step sets the language calls open in to the language you're using the app in, or English, so after setup check **Default customer language** on the **AI settings** screen and choose your callers' language if it's different.",
    },
    {
      question: "My calls open in the wrong language. How do I fix it?",
      answer: "The language comes from the language you were using the app in when you last continued from this step. Change **Default customer language** on the **AI settings** screen, or **Business language** with several AI agents, and write the greeting in the same language.",
    },
    {
      question: "Callers hear a sentence about AI and recording after my greeting. Can I remove it?",
      answer: "Yes. Turn off **Tell callers about AI and recording** on the **AI settings** screen. Do this only if you tell callers another way, because many places require it.",
    },
  ],
  related: ["onboarding-knowledge", "onboarding-plan", "ai-settings", "ai-agents", "website-widget"],
  keywords: ["greeting", "welcome message", "opening line", "call greeting", "first words", "how calls start", "suggested greeting", "change greeting", "call language", "AI notice", "recording notice"],
};

export default article;
