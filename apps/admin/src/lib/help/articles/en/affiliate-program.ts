import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "affiliate-program",
  title: "Affiliate program",
  section: "account",
  summary: "Share your personal referral link, follow the visits, referred businesses and commissions it brings you, and choose the email address your payouts are sent to.",
  screenPaths: ["/affiliate"],
  location: ["Top bar", "Gift icon at the top right"],
  access: "Everyone who signs in has their own affiliate program, whatever their role in a business. The screen shows only your own link, earnings and payouts.",
  purpose: [
    "The affiliate program pays you a commission when businesses you refer pay for the app. Your referral link is made the first time you open this screen, from your name or your email address. It belongs to you as a person, not to the business you're working in.",
    "When someone follows your link to the sign-up page, the visit is counted. If they then sign up and create a business in the same browser, that business is credited to you, and the payments it makes during the commission period earn you a commission.",
    "Each commission waits through a holding period, in case the payment is refunded, and then becomes eligible. Eligible commissions are paid out monthly to the payout email you save on the **Settings** tab, once they add up to the minimum payout. **Rewards** shows the rate, the commission period, the minimum payout and the holding period, and **View Terms of Service** opens the full terms.",
  ],
  areas: [
    { name: "Referral link", description: "Your personal link to the sign-up page, in a box you can't edit. **Copy link** copies it, and **Referral link copied.** confirms it. Share it in posts, newsletters, on your website or in a message." },
    { name: "Rewards", description: "The terms in brief: what you earn on each sale and for how long, the minimum payout and the holding period. **View Terms of Service** opens the full terms in a new tab." },
    { name: "Clicks, Referrals and Conversions", description: "**Clicks** counts visits through your link, with repeat visits from the same browser within 24 hours counted once. **Referrals** counts the businesses credited to you. **Conversions** counts the payments that earned you a commission, less any whose commission was voided before it was paid." },
    { name: "Pending, Eligible and Paid", description: "**Pending** is commission still in its holding period. **Eligible** is commission past the holding period that hasn't been paid yet, and it says **Ready for the next payout run.** once it reaches the minimum payout. **Paid** is everything paid out to you so far." },
    { name: "Quickstart", description: "The first tab, open when the screen loads, with three cards. **Share your link** says where to use it, **Use accurate claims** asks you to describe the app honestly and say that you may earn a commission, and **Receive earnings** says how eligible earnings are paid." },
    { name: "Earnings", description: "Your latest 50 commissions, newest first, with the **Date** of the payment, the **Sale** amount, your **Commission**, the day it **Clears** the holding period and its **Status**: **Pending**, **Paid** or **Voided**. It says **No commissions yet.** until your first one." },
    { name: "Payouts", description: "Your latest 20 payouts, newest first, with their **Date**, **Amount**, a column with your payout email, **Status** and **Reference**. Until a payout is paid, **Date** shows the month it covers. The payout email column shows the address saved on the **Settings** tab now, on every row, which may not be the one an earlier payout was prepared for. **Status** is **Ready** while a payout waits to be paid, **Draft** when a refund brought it below the minimum payout, and **Paid** once it's sent. **Reference** shows the payment's reference, or **Not paid yet**. The tab says **No payout records yet.** until your first payout." },
    { name: "FAQ", description: "Answers to when commissions become payable, what the minimum payout is, how payouts are sent and what happens after a refund." },
    { name: "Settings", description: "The email address your payouts are sent to, or a line saying that none is saved yet. The setting is named after the service that sends payouts. **Change** opens a dialog to set it." },
  ],
  fields: [
    {
      title: "Settings",
      description: "The **Settings** tab, and the dialog that opens from **Change** on it.",
      fields: [
        { name: "Email address used for payouts", requirement: "required", description: "The email address of the account your affiliate payouts are sent to. It can be different from the address you sign in with. On the screen, the field and the dialog are named after the service that sends payouts. Enter one complete address, such as `you@example.com`, and select **Save**. A message confirms that it was saved, and the address shows on the tab." },
      ],
    },
  ],
  tasks: [
    {
      title: "Share your referral link",
      steps: [
        "Select the gift icon at the top right of the screen.",
        "Under **Referral link**, select **Copy link**.",
        "Paste the link wherever you recommend the app, and say that you may earn a commission.",
      ],
    },
    {
      title: "Set the email address for your payouts",
      steps: [
        "Open the **Settings** tab.",
        "Select **Change**.",
        "Enter the email address of the account that should receive your payouts.",
        "Select **Save**. The new address shows on the tab.",
      ],
    },
    {
      title: "Check when a commission will be paid",
      steps: [
        "Open the **Earnings** tab and find the commission.",
        "Look at **Clears**, the day its holding period ends. From that day it counts toward **Eligible**.",
        "Once **Eligible** reaches the minimum payout and a payout email is saved, the commission goes into a payout, which shows on the **Payouts** tab as **Ready** until it's paid.",
      ],
    },
  ],
  notes: [
    "The program is yours personally: your link, earnings and payout email are the same whichever business you have open.",
    "A business is credited to you only when the person follows your link and then signs up and creates the business in the same browser. Each business can be credited to one affiliate only.",
    "Businesses you create yourself don't earn you a commission, even when you sign up through your own link.",
    "Commissions come from the payments a referred business makes during the commission period, which starts when the business is credited to you.",
    "If a payment is refunded or disputed before its commission is paid, the commission is reduced, or marked **Voided** when nothing is left of the payment.",
    "Payouts leave out anyone without a saved payout email, so save yours before your first commission becomes eligible.",
    "A payout is prepared soon after your eligible commissions reach the minimum payout, and it keeps the email address saved at that moment. A later change on the **Settings** tab applies only to the payouts prepared after it.",
    "The gift icon shows on larger screens only. On a phone, replace everything after the dashboard's address in the browser's address bar with `/affiliate`.",
  ],
  troubleshooting: [
    {
      question: "Someone signed up through my link, but Referrals didn't go up. Why?",
      answer: "A referral counts once the person has created their business, in the same browser where they opened your link. A business you create yourself, or one already credited to someone else, doesn't count. Tracking also doesn't work in a browser that blocks sites from saving data, as some private windows do.",
    },
    {
      question: "Why hasn't my Eligible amount been paid?",
      answer: "Eligible commissions are paid in the monthly payout once they reach the minimum payout shown under **Rewards**, and only when a payout email is saved on the **Settings** tab. Until then, they keep adding up.",
    },
    {
      question: "My payout email won't save. Why?",
      answer: "The field takes one complete email address, such as `you@example.com`, with no spaces, and it can't be saved empty. Your browser may point out a problem before anything is sent. When the app refuses the address, the dialog says in red that the email couldn't be saved. Correct the address and select **Save** again.",
    },
    {
      question: "Why does a commission show Voided?",
      answer: "The payment it came from was refunded, cancelled or disputed before the commission was paid, so it no longer counts.",
    },
    {
      question: "It says Could not prepare your affiliate dashboard. What can I do?",
      answer: "The app couldn't load your affiliate details. Reload the page, and if the message stays, try again later.",
    },
    {
      question: "I can't find the gift icon. Where is it?",
      answer: "On larger screens, it's at the top right of every screen, between **Test Call** and the **Feedback** icon, and its label reads **Affiliate Program**. A phone doesn't show it: in the browser's address bar, replace everything after the dashboard's address with `/affiliate` instead.",
    },
  ],
  related: ["sign-up", "onboarding-business", "onboarding-attribution", "account"],
  keywords: ["affiliate", "referral", "referral link", "refer a business", "commission", "earnings", "payout", "partner program", "rewards", "referral code"],
};

export default article;
