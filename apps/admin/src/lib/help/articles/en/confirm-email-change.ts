import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "confirm-email-change",
  title: "Confirm your new email",
  section: "account",
  summary: "Finish changing the email address you sign in with, from the link emailed to your new address after you asked for the change on the Account screen.",
  screenPaths: ["/confirm-email-change"],
  location: ["Your email address", "Account", "Change email", "Email to your new address", "Confirm email address"],
  access: "Anyone with the link can open this page, signed in or not. The change only goes through for the account that asked for it, and confirming fails while this browser is signed in to a different account.",
  purpose: [
    "Your sign-in email is the address you log in with. You ask to change it on the **Account** screen, and the change only happens once you confirm it here, from a link sent to the new address. That proves the new address is yours before your account moves to it.",
    "Two emails can take part. When your current address is confirmed, it first gets an email headed **Confirm your email change** with an **Approve the change** button, so the change also needs whoever reads your current inbox. Once you approve, the new address gets an email headed **Confirm your new email address** with a **Confirm email address** button, which opens this page.",
    "Opening the page changes nothing on its own. Select **Confirm email change**, and from then on you sign in with the new address and the same password.",
  ],
  areas: [
    { name: "Confirm your new email", description: "The page's title. The line under it names the new address and asks you to confirm it as the sign-in email for this account. When the link is missing part of its address, the line says the link is invalid or expired instead." },
    { name: "Confirm email change", description: "Makes the new address your sign-in email. It reads **Confirming email change...** while it works. It stays off when the link is incomplete, and once the change is done." },
    { name: "Confirmation message", description: "After you confirm, the page says **Your sign-in email has been updated to** and the new address. If the change can't be made, **This email confirmation link is invalid or expired. Request a new one from Settings.** shows in red instead." },
    { name: "Back to settings and Back to sign in", description: "The link at the bottom of the page, chosen when the page opens. **Back to settings** shows when you're signed in and opens the **Usage** tab of **Settings**. **Back to sign in** shows when you're signed out and opens the log-in page, which takes you straight to the dashboard if confirming signed you in." },
    { name: "Terms and Privacy", description: "Links at the bottom of the page that open the terms and the privacy policy in a new tab." },
  ],
  tasks: [
    {
      title: "Change your sign-in email",
      steps: [
        "Open the menu with your email address at the bottom of the sidebar and select **Account**.",
        "Next to **Email**, select **Change**, enter the **New email** and select **Send confirmation link**.",
        "In your current inbox, open the email headed **Confirm your email change** and select **Approve the change**. If your current address was never confirmed, this email doesn't come, and the next one goes straight to the new address.",
        "In the new inbox, open the email headed **Confirm your new email address** and select **Confirm email address**.",
        "On this page, select **Confirm email change**. The page says your sign-in email has been updated.",
        "Sign in with the new address from now on. Your password stays the same.",
      ],
    },
    {
      title: "Get a new confirmation link",
      steps: [
        "Open the menu with your email address at the bottom of the sidebar and select **Account**.",
        "Select **Change** next to **Email**, enter the new address again and select **Send confirmation link**.",
        "Use the links in the new emails within an hour.",
      ],
    },
    {
      title: "Confirm when another account is signed in",
      steps: [
        "In the dashboard, open the menu with the other account's email address at the bottom of the sidebar and select **Sign out**.",
        "Open the link in the email to your new address again.",
        "Select **Confirm email change**. Confirming also signs you in to your own account.",
      ],
    },
  ],
  notes: [
    "Each emailed link works for 1 hour from when it's sent. The link to the new address is sent once you approve the change, so its hour starts then.",
    "Until you confirm on this page, your account keeps its current address, and you keep signing in with it.",
    "Once your address has changed, the links stop working. Opening this page's link again then says it's invalid or expired.",
    "If you weren't signed in on this browser, confirming also signs you in to the account.",
    "Once the change is done, the new address replaces the old one for your account: the alert emails you get from the app go to it, your team sees it on the **Team** tab, and you enter it to reset your password.",
    "An address that already belongs to another account can't be used. When you ask for such an address, no email is sent to either inbox, even though the **Account** screen says a confirmation link was sent.",
    "The emails are written in your dashboard language, which you choose on the **Preferences** tab of **Settings**.",
    "To change your password rather than your email, select **Change** next to **Password** on the **Account** screen.",
  ],
  troubleshooting: [
    {
      question: "Why does it say \"This email confirmation link is invalid or expired.\"?",
      answer: "The link is more than an hour old, was already used, or was cut short when it was copied. Confirming also fails while this browser is signed in to another account, so sign out of that account and open the link again. Otherwise ask for a new link. The message says to request one from Settings, which means the **Account** screen: open it from the menu with your email address at the bottom of the sidebar and change the email again.",
    },
    {
      question: "Why is the Confirm email change button greyed out?",
      answer: "The link is missing part of its address, so the page can't tell which change to confirm. Open the link straight from the email rather than copying it by hand, or ask for a new one on the **Account** screen. The button also stays off once the page says your sign-in email has been updated, because the change is already done.",
    },
    {
      question: "No email arrived at my new address. What can I check?",
      answer: "The **Account** screen names the new address, but when your current address is confirmed, the first email goes to your current inbox. Approve the change from that email, headed **Confirm your email change**, and the new address gets its link after that. Look in the spam folder of both inboxes. **Approve the change** opens the **Account** screen, or the log-in page if you're signed out, without a message. If that browser was signed in to a different account, or the email was more than an hour old, nothing was sent: ask for the change again. If neither address got anything, the new address may already belong to another account, which can't be used, so choose a different address.",
    },
    {
      question: "I got an email about changing my address, but I didn't ask for it. What do I do?",
      answer: "Ignore it and don't select its button: your address stays the same. If it came to the address you sign in with, someone was signed in to your account to ask for it, so change your password with **Change** next to **Password** on the **Account** screen. That also signs your account out on every other device and browser.",
    },
    {
      question: "Which address do I sign in with now?",
      answer: "Once the page says your sign-in email has been updated, use the new address with your same password. Until then, keep using your current address.",
    },
  ],
  related: ["account", "log-in", "reset-password", "preferences", "notifications"],
  keywords: ["change email", "change email address", "new email address", "sign-in email", "login email", "confirm email change", "email confirmation link", "update email", "verify new email", "approve the change", "email change link expired"],
};

export default article;
