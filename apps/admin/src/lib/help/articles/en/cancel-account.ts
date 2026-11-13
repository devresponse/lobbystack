import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "cancel-account",
  title: "Cancel your account",
  section: "account",
  summary: "Confirm canceling your business from the link emailed after you request it with Cancel account on the Team tab, signed in as the owner who asked and with your password.",
  screenPaths: ["/cancel-account"],
  location: ["Settings", "Team", "Cancel account", "Cancellation email", "Confirm the cancellation"],
  access: "Anyone with the link can open this page and see which business it's for and the address the link was sent to. Only the owner who asked can cancel, signed in with that account and its password, and only while they're still an owner and it's the only business they own.",
  purpose: [
    "Canceling closes your business and stops the service, without deleting anything. An owner asks for it with **Cancel account** on the **Team** tab of **Settings**, and the app emails them a link to this page. Asking changes nothing: the business is only canceled when that owner confirms here.",
    "**Cancel account** shows on the **Team** tab only to an owner, and only when the business is the only one they own, which makes it the first business on their account. An owner who owns other businesses sees **Delete business** there instead, and has to delete the other businesses before this one can be canceled.",
    "Once you confirm, nobody on the team can open the business, and its receptionist stops answering, each receptionist when the business has several AI agents. Its phone numbers stop taking calls and texts, and go back to the provider after 30 days. Its website chat, public page, QR codes, API keys and connected apps stop working, and a paid plan is canceled. Nothing is deleted.",
    "Your own account stays. You can still sign in, and you can start again with a new business.",
  ],
  areas: [
    { name: "Cancel your account", description: "The page's title. The line under it reads **Checking your link...** while the page checks the link, then says what to do next, or why the link no longer works." },
    { name: "When the link can't be used", description: "Instead of a form, the line under the title says why: **This cancellation link isn't valid.** when the link is incomplete or wasn't sent by the app, **This link has expired.** once its 24 hours are over, **A newer cancellation link was sent.** when someone asked again, or that the business is already canceled. Nothing can be canceled with such a link." },
    { name: "Sign in to continue", description: "Shown when you're signed out and the link can still be used. The line above it names the business and the address to sign in as. The button opens the log-in page, which brings you back here once you're signed in." },
    { name: "What canceling does", description: "A red box above the password, shown when you're signed in and the link can still be used: nobody on the team will be able to open the business, its receptionist stops answering calls, its phone numbers stop taking calls and texts and go back to the provider after 30 days, and a paid plan is canceled. It also says that nothing is deleted." },
    { name: "Cancel account", description: "Cancels the business once you've entered **Your password**. The button stays off until you type a password, and reads **Canceling...** while it works. If something stops it, the reason shows in red above the button." },
    { name: "Sign in with another account", description: "Replaces the password form when you enter your password and select **Cancel account** while signed in with an account other than the owner who asked. The line above it names the address the link was sent to. The button signs you out and opens the log-in page, which brings you back here." },
    { name: "Keep my account, Go to the dashboard and Back to sign in", description: "The link at the bottom of the page. **Keep my account** leaves without canceling and opens the dashboard. **Go to the dashboard** shows instead when the link can no longer be used. **Back to sign in** shows when you're signed out and opens the log-in page." },
    { name: "Your account is canceled", description: "The page you see once the business is canceled. It says the business is closed and nothing was deleted, and offers **Start a new business**." },
    { name: "Terms and Privacy", description: "Links at the bottom of the page that open the terms and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "Cancel your account",
      description: "The form shown when you're signed in and the link can still be used.",
      fields: [
        { name: "Your password", requirement: "required", description: "The password of the account you're signed in with, which must be the owner who asked. If it's wrong, the page says **That password isn't right.** and clears the field so you can type it again." },
      ],
    },
  ],
  tasks: [
    {
      title: "Cancel your account",
      steps: [
        "Open the business you own from the business menu at the top of the sidebar, then open **Settings** and select the **Team** tab.",
        "Select **Cancel account**, type the business's name exactly as shown and select **Request cancellation**. The dialog says **Check your email** and names the address the link went to.",
        "Open the email that asks you to confirm canceling the business and select **Confirm the cancellation** within 24 hours.",
        "If the page asks, select **Sign in to continue** and sign in as the owner who asked.",
        "Read what canceling does, enter **Your password** and select **Cancel account**. The page then says **Your account is canceled**.",
      ],
    },
    {
      title: "Start again after canceling",
      steps: [
        "On **Your account is canceled**, select **Start a new business**.",
        "Follow the setup steps to create your new business.",
      ],
    },
    {
      title: "Keep your account after asking to cancel",
      steps: [
        "Select **Keep my account** at the bottom of the page, or close the page.",
        "Leave the link unused. Nothing changes, and the link stops working after 24 hours.",
      ],
    },
    {
      title: "Cancel when you're signed in with another account",
      steps: [
        "When the page says the link was sent to another address, select **Sign in with another account**.",
        "Sign in as the owner the link was sent to. The page opens again.",
        "Enter that account's password and select **Cancel account**.",
      ],
    },
  ],
  notes: [
    "The link works for 24 hours. Asking again on the **Team** tab sends a new link, and the earlier one stops working.",
    "Only the owner who asked can use the link. Another owner or anyone else on the team can't cancel with it, even when signed in.",
    "Opening the link changes nothing. The business is only canceled when you enter your password and select **Cancel account**.",
    "Canceling closes the business for the whole team at once, you included. Everyone keeps their own account and any other businesses they belong to. Anyone who had it open moves to another business they belong to, or to the setup steps for a new business if they have none.",
    "Canceling deletes nothing. The business's calls, contacts, appointments and settings aren't erased, but nobody can open them from the dashboard. Content the app clears after a while, such as the text of old messages, is still cleared on the usual schedule.",
    "A paid plan you pay for in the app ends when you cancel. A plan that's billed outside the app isn't ended by canceling, so contact support to end it.",
    "Invitations to the business that haven't been accepted yet stop working too.",
    "The email with the link goes to the address you sign in with, written in your dashboard language, which you choose on the **Preferences** tab of **Settings**.",
    "Canceling can't be undone from the dashboard. If you canceled by mistake, contact support as soon as you can.",
    "You can try to confirm 10 times an hour. After that, the page says **Too many tries. Try again later.** for up to an hour.",
    "**Start a new business** opens the setup steps for a new business. If you're also on the team of another business, the dashboard opens that one instead, and you can start a new business with **Create Business** in the business menu at the top of the sidebar.",
  ],
  troubleshooting: [
    {
      question: "Why does it say the link has expired?",
      answer: "The link works for 24 hours. Ask for a new one: on the **Team** tab of **Settings**, select **Cancel account** again, then use the link in the new email.",
    },
    {
      question: "Why does it say \"A newer cancellation link was sent.\"?",
      answer: "Someone asked to cancel again after this email was sent, and only the newest link works. Open the latest email and use its link.",
    },
    {
      question: "Why does it say \"This cancellation link isn't valid.\"?",
      answer: "The link is missing part of its address, or it isn't a link the app sent. The same line shows when the page couldn't check the link, so reload the page first. Then open the link straight from the email, or ask for a new link on the **Team** tab.",
    },
    {
      question: "It says the business is already canceled. What does that mean?",
      answer: "The business was already canceled, with this link or a newer one. Nothing more needs doing. To use the service again, sign in and start a new business.",
    },
    {
      question: "It says \"That password isn't right.\" but I'm sure it is. Why?",
      answer: "The page checks the password of the account signed in on this browser. If that isn't the owner who asked, sign out from the menu with your email address at the bottom of the sidebar, open the link again and sign in as the owner. If you've forgotten the password, reset it from the log-in page.",
    },
    {
      question: "It says the link was sent to another address. What do I do?",
      answer: "You're signed in with a different account from the owner who asked. Select **Sign in with another account**, sign in with the address the page names, then enter that account's password and select **Cancel account**.",
    },
    {
      question: "Why does it say I own other businesses now?",
      answer: "You can only cancel when this is the only business you own. Delete your other businesses from their **Team** tabs first, then open the link again, or ask for a new one if it has expired. If the **Team** tab says one of them can't be deleted because it's the first business on another owner's account, contact support.",
    },
    {
      question: "Why does it say \"Only an owner of this business can cancel it.\"?",
      answer: "The owner who asked is no longer an owner of the business, for example after handing it over to someone else. A current owner can cancel it from the **Team** tab, if the business is the only one they own.",
    },
    {
      question: "It says a call is in progress, a phone number is being set up or a plan purchase started. What do I do?",
      answer: "The business can't be canceled while something is still under way, and nothing was canceled. Try again when the call ends, in a few minutes for a phone number, or once the plan purchase has expired, while the link still works. If it has run out by then, ask for a new one on the **Team** tab.",
    },
    {
      question: "It says \"Too many tries. Try again later.\" How long do I wait?",
      answer: "Each person can try to confirm 10 times an hour. Wait a while, up to an hour, then try again.",
    },
    {
      question: "Why does it say \"The business couldn't be canceled. Try again.\"?",
      answer: "Something went wrong, and nothing was canceled. Check your connection and select **Cancel account** again. If you were signed out in the meantime, open the link again and sign in.",
    },
    {
      question: "I didn't get the email with the link. What can I do?",
      answer: "The link goes to the sign-in email of the owner who asked, which the **Check your email** dialog names. Look in the spam folder. To get a new link, select **Cancel account** on the **Team** tab again: the new link replaces the old one, and nothing changes until you confirm.",
    },
    {
      question: "I got an email to cancel my business, but I didn't ask for it. What do I do?",
      answer: "Ignore it. Nothing changes unless the cancellation is confirmed with its link, signed in to your account and with your password. Someone signed in to your account asked for it, so change your password with **Change** next to **Password** on the **Account** screen, which also signs your account out on every other device and browser.",
    },
  ],
  related: ["team", "plan", "phone-number", "onboarding-business", "account", "log-in", "reset-password"],
  keywords: ["cancel account", "close account", "cancel business", "close business", "stop service", "cancel subscription", "cancellation link", "cancellation email", "deactivate account", "end service"],
};

export default article;
