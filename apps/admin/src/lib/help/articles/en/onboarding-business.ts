import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-business",
  title: "First, what is the name of your business?",
  section: "getting-started",
  summary: "Enter your business's name to create the business and start its setup, after you sign up or when you add another business from the business menu.",
  screenPaths: ["/onboarding/business"],
  location: ["Sign up", "Onboarding", "Step 2 of 8"],
  access: "Anyone with an account can create a business here, up to the number one account may own, and becomes its owner. When the business already exists, only its owners and admins can change its name and go on with its setup.",
  purpose: [
    "This step starts your business's setup, right after you sign up. The name you enter creates your business, makes you its owner and starts the rest of setup: your website, your first documents, the greeting callers hear, your plan, a phone number if your plan includes one, and how you heard about the app.",
    "Use the name your customers know. Your AI receptionist knows your business by this name, the app shows it in the business menu and on your business's public page, and the greeting suggested for the receptionist on a later step uses it.",
    "You also come here to add another business to your account. **Create Business** in the business menu at the top of the sidebar opens this step with an empty name, and the new business goes through the same setup as your first one.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's own logo and name, as on the sign-in page." },
    { name: "Business name", description: "The one box on this step. For a new business it's empty, with an example name as a hint. When the business already exists, for example when you come back to this step or your business started as a demo, it shows the current name." },
    { name: "Continue", description: "Creates the business, or saves the new name of the existing one, and opens the website step. It stays off until you type a name, while the page is loading, and when your account can't own another business. It says **Saving...** while it works, and a problem shows just above it." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step is the second. From the second dot on, the dot of a step your business has already reached opens that step." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at the step your business is on." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "First, what is the name of your business?",
      fields: [
        { name: "Business name", requirement: "required", description: "Your business's name as your customers know it, such as the name on your sign or your website. **Continue** stays off until you enter it. Owners and admins can change it later on the **Team** screen." },
      ],
    },
  ],
  tasks: [
    {
      title: "Create your business",
      steps: [
        "Sign up. If the app first asks you to choose its own name and logo, do that or skip it.",
        "Type your business's name in **Business name**.",
        "Select **Continue**. The business is created with you as its owner, and the website step opens.",
      ],
    },
    {
      title: "Create another business",
      steps: [
        "Open the business menu at the top of the sidebar. It shows the name of the business you're working in.",
        "Select **Create Business**. Beside it, the menu shows how many businesses you own and the most you can own.",
        "Type the new business's name in **Business name** and select **Continue**.",
        "Go through the rest of setup for the new business. It becomes the business you're working in, and the app keeps you in its setup until you finish it. Your other businesses stay as they are, and once setup is done you switch between them in the same menu.",
      ],
    },
    {
      title: "Change the name during setup",
      steps: [
        "On a later setup step, select the second progress dot at the bottom.",
        "Change the name in **Business name**.",
        "Select **Continue**. The new name is saved and the website step opens. The steps you've already finished stay finished.",
      ],
    },
    {
      title: "Change the name after setup",
      steps: [
        "Open **Settings** in the sidebar and select **Team**.",
        "Select **Change** beside **Business name**. Only owners and admins see it.",
        "Type the new name and select **Save**.",
      ],
    },
  ],
  notes: [
    "The business takes its time zone from the device you create it on, or UTC when the app doesn't recognize the device's time zone. If it's wrong, change **Business timezone** on the **AI settings** screen, because the receptionist uses it for your opening hours and the appointment times it offers.",
    "The address of your business's public page is made from the name you give the business when you create it, with a few random characters added when another business already uses that address. Renaming the business later doesn't change the address.",
    "The greeting suggested on a later step uses the name the business had when you created it. Renaming the business afterwards doesn't change the greeting, so check it on the greeting step or on the **AI settings** screen.",
    "Each account can own only a certain number of businesses, and the number can depend on the plans your businesses are on. When you reach it, **Create Business** in the business menu is turned off with a short explanation, and this step says so too.",
    "While you're adding another business, the progress dots lead to the setup steps of the business you were working in, because the new one doesn't exist until you select **Continue**.",
    "If you opened the app from a referral link, the person who shared it is credited with the business you create here, as long as you create it in the same browser.",
    "If you claimed a demo that was made for your business, this step shows the demo's business name. Keep it or change it, then select **Continue**.",
    "Coming back to this step never undoes your progress: the steps you've finished stay finished.",
    "You can't skip ahead. Opening a later setup step before you reach it brings you back to the step your business is on.",
  ],
  troubleshooting: [
    {
      question: "The step says I already own the most businesses I can. What can I do?",
      answer: "Your account owns as many businesses as it's allowed. If the message says to upgrade, a higher plan on one of your businesses lets you add more: select **See plans** in the business menu at the top of the sidebar, or open **Plan** in **Settings**. Otherwise, the account can't own another business until you delete one you no longer need, with **Delete business** on that business's **Team** screen. The first business on your account can't be deleted, and deleting removes a business and all its data for good.",
    },
    {
      question: "The step says \"Workspace setup is unavailable.\" What should I do?",
      answer: "The app couldn't load your businesses. Refresh the page. If the message stays, sign out, sign in again and try once more.",
    },
    {
      question: "The step says \"We couldn't save that business right now. Please try again.\" What should I check?",
      answer: "Check your connection and select **Continue** again. If you joined a business someone else owns and it isn't set up yet, only its owners and admins can finish its setup, so ask one of them.",
    },
    {
      question: "Why is the Continue button turned off?",
      answer: "Type the business's name first. If the box has a name and the button is still off, wait a moment for the page to finish loading. If it stays off, your account already owns the most businesses it can, and the message under the box says so.",
    },
    {
      question: "I can't find Create Business. Where is it?",
      answer: "It's in the business menu at the top of the sidebar, the menu that shows your business's name. The menu hides while the sidebar is collapsed to icons, so expand the sidebar to see it. On a phone, open the sidebar with the menu button first.",
    },
    {
      question: "I opened Create Business by mistake. How do I go back?",
      answer: "Nothing is created until you select **Continue**. Use your browser's back button to return to the dashboard, where you're still working in the same business.",
    },
  ],
  related: ["onboarding-brand", "onboarding-website", "team", "ai-settings", "plan"],
  keywords: ["business name", "create business", "new business", "add a business", "second business", "multiple businesses", "business menu", "workspace", "workspace menu", "company name", "business limit", "rename business", "time zone"],
};

export default article;
