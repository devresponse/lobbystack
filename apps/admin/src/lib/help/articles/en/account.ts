import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "account",
  title: "Account",
  section: "account",
  summary: "Change the email address and the password you sign in with, which belong to you rather than to a business, so a change here applies in every business you're part of.",
  screenPaths: ["/settings/account"],
  location: ["Sidebar", "Your email address", "Account"],
  access: "Everyone who signs in can open this screen, whatever their role. It changes only your own sign-in details, never a business's settings or anyone else's account.",
  purpose: [
    "The **Account** screen holds your own sign-in details: the email address and the password you use to log in. Each person on a team has their own, so changing yours doesn't affect anyone else, and the change applies in every business you belong to.",
    "Changing your email address usually takes two confirmations by email, one from your current address and one from the new address. That way nobody can move your account to another address without access to your inbox.",
    "Changing your password signs you out on your other devices and browsers, so it is also the way to lock out anyone who may know your old password.",
    "Details of the business, such as its name and its members, are on the **Team** tab of **Settings**. Your dashboard language is on its **Preferences** tab, and the alerts you receive are on its **Notifications** tab.",
  ],
  areas: [
    { name: "Email", description: "Shows the address you sign in with. **Change** opens the **Change email** dialog. After you ask for a change, a line under it reads **We sent a confirmation link to** followed by the new address, even though the first email usually goes to your current address. That line goes away when you leave or reload the screen. The address shown changes only once the change is confirmed." },
    { name: "Password", description: "Shows dots in place of your password, which the screen never displays. **Change** opens the **Change password** dialog. After a successful change, **Password updated.** shows here." },
    { name: "Error messages", description: "When a change can't be made, the dialog stays open, says why in red under its fields and changes nothing. A dialog closes by itself once its change goes through." },
  ],
  fields: [
    {
      title: "Change email",
      description: "The dialog that opens from **Change** next to **Email**.",
      fields: [
        { name: "New email", requirement: "required", description: "The address you want to sign in with from now on. Enter a complete address that is different from your current one. **Send confirmation link** stays off until you type something." },
      ],
    },
    {
      title: "Change password",
      description: "The dialog that opens from **Change** next to **Password**. **Save** stays off until all three fields are filled in.",
      fields: [
        { name: "Current password", requirement: "required", description: "The password you sign in with now. It proves that the change comes from you." },
        { name: "New password", requirement: "required", description: "Your new password: 8 to 128 characters, with at least one number and one special character, such as `!`, `#` or `?`. A space doesn't count as a special character." },
        { name: "Confirm new password", requirement: "required", description: "The new password again, typed exactly the same. If the two don't match, the dialog says **New passwords do not match.** and nothing is saved." },
      ],
    },
  ],
  tasks: [
    {
      title: "Change the email address you sign in with",
      steps: [
        "Open the menu with your email address at the bottom of the sidebar and select **Account**.",
        "Select **Change** next to **Email**.",
        "Enter the address in **New email** and select **Send confirmation link**. The dialog closes and the screen says a confirmation link was sent.",
        "In your current inbox, open the email headed **Confirm your email change** and select **Approve the change**. The **Account** screen opens, or the log-in page if you're signed out, and an email goes to the new address. If your current address was never confirmed, this email doesn't come and the next one goes straight to the new address.",
        "In the new inbox, open the email headed **Confirm your new email address** and select **Confirm email address**.",
        "On the page that opens, select **Confirm email change**. The page says your sign-in email has been updated.",
        "From now on, sign in with the new address. Your password stays the same.",
      ],
    },
    {
      title: "Change your password",
      steps: [
        "Open the menu with your email address at the bottom of the sidebar and select **Account**.",
        "Select **Change** next to **Password**.",
        "Enter your **Current password**.",
        "Enter the new password in **New password** and again in **Confirm new password**.",
        "Select **Save**. The dialog closes and **Password updated.** shows under **Password**.",
      ],
    },
  ],
  notes: [
    "Each link in the confirmation emails works for 1 hour. Until the change is confirmed from the new address, your account keeps its current address and you go on signing in with it.",
    "If your current address was never confirmed, the app skips the approval email and sends the confirmation link straight to the new address.",
    "Once the change is confirmed, the new address replaces the old one everywhere: you sign in and reset your password with it, your team sees it on the **Team** tab, and the app's alert emails go to it.",
    "The confirmation emails are written in your dashboard language, which you choose on the **Preferences** tab of **Settings**.",
    "If an email asks you to approve a change you didn't ask for, ignore it and your address stays the same. Then change your password here.",
    "Changing your password signs you out on every other device and browser. The browser you changed it in stays signed in.",
  ],
  troubleshooting: [
    {
      question: "I asked to change my email, but nothing arrived at the new address. Why?",
      answer: "Unless your current address was never confirmed, the first email goes to your current address, even though the screen names the new one. Select **Approve the change** in that email within the hour, in a browser that isn't signed in to a different account, and the link to the new address follows. An older approval link, or one opened while another account is signed in, opens the app but sends nothing, so ask for the change again. Check the spam folder of both inboxes too. If nothing arrives at all, check the address you typed. An address another account already signs in with can't be used for yours: the screen still says the link was sent, but no email goes out.",
    },
    {
      question: "The confirmation page says the link is invalid or expired. What do I do?",
      answer: "Each link works for 1 hour and only until the change is done. Ask for the change again with **Change** next to **Email**, and open the new emails within the hour. If you copied the link by hand, make sure you copied all of it. The page also says this while the browser is signed in to a different account, so sign out of that account and open the link again.",
    },
    {
      question: "Why does the dialog say Email is the same?",
      answer: "You entered the address you already sign in with. Enter the new address instead.",
    },
    {
      question: "Why does the dialog show a message ending in Invalid email address?",
      answer: "What you typed in **New email** isn't a complete email address. Check it for typos, such as a missing `@` or a missing ending like `.com`, and try again.",
    },
    {
      question: "Why does the password dialog say Invalid password?",
      answer: "Either the **Current password** isn't right, or the new password doesn't meet the rules: at least 8 characters, with at least one number and one special character. Check both and select **Save** again. A password longer than 128 characters gets **Password too long** instead.",
    },
    {
      question: "I don't remember my current password. How do I change it?",
      answer: "Select **Sign out** in the menu with your email address, then select **Forgot password?** on the log-in page. The app emails you a code to set a new password.",
    },
    {
      question: "It says Too many requests. Please try again later. What now?",
      answer: "The app accepts only a few attempts in quick succession. Wait a few seconds, then try again.",
    },
    {
      question: "The dialog says Unauthorized. What happened?",
      answer: "This browser was signed out while the screen was open, for example because your password was changed on another device. Reload the page, sign in again and make the change once more.",
    },
    {
      question: "Why was I signed out on my other devices?",
      answer: "Changing your password signs you out everywhere except the browser you changed it in. Sign in again with the new password.",
    },
    {
      question: "The screen says Account data is unavailable. What can I do?",
      answer: "The app couldn't load your account details. Reload the page. If you have been signed out, sign in again and reopen **Account**.",
    },
    {
      question: "How do I close or delete my account?",
      answer: "This screen only changes your sign-in email and password. An owner closes a business on the **Team** tab of **Settings**, with **Delete business** or **Cancel account**, and their own sign-in stays either way. To leave a business you don't own, ask one of its owners or admins to remove you on the **Team** tab. If you're an admin, you can also remove yourself there, with **Remove** in the **More options** menu of your own row. There is no confirmation step, and you lose access to the business at once.",
    },
  ],
  related: ["confirm-email-change", "log-in", "reset-password", "preferences", "notifications", "team", "cancel-account"],
  keywords: ["my account", "profile", "user settings", "change email", "change password", "sign-in email", "login email", "update password", "security", "personal details", "sign out other devices", "delete account"],
};

export default article;
