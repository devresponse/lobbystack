import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "log-in",
  title: "Log in",
  section: "getting-started",
  summary: "Sign in to the dashboard with your account's email address and password.",
  screenPaths: ["/login"],
  location: ["Open the app while signed out"],
  access: "Anyone can open this page. If you're already signed in, it takes you straight to the dashboard.",
  purpose: [
    "The log-in page is the way into the dashboard. Each person who works in the app signs in with their own account: an email address and a password. To give someone access to a business, an owner or admin invites them on the **Team** screen.",
    "When you open the app while signed out, it sends you here. After you sign in, the dashboard opens on **Home**, or on the setup step where you left off if your business hasn't finished setup.",
    "If your email address hasn't been confirmed yet, the app may ask for a 6-digit code it emails you before it lets you in. It asks only once your password is right.",
  ],
  areas: [
    { name: "Welcome back", description: "The page's title, under the app's logo. Below it are the **Email** and **Password** fields." },
    { name: "Forgot password?", description: "The link beside the **Password** label. It opens the page where you get a reset code by email and choose a new password." },
    { name: "Sign in", description: "Checks your email address and password and signs you in. It reads **Signing in...** while it works, and any problem shows just above it." },
    { name: "Don't have an account? Create one", description: "Opens the sign-up page, to create a new account." },
    { name: "Terms and Privacy", description: "Links at the bottom of the page that open the terms and the privacy policy in a new tab." },
    { name: "Verify your email", description: "Replaces the form when your address still needs confirming. It names the address the code was sent to, with the **Verification code** boxes, **Verify email**, **Send a new code** and **Use a different email**, which takes you back to the form. The buttons read **Verifying...** and **Sending a new code...** while they work, and any problem shows under the code boxes." },
  ],
  fields: [
    {
      title: "Welcome back",
      fields: [
        { name: "Email", requirement: "required", description: "The address of your account. Capital letters don't matter. If what you typed isn't a complete address, the field shows **Provided email address is invalid.** when you move on." },
        { name: "Password", requirement: "required", description: "Your account's password, exactly as you set it. Capital letters matter here." },
      ],
    },
    {
      title: "Verify your email",
      description: "Shown only when the app asks you to confirm your address after you select **Sign in**.",
      fields: [
        { name: "Verification code", requirement: "required", description: "The 6-digit code from the email the app sent when you selected **Sign in**. You can type it or paste it, and only digits are kept. It works for 10 minutes, and three wrong tries use it up. **Verify email** turns on once all six digits are in." },
      ],
    },
  ],
  tasks: [
    {
      title: "Sign in",
      steps: [
        "Open the app's address in your browser.",
        "Enter your **Email** and **Password**.",
        "Select **Sign in**. The dashboard opens, or the setup step where you left off.",
      ],
    },
    {
      title: "Sign in with a verification code",
      steps: [
        "Enter your **Email** and **Password** and select **Sign in** as usual.",
        "If **Verify your email** appears, open the email the app just sent you.",
        "Enter the 6-digit code in **Verification code** and select **Verify email**. The app signs you in.",
        "If the code doesn't arrive, select **Send a new code**. If a security check appears above that button, complete it and select **Send a new code** again.",
      ],
    },
    {
      title: "Get back in when you've forgotten your password",
      steps: [
        "Select **Forgot password?** beside the **Password** label.",
        "Follow the steps to get a reset code and choose a new password. The app signs you in when you're done.",
      ],
    },
    {
      title: "Sign in with a different account",
      steps: [
        "Select **Sign out**. In the dashboard it's in the menu with your email address at the bottom of the sidebar, and during setup it's at the top right of each step.",
        "On the log-in page, sign in with the other account's email address and password.",
      ],
    },
  ],
  notes: [
    "You stay signed in on the same browser until you sign out, or until 30 days pass without you using the app.",
    "Changing your password on the **Account** screen, or resetting it, signs you out on your other devices and browsers.",
    "When another page sends you here to sign in first, such as an invitation, signing in takes you back to that page so you can carry on. **Create one** keeps that page too, so a new account comes back to it once it's confirmed.",
    "If you belong to more than one business, the dashboard opens on the one you used last. Switch businesses with the business menu at the top of the sidebar.",
    "After several sign-in tries in a minute, the app stops checking for a moment and answers **Incorrect email or password. Please try again.** even when both are right. Wait a minute before trying again.",
    "To change the email address or password you sign in with, use the **Account** screen once you're signed in.",
  ],
  troubleshooting: [
    {
      question: "Why does it say Incorrect email or password?",
      answer: "The app couldn't match the address and password. Check the address for typos and make sure Caps Lock is off, then try again. If you've forgotten the password, select **Forgot password?** to choose a new one. If an account was made for you and you haven't chosen a password yet, use **Forgot password?** too: it sets your first password. If you've never created an account, select **Create one**, or ask an owner or admin of your business to invite you. After several tries in a minute, wait a minute before trying again.",
    },
    {
      question: "The app asks for a verification code. Where do I find it?",
      answer: "The app emails a 6-digit code to the address you signed in with, so look in your spam or junk folder too. If it hasn't arrived after a minute, select **Send a new code**. If a security check appears, complete it and select **Send a new code** again. A code works for 10 minutes, and only the code in the newest email works.",
    },
    {
      question: "Why does it say the verification code is invalid, has expired or had too many incorrect attempts?",
      answer: "A code works for 10 minutes and allows three wrong tries, and only the code in the newest email works. Check the six digits, or select **Send a new code** and enter the code from the newest email. After several tries in a minute, the app turns codes down for a moment, so wait a minute before trying again. If it says **Please wait before requesting another verification code.**, use the newest code you have: the app sends at most one code a minute, and three an hour, to the same address.",
    },
    {
      question: "What does Your email is verified. Sign in to continue mean?",
      answer: "Your code worked and your address is confirmed, but the app couldn't finish signing you in. Enter your password and select **Sign in**. If you came from the sign-up page and the address already had an account, use that account's password, or select **Forgot password?** to choose a new one.",
    },
    {
      question: "Why do I keep coming back to the log-in page after signing in?",
      answer: "The app uses a cookie to keep you signed in. Allow cookies for the app's address in your browser's settings, or try another browser.",
    },
    {
      question: "Why does a setup step open instead of the dashboard?",
      answer: "Your business hasn't finished setup yet, so the app opens the step where you left off. Once the last step is done, signing in opens **Home**. If the step asks for the name of your business but you meant to join a team you were invited to, open the link in the invitation email and accept it instead. The same step opens when you're no longer on any business's team, for example after you were removed from it: ask an owner or admin to invite you again.",
    },
  ],
  related: ["sign-up", "reset-password", "accept-invitation", "home", "account"],
  keywords: ["sign in", "login", "log on", "welcome back", "can't sign in", "wrong password", "locked out", "access the dashboard", "verification code", "stay signed in", "sign out", "log out"],
};

export default article;
