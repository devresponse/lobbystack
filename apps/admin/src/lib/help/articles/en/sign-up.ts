import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "sign-up",
  title: "Sign up",
  section: "getting-started",
  summary: "Create your account with your email address and a password, then confirm the address with a 6-digit code the app emails to you.",
  screenPaths: ["/signup", "/verify-email"],
  location: ["Log-in page", "Create one"],
  access: "Anyone can open this page without signing in. If you're already signed in, it takes you to the dashboard instead.",
  purpose: [
    "Signing up creates your own account: the email address and password you sign in with. It is the first step of setting up the app for a business. Once your address is confirmed, the app signs you in and walks you through the setup steps for your business and your AI receptionist.",
    "To make sure the address is yours, the app emails you a 6-digit verification code, and your account is confirmed once you enter it. Use an address you can open right away and plan to keep, because it is how you sign in and where the app sends your codes.",
    "If someone invited you to join their business, start from the link in the invitation email instead. It brings you back to the invitation after you create your account, so you join their team rather than setting up a new business.",
  ],
  areas: [
    { name: "Create your account", description: "The page's title, under the app's logo. Below it are the **Email** and **Password** fields." },
    { name: "Password checklist", description: "Appears under **Password** once you click into it. Each rule, **Minimum 8 letters**, **At least one number** and **At least one special character**, shows a cross until your password meets it and a tick once it does." },
    { name: "Create account", description: "Creates the account and emails you a verification code. The button stays off until the email address looks complete and all three password rules show a tick. It reads **Creating account...** while it works, and any problem shows just above it." },
    { name: "Security check", description: "A check below the form that confirms a person is signing up. It must be complete before the account is created. If you select **Create account** first, the page asks you to complete it and carries on by itself once it's done." },
    { name: "Already have an account? Sign in", description: "Opens the log-in page, for an account you already have." },
    { name: "Progress dots", description: "The eight dots near the bottom show where you are in setup. Creating your account is the first step." },
    { name: "Terms of Service and Privacy Policy", description: "The line at the bottom says that by selecting **Create account** you agree to them. Each link opens the document in a new tab." },
    { name: "Verify your email", description: "Replaces the form after you select **Create account**. It names the address the code was sent to, with the **Verification code** boxes, **Verify email**, **Send a new code** and **Use a different email**. The buttons read **Verifying...** and **Sending a new code...** while they work, and any problem shows under the code boxes." },
    { name: "Already registered? Sign in or reset your password", description: "Below **Send a new code**, in case the address already had an account. **Sign in** opens the log-in page, and **reset your password** opens the page for choosing a new password." },
    { name: "Invalid verification link", description: "A page that opens from an email verification link that is missing its secure token. **Return to sign in** opens the log-in page." },
  ],
  fields: [
    {
      title: "Create your account",
      fields: [
        { name: "Email", requirement: "required", description: "The address you'll sign in with, where the app sends your verification code. Enter a complete address, such as `you@example.com`. If what you typed doesn't look like one, the field shows **Provided email address is invalid.** when you move on." },
        { name: "Password", requirement: "required", description: "The password for your account: 8 to 128 characters, with at least one number and one special character, such as `!`, `#` or `?`. **Minimum 8 letters** counts every character, not only letters, and a space doesn't count as a special character." },
      ],
    },
    {
      title: "Verify your email",
      description: "Shown after you select **Create account**.",
      fields: [
        { name: "Verification code", requirement: "required", description: "The 6-digit code from the email the app just sent you. You can type it or paste it, and only digits are kept. **Verify email** turns on once all six digits are in." },
      ],
    },
  ],
  tasks: [
    {
      title: "Create an account",
      steps: [
        "On the log-in page, select **Create one**, or open the sign-up link you were given.",
        "Enter your **Email**.",
        "Enter a **Password**, and check that every line of the checklist under it shows a tick.",
        "Complete the security check below the form.",
        "Select **Create account**.",
        "Open the email from the app and enter the 6-digit code in **Verification code**.",
        "Select **Verify email**. The app signs you in and opens the first setup step.",
      ],
    },
    {
      title: "Get a new verification code",
      steps: [
        "On the **Verify your email** screen, select **Send a new code**.",
        "If a security check appears above **Send a new code**, complete it and select **Send a new code** again.",
        "When the page says **A new verification code is on its way.**, enter the code from the newest email.",
      ],
    },
    {
      title: "Correct a mistyped email address",
      steps: [
        "On the **Verify your email** screen, select **Use a different email**.",
        "Fix the address in **Email**. Your password is still filled in.",
        "Complete the security check again, then select **Create account**.",
      ],
    },
  ],
  notes: [
    "The verification code works for 10 minutes. After three wrong tries it stops working, and you need a new one.",
    "Each new code replaces the one before. Only the code in the newest email works, and entering an older one counts as a wrong try.",
    "The app sends at most one code a minute to the same address, and at most three in the same hour, counting the one sent when you created the account.",
    "If the address already has an account, the app doesn't create a second one, and the screen still asks for a code. The app emails you instead: a new code if the address was never confirmed, or a message with links to sign in or choose a new password if it was.",
    "Your account takes the language the sign-up page is shown in, and the app writes its emails to you in that language. You can change it later with **Dashboard language** on the **Preferences** screen.",
    "If you opened the sign-up page from a link with a promo code, the app keeps the code in this browser. When you reach the plan step, it fills the code in and checks it for you, where the step offers **Have a promo code?**.",
    "A promo link works for an account you already have, too. If you're signed in when you open it, the app opens the **Plan** screen. If you're signed out, select **Sign in**, then open the **Plan** screen in the same browser. Either way, the code is filled in there, where the screen offers **Have a promo code?**.",
    "If you opened the sign-up page from a referral link, the app remembers the referral in this browser and credits it when you create your business, so finish setup in the same browser.",
    "The app confirms your address with a code, not a link. If you open an email verification link, it takes you back into the app, on the log-in page if you're signed out: sign in, and enter a code if the app asks for one.",
  ],
  troubleshooting: [
    {
      question: "Why can't I select Create account?",
      answer: "The button turns on only when **Email** holds a complete address and all three password rules show a tick. Add a number or a special character until every line of the checklist is ticked.",
    },
    {
      question: "The page says to complete the security check. What do I do?",
      answer: "Finish the security check below the form. If you had already selected **Create account**, the page goes on by itself once the check is done. If it says **We couldn't verify the security check. Please try again.**, reload the page and try again. If it keeps failing, try another browser or turn off extensions that block parts of web pages.",
    },
    {
      question: "The verification code never arrived. What can I check?",
      answer: "Look in your spam or junk folder, and check that the address under **Verify your email** is right. If it isn't, select **Use a different email**. Otherwise wait a minute and select **Send a new code**. If the address already had an account, you get an email about that account instead of a code: select **Sign in** or **reset your password** on the same screen.",
    },
    {
      question: "Why does it say That verification code is invalid?",
      answer: "The code you entered doesn't match the newest one the app sent. Check the six digits and try again, or paste the code from the email. Each wrong try counts toward the three a code allows, so if you're unsure, select **Send a new code**. After several tries in a minute, the app also turns codes down for a moment, so wait a minute before trying again.",
    },
    {
      question: "Why does it say the code has expired, or that there were too many incorrect attempts?",
      answer: "A code works for 10 minutes and allows three wrong tries. Select **Send a new code** and enter the code from the newest email.",
    },
    {
      question: "Why does it say Please wait before requesting another verification code?",
      answer: "The app sends at most one code a minute to the same address, and at most three in the same hour. Wait a minute and try again. If three codes have already gone out this hour, use the newest one you have, or try again later.",
    },
    {
      question: "Why does it say We couldn't send a verification code right now?",
      answer: "The app couldn't send a new code at that moment. Wait a minute and select **Send a new code** again. Meanwhile, you can still enter the last code you received if it's less than 10 minutes old.",
    },
    {
      question: "I closed the page before entering the code. How do I finish signing up?",
      answer: "Your account already exists, so sign in instead of signing up again. Open the log-in page and sign in with the email address and password you chose. If the app asks for a code, it emails you one: enter it to finish. If you don't remember the password, select **Forgot password?** on the log-in page.",
    },
    {
      question: "Why does it say We couldn't create your account?",
      answer: "Wait a minute and try again, completing the security check again. The app accepts only a few sign-up attempts a minute from one network, and each attempt needs a fresh security check. An email address the app can't accept, or a password longer than 128 characters, is turned down with the same message, so check both.",
    },
    {
      question: "After I entered the code, the log-in page opened. Why?",
      answer: "The page says **Your email is verified. Sign in to continue.** when your address is confirmed but the app couldn't sign you in, for example because the address already had an account with a different password. The log-in page fills in your address: sign in with that account's password, or select **Forgot password?** to choose a new one.",
    },
    {
      question: "I was invited to join a team but signed up on this page. What now?",
      answer: "Open the link in the invitation email while you're signed in and select **Accept invitation**, rather than setting up a business of your own. This works if you signed up with the address the invitation was sent to. If you used another address, ask whoever invited you to invite that one instead.",
    },
  ],
  related: ["onboarding-business", "log-in", "accept-invitation", "reset-password", "onboarding-plan", "plan", "preferences"],
  keywords: ["register", "registration", "create account", "new account", "get started", "verification code", "verify email", "confirm email address", "new code", "password requirements", "security check", "sign up code", "promo link"],
};

export default article;
