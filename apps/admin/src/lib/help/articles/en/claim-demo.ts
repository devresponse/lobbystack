import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "claim-demo",
  title: "Claim a demo receptionist",
  section: "getting-started",
  summary: "Make a demo receptionist your own: the business it was made for becomes a business on your account, and setup opens so you can finish it.",
  screenPaths: ["/claim-demo"],
  location: ["Demo page", "Claim this receptionist"],
  access: "Anyone with the demo link can open this page. Claiming needs you to be signed in, to a new account or one you already have, and works only while the demo is open. Only the first account to claim it gets it: after that, the demo is closed to everyone else.",
  purpose: [
    "Claiming turns a demo into a business on your account. The business the demo was made for becomes yours, with its name, its website address, the receptionist and its greeting, what the receptionist learned from the website, and the calls made from the demo page with any messages taken on them. You become its owner.",
    "You need an account to claim. **Claim this receptionist** on the demo page opens the sign-up page: create an account there, or sign in to one you have, and the app brings you to this page. If you're already signed in, it comes straight here. You fill in nothing on this page: it claims the receptionist on its own as soon as you're signed in.",
    "Once it's claimed, the app switches to the business and setup opens at the step that asks for the business's name, with the demo's name filled in. From there, setup goes on as for any new business: the website, training documents, greeting, plan, a phone number if your plan includes one, and how you heard about the app.",
    "The person who prepared the demo leaves the business's team when you claim it and can no longer open the business. You can invite your own team from the **Team** screen.",
  ],
  areas: [
    { name: "Question mark", description: "At the top left, opens this help beside the page." },
    { name: "Setting up your workspace", description: "Shows with a spinning circle and **Claiming your receptionist and getting your workspace ready...** while the page checks the demo and claims it. If the demo is still being prepared, the page waits here and claims it once it's ready. When the claim is done, setup opens." },
    { name: "This demo link is unavailable", description: "Says **The demo link is missing or no longer valid.** It shows when the page has no demo to claim, for example because the claim page opened in a different browser tab from the demo, when the link isn't valid or was replaced by a newer one, or when the demo has expired, has been turned off or was claimed by another account." },
    { name: "Your account owns the most businesses it can", description: "Says **Delete one of your businesses, or sign in with another account, to claim this demo.** Claiming adds a business you own, and your account already owns as many as it may. **Try again** is below the message." },
    { name: "Your account owns the most businesses its plans allow", description: "Shows in place of the message above when a higher plan on one of your businesses would let your account own more. It says **Upgrade one of your businesses to a higher plan, delete one, or sign in with another account, to claim this demo.** with **Try again** below it." },
    { name: "We couldn't claim this demo", description: "Says **Something went wrong while claiming this demo. Please try again.** It shows when the claim fails for another reason, such as a lost connection or the demo closing while the page was open. **Try again** is below the message." },
    { name: "Try again", description: "Tries the claim again with the same demo. The page keeps the demo in this browser tab, so you can fix what stopped the claim in another tab and come back." },
  ],
  tasks: [
    {
      title: "Claim a demo with a new account",
      steps: [
        "On the demo page, select **Claim this receptionist**.",
        "On **Create your account**, enter your **Email** and a **Password**, complete the security check if one shows, and select **Create account**.",
        "Enter the 6-digit code the app emails you and select **Verify email**.",
        "Wait while the page shows **Setting up your workspace**.",
        "When setup opens, check the business's name and select **Continue**.",
        "Go through the rest of setup.",
      ],
    },
    {
      title: "Claim a demo with an account you already have",
      steps: [
        "On the demo page, select **Claim this receptionist**. If you're already signed in, the claim starts straight away, for the account you're signed in to.",
        "Otherwise, select **Sign in** under the form, then sign in with your **Email** and **Password**.",
        "Wait while the page claims the receptionist. Setup opens on the business's name.",
        "Check the name, select **Continue** and go through the rest of setup.",
      ],
    },
    {
      title: "Make room for the business, then claim it",
      steps: [
        "Leave the claim page open.",
        "In another tab, open the dashboard and pick a business you own and no longer need in the business menu at the top of the sidebar.",
        "Open **Settings**, then **Team**, and select **Delete business**.",
        "Type the business's name and **Your password**, then select **Delete permanently**. This erases that business and all its data for good.",
        "Or, if the message suggests upgrading, move one of your businesses to a higher plan on its **Plan** tab in **Settings** instead.",
        "Back on the claim page, select **Try again**.",
      ],
    },
    {
      title: "Claim with a different account",
      steps: [
        "Before you claim, if you're signed in to the wrong account, select **Sign out**. In the dashboard, it's in the menu with your email address at the bottom of the sidebar. On a setup screen, it's at the top right.",
        "Open the demo link again and select **Claim this receptionist**.",
        "Select **Sign in** under the form and sign in with the other account, or create a new account.",
      ],
    },
  ],
  notes: [
    "The claim goes to the account you're signed in to in this browser, without asking first. Make sure it's the account that should own the business.",
    "The page keeps the demo in the browser tab where you selected **Claim this receptionist**. Create your account or sign in in that same tab, because another tab or browser can't find the demo.",
    "If you're signed out when the page claims, it opens the log-in page and comes back here once you sign in. **Create one** on that page makes a new account and also comes back here.",
    "Claiming counts toward the number of businesses your account can own, the same as creating one. Only businesses you own count, not ones where you're an admin, scheduler or viewer. The business menu at the top of the sidebar shows how many you own and the most you can own, next to **Create Business**.",
    "When the claim is refused because of that limit, nothing changes: the demo stays open for you to claim once you have room, until it expires or someone else claims it.",
    "You don't need a plan to claim. You choose one during setup, as for any new business.",
    "Once you claim it, the demo's link says the demo has already been claimed, and nobody else can claim it. The person who prepared it sees it as claimed on their **Prospect demos** screen.",
    "Calls made from the demo page stay with the business and can show on the **Calls** screen. They don't add to **Questions**, and they don't count toward your plan's usage.",
    "Messages the receptionist took on demo calls stay with the business too and can show on the **Messages** screen. People trying a demo often give sample names and numbers, so check the details before you call anyone back.",
    "If you already use the app for other businesses, they don't change. Until the claimed business's setup is done, though, the app opens on its setup steps instead of the dashboard, so finish setup to get back to your other businesses.",
    "The business keeps the time zone it was given when the demo was prepared, which may not be yours. Check **Business timezone** on the **AI settings** screen once setup is done.",
  ],
  troubleshooting: [
    {
      question: "Why does it say This demo link is unavailable?",
      answer: "The page has no demo to claim, or the demo can no longer be claimed. Open the demo link again. If it still shows **Claim this receptionist**, select it and finish signing in in that same tab. If it says the demo has expired, is no longer available or has already been claimed, ask the person who sent the link for a new demo.",
    },
    {
      question: "Someone else claimed the demo first. Can I still get it?",
      answer: "No. A demo belongs to the first account that claims it. If you claimed it yourself with another account, sign in with that account to find the business. Otherwise, ask the person who sent the link for a new demo.",
    },
    {
      question: "Why does it say my account owns the most businesses it can?",
      answer: "Claiming adds a business you own, and your account already owns as many as it may. Delete a business you own and no longer need with **Delete business** on its **Team** tab in **Settings**, then select **Try again**. Deleting erases that business and all its data for good. Some businesses can't be deleted, such as the first business on your account or the only one you own, and the **Team** tab says why. If none of yours can go, sign in with another account instead.",
    },
    {
      question: "It says a higher plan would let me claim the demo. What do I do?",
      answer: "A higher plan on one of your businesses lets your account own more businesses. Select **See plans** in the business menu at the top of the sidebar, or open **Plan** in **Settings**, and move one of your businesses to a higher plan. Then come back and select **Try again**.",
    },
    {
      question: "Why does it say We couldn't claim this demo?",
      answer: "Something stopped the claim, such as a lost connection, or the demo closed while the page was open. Select **Try again**. If it fails again, open the demo link to see whether the demo is still open.",
    },
    {
      question: "The page sent me to the log-in page. Why?",
      answer: "You weren't signed in when the page tried to claim the receptionist. Sign in, or select **Create one** to make a new account, and the app brings you back to finish the claim.",
    },
    {
      question: "The page stays on Setting up your workspace. What's happening?",
      answer: "The demo is still being prepared, and the page claims it as soon as it's ready. Leave the page open. If nothing changes after a while, ask the person who sent the link whether the demo is ready.",
    },
    {
      question: "I already use the app for another business. Where does the claimed one go?",
      answer: "It's added to your account beside your other businesses, and the app switches to it and opens its setup. Your other businesses don't change, but the dashboard opens again only once the claimed business's setup is done. After that, use the business menu at the top of the sidebar to move between them.",
    },
  ],
  related: ["prospect-demo", "sign-up", "log-in", "onboarding-business", "calls", "messages", "team", "plan", "ai-settings", "prospect-demos"],
  keywords: ["claim demo", "claim this receptionist", "keep the demo", "own the receptionist", "turn a demo into an account", "demo to business", "business limit", "setting up your workspace", "demo link unavailable"],
};

export default article;
