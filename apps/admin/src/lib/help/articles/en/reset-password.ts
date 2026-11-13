import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "reset-password",
  title: "Reset your password",
  section: "getting-started",
  summary: "Choose a new password when you've forgotten yours, or a first password for an account made for you, with a 6-digit reset code the app emails to your account's address.",
  screenPaths: ["/forgot-password", "/reset-password", "/reset-password/{token}"],
  location: ["Log-in page", "Forgot password?"],
  access: "Anyone can open this page without signing in. A reset code is only sent to the address of an existing account, so only someone who can open that inbox can change the password.",
  purpose: [
    "Use this page when you can't remember your password. The app emails a 6-digit reset code to your account's address, and you enter it here with a new password. Because the code goes only to your inbox, nobody can change your password with your email address alone.",
    "The same page sets your first password when an account was created for you, for example by a partner who set the app up for your business. Enter the address the account was made with, and choose your password with the code you receive.",
    "Once the new password is saved, the app signs you in with it and opens the dashboard. Your account is signed out everywhere else, so anyone still using the old password loses access.",
  ],
  areas: [
    { name: "Reset your password", description: "The first step: enter your **Email** and select **Send reset code**. The button reads **Sending reset code...** while it works." },
    { name: "Enter your reset code", description: "The second step. The line under the title says that if an account exists for your address, a 6-digit code was sent to it. Enter the **Reset code** and a **New password**, then select **Reset password**, which reads **Resetting password...** while it works." },
    { name: "Use a different email", description: "On the second step, takes you back to the first. The code and password you typed are cleared, and the address stays filled in so you can correct it." },
    { name: "Back to sign in", description: "The link under the buttons on each step, back to the log-in page." },
    { name: "Terms and Privacy", description: "Links at the bottom of the page that open the terms and the privacy policy in a new tab." },
    { name: "New password", description: "A page that opens from a password reset link, with a **New password** field and **Reset password**. The app resets passwords with emailed codes, not links, so this page can't change your password. It shows **That reset code is invalid or expired. Try requesting a new one.** as soon as it opens, or once you select **Reset password**. Select **Back to sign in**, then **Forgot password?**, to get a code instead." },
  ],
  fields: [
    {
      title: "Reset your password",
      fields: [
        { name: "Email", requirement: "required", description: "The address you sign in with. To keep accounts private, the page doesn't say whether an account uses it: the code is sent only if one does." },
      ],
    },
    {
      title: "Enter your reset code",
      fields: [
        { name: "Reset code", requirement: "required", description: "The 6-digit code from the email. It works for 10 minutes, and three wrong tries use it up. If you asked for more than one, only the code in the newest email works." },
        { name: "New password", requirement: "required", description: "Your new password: 8 to 128 characters, with at least one number and one special character, such as `!`, `#` or `?`. A space doesn't count as a special character. The page checks it when you select **Reset password**." },
      ],
    },
  ],
  tasks: [
    {
      title: "Reset a forgotten password",
      steps: [
        "On the log-in page, select **Forgot password?**.",
        "Enter your **Email** and select **Send reset code**.",
        "Open the email from the app and find the 6-digit code.",
        "Enter it in **Reset code**, and type your **New password**.",
        "Select **Reset password**. The app signs you in with the new password and opens the dashboard.",
      ],
    },
    {
      title: "Choose a password for an account made for you",
      steps: [
        "Open the email that says your account is ready and select **Choose a password**.",
        "Enter the address the email was sent to and select **Send reset code**.",
        "Enter the code from the next email and the password you want, then select **Reset password**.",
        "If you also got an email asking you to take over a business, open it next and select **Accept invitation**, rather than creating a new business when setup asks for one.",
      ],
    },
    {
      title: "Ask for a code for a different address",
      steps: [
        "On the **Enter your reset code** step, select **Use a different email**.",
        "Correct the address in **Email** and select **Send reset code** again.",
      ],
    },
  ],
  notes: [
    "The reset code works for 10 minutes. After three wrong tries it stops working, and you need a new one.",
    "Each new code replaces the one before. Only the code in the newest email works, and entering an older one counts as a wrong try.",
    "The app sends at most one reset code a minute to the same address, and at most three in the same hour. Asking more often still moves you to the next step, but no new email is sent, so use the newest code you have.",
    "A new password that doesn't meet the rules is turned down before the code is checked, so it doesn't use up a try.",
    "Resetting your password signs your account out on every other device and browser. Sign in again with the new password wherever you use the app.",
    "Resetting your password also confirms your email address, since only someone who can open that inbox receives the code.",
    "After the reset, the app opens the dashboard, not the page you came from. If you were on your way to accept an invitation, open its link again.",
    "To change a password you still know, select **Change** next to **Password** on the **Account** screen instead.",
  ],
  troubleshooting: [
    {
      question: "No reset code arrived. What can I check?",
      answer: "Look in your spam or junk folder. Make sure you entered the address you sign in with, and select **Use a different email** to correct it. A code is only sent when an account uses that address. If you asked more than once, wait a minute and use the newest email.",
    },
    {
      question: "Why does it say the reset code is invalid or expired?",
      answer: "The page says **That reset code is invalid or expired. Try requesting a new one.** when the code was mistyped, comes from an older email, is more than 10 minutes old or has had three wrong tries, or when no account uses the address. Select **Use a different email**, check the address, and select **Send reset code** for a new code.",
    },
    {
      question: "Why does it say to use a password with at least 8 characters, one number and one special character?",
      answer: "Your new password doesn't meet the rules yet, or it's longer than 128 characters. Add what's missing, such as a number or a symbol like `!` or `#`, and select **Reset password** again. This doesn't use up a try of your code.",
    },
    {
      question: "Why does it say We couldn't send a reset code right now?",
      answer: "The app couldn't send the code. Check that the address is complete, wait a minute, and select **Send reset code** again.",
    },
    {
      question: "Why does it say We couldn't reset your password?",
      answer: "Something went wrong while saving the new password. Wait a minute and select **Reset password** again. If it keeps failing, select **Use a different email** and ask for a new code.",
    },
    {
      question: "I reset my password, but the log-in page opened instead of the dashboard. Did it work?",
      answer: "Yes. The password changed, but the app couldn't sign you in right away. Sign in with your new password.",
    },
    {
      question: "Why doesn't a password reset link work?",
      answer: "The app resets passwords with a 6-digit code, not a link, so a page opened from a reset link can't change your password. Select **Back to sign in**, then **Forgot password?**, and ask for a reset code. The **Choose a password** button in the email about an account made for you is different: it opens the page where you ask for a code, so it works.",
    },
  ],
  related: ["log-in", "account", "sign-up", "accept-invitation"],
  keywords: ["forgot password", "forgotten password", "reset password", "password recovery", "reset code", "reset email", "new password", "locked out", "can't sign in", "set a password", "choose a password", "first password"],
};

export default article;
