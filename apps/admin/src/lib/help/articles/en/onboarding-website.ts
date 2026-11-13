import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-website",
  title: "What is your business's website?",
  section: "getting-started",
  summary: "Save the address of your business's website during setup, or go on without one if your business has no website.",
  screenPaths: ["/onboarding/website"],
  location: ["Sign up", "Onboarding", "Step 3 of 8"],
  access: "Only owners and admins of the business can save the website or skip this step.",
  purpose: [
    "This step records the address of your business's website. The app keeps it as your business's website and shows it as a link on your business's public page.",
    "Saving the address doesn't teach your AI receptionist anything yet, because the app doesn't read your website on this step. To have the receptionist answer from your website's pages, add the site on the **Knowledge** screen once setup is done.",
    "If your business has no website, select **I don't have a website** and go on to the next step.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's own logo and name, as on the sign-in page." },
    { name: "Website", description: "The box for your website's address. Until you type, it shows `yourcompany.com` as an example. When the business already has an address saved, for example when you come back to this step or your business started as a demo, the box shows it." },
    { name: "Continue", description: "Saves the address and opens the next step, where you add documents. It stays off until you type an address, and says **Saving...** while it works. Any problem, with the address, the saving or the skipping, shows just above it." },
    { name: "I don't have a website", description: "The link under **Continue**. It goes on to the next step without saving an address, and says **Skipping...** while it works. An address saved earlier stays as it is." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step is the third. From the second dot on, the dot of a step your business has already reached opens that step." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at the step your business is on." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "What is your business's website?",
      fields: [
        { name: "Website", requirement: "optional", description: "Your website's address, such as `yourcompany.com`. You can leave out `https://`, because the app adds it. **Continue** needs an address, so if you don't have a website, select **I don't have a website** instead." },
      ],
    },
  ],
  tasks: [
    {
      title: "Save your website",
      steps: [
        "Type your website's address in **Website**, such as `yourcompany.com`.",
        "Select **Continue**. The address is saved and the step for adding documents opens.",
      ],
    },
    {
      title: "Go on without a website",
      steps: [
        "Select **I don't have a website**.",
        "The step for adding documents opens. No address is saved. If you have a website later, you can still have the receptionist read it from the **Knowledge** screen.",
      ],
    },
    {
      title: "Change the address during setup",
      steps: [
        "On a later setup step, select the third progress dot at the bottom.",
        "Change the address in **Website** and select **Continue**. Only the address changes, and the steps you've already finished stay finished.",
      ],
    },
    {
      title: "Have the receptionist learn from your website",
      steps: [
        "Finish setup, then open **Knowledge** in the sidebar.",
        "Select **Add Knowledge**, then **Website**.",
        "Enter the address in **Website URL** and select **Import Website**. The app reads the site's public pages and adds them to what the receptionist knows.",
      ],
    },
  ],
  notes: [
    "Enter the address with `http://` or `https://` at the start, or with neither. Local network addresses, such as `localhost` or one ending in `.local`, bare IP addresses and addresses that include a user name or password are refused.",
    "The app doesn't open the site to check the address on this step, so check the spelling before you continue.",
    "Anything after a question mark or a `#` in the address is dropped, so enter the plain address of your site or of the page you want.",
    "Your public page shows the website as a link. Other people can see the page only once you publish it on the **Public profile** screen.",
    "Coming back to this step during setup to change the address keeps your setup progress.",
  ],
  troubleshooting: [
    {
      question: "The step says \"Enter your website address, like yourcompany.com.\" but I did. What's wrong?",
      answer: "The address couldn't be used. Type it as it appears in your browser's address bar, with no spaces, such as `yourcompany.com` or `https://www.yourcompany.com`. Local network addresses, bare IP addresses and addresses with a user name or password aren't accepted.",
    },
    {
      question: "The step says \"We couldn't save your website right now.\" or \"We couldn't skip this step right now.\" What should I do?",
      answer: "Check your connection and try again. If you joined a business someone else owns and it isn't set up yet, only its owners and admins can finish its setup, so ask one of them.",
    },
    {
      question: "My receptionist doesn't know anything from my website. Why?",
      answer: "This step only saves the address. The app reads your website once you add it on the **Knowledge** screen: select **Add Knowledge**, then **Website**.",
    },
    {
      question: "Why is the Continue button turned off?",
      answer: "Type an address first. If your business has no website, select **I don't have a website** instead.",
    },
    {
      question: "How do I change the website address after setup?",
      answer: "Once setup is finished, the dashboard has no screen for changing it. To have the receptionist learn from a new site, add the site on the **Knowledge** screen. If the link on your public page has to change, contact support.",
    },
  ],
  related: ["onboarding-business", "onboarding-knowledge", "knowledge", "public-profile"],
  keywords: ["website", "web address", "URL", "domain", "site", "no website", "skip website", "change website address", "import website"],
};

export default article;
