import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-attribution",
  title: "How did you hear about the app?",
  section: "getting-started",
  summary: "The last setup step: say how you first heard about the app, or skip the question, to finish setup and open the dashboard.",
  screenPaths: ["/onboarding/attribution"],
  location: ["Sign up", "Onboarding", "Step 8 of 8"],
  access: "Anyone on the team of a business that hasn't finished setup can be brought to this step, but only owners and admins of the business can finish setup here.",
  purpose: [
    "This is the last step of setup. It asks how you first heard about the app. Your answer helps the people who run the app learn how businesses find it, and it doesn't change any of your settings.",
    "Answering is up to you. Choose the answer that fits and select **Finish**, or select **Skip**. Either way, setup is complete and the dashboard opens.",
    "From then on, signing in takes you straight to the dashboard instead of setup.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's own logo and name, as on the sign-in page." },
    { name: "Answers", description: "Fifteen answers, each with an icon: **Google**, one for AI assistants, **YouTube**, **Newsletter or blog**, **From work**, **Podcast**, **Instagram**, **In the news**, **LinkedIn**, **X**, **Reddit**, **Facebook**, **Friends or school**, **TikTok** and **Other**. Select one to choose it, and it's highlighted. Selecting another answer changes your choice." },
    { name: "Finish", description: "Saves your answer, completes setup and opens the dashboard. It stays off until you choose an answer, and says **Finishing...** while it works. A problem with finishing shows just above it." },
    { name: "Skip", description: "The link under **Finish**. It completes setup without an answer and opens the dashboard. An answer you selected isn't saved." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step is the eighth and last. From the second dot on, the dot of an earlier step opens that step." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at this step until you finish it." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  tasks: [
    {
      title: "Answer and finish setup",
      steps: [
        "Select the answer that best describes how you heard about the app. If none fits, select **Other**.",
        "Select **Finish**. Setup is complete and the dashboard opens.",
      ],
    },
    {
      title: "Finish setup without answering",
      steps: [
        "Select **Skip** under **Finish**.",
        "Setup is complete and the dashboard opens.",
      ],
    },
    {
      title: "Change an earlier step before you finish",
      steps: [
        "Select the progress dot of the step you want to change, such as the fifth for the greeting.",
        "Make the change and save it on that step, usually with its **Continue** button. The steps you've already finished stay finished.",
        "Select the eighth progress dot to come back here, then select **Finish** or **Skip**.",
      ],
    },
  ],
  notes: [
    "**Finish** and **Skip** both complete setup for the business. Afterwards the setup steps no longer open by themselves, and everything you set up can be changed in the dashboard.",
    "Your answer is kept with your business so the people who run the app can see how businesses find it. It doesn't affect anything in the app, and the dashboard doesn't show it.",
    "If you came to the app through someone's referral link in this browser, finishing this step, with **Finish** or **Skip**, also passes that referral on, in case it wasn't recorded when you created the business.",
    "About a day after setup is finished, the business's owner may get a short email asking how they like the app. It isn't sent if they've been back to the app, or the business has had a call, since then.",
    "Once the dashboard opens, owners and admins see a **Getting started** card in the sidebar until its steps are done. It opens the setup guide, which lists what to do next, such as hearing your receptionist on a call from your browser and adding more documents.",
  ],
  troubleshooting: [
    {
      question: "Why is the Finish button turned off?",
      answer: "Choose an answer first. To finish without answering, select **Skip**.",
    },
    {
      question: "The step says \"Request failed.\" What should I do?",
      answer: "Something went wrong while finishing setup. Check your connection and select **Finish** or **Skip** again.",
    },
    {
      question: "The step says \"You do not have access to this business.\" Why?",
      answer: "Only owners and admins can finish the business's setup. If you joined a business someone else owns, ask one of its owners or admins to finish it.",
    },
    {
      question: "The step says \"Attribution cannot be submitted at this onboarding stage.\" Why?",
      answer: "The business isn't on this step yet. Reload the page: setup opens at the step the business is on, so you can finish that step first and then come back here.",
    },
    {
      question: "I picked the wrong answer. Can I change it?",
      answer: "Before you finish, select the right answer instead. Your answer doesn't affect anything in the app, so there's nothing to fix after you finish.",
    },
  ],
  related: ["onboarding-number", "onboarding-plan", "home", "setup-guide", "affiliate-program"],
  keywords: ["how did you hear about us", "referral source", "survey", "finish setup", "complete setup", "last step", "skip", "source", "referral link"],
};

export default article;
