import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "accept-invitation",
  title: "Accept an invitation",
  section: "getting-started",
  summary: "Join a business's team, or take over a business handed to you, from the link in an invitation email, signed in with the email address it was sent to.",
  screenPaths: ["/accept-invite"],
  location: ["Invitation email", "Accept invitation"],
  access: "Anyone with the link can open this page. Only the person the invitation was sent to can accept it, signed in with that email address once it's confirmed.",
  purpose: [
    "When an owner or admin of a business invites you on the **Team** screen, you get an email that says who invited you, to which business and with which role, with an **Accept invitation** button. It opens this page, which names the business and the email address the invitation was sent to.",
    "To accept, you need an account with exactly that address, confirmed with a code. If you don't have one yet, create it from this page, and the app brings you back here afterwards. When you accept, you join the team with the role chosen for you, a message confirms that you're now a member, and the dashboard opens on the **Team** screen.",
    "Some invitations hand a whole business over to you, for example when a partner set up the app for your business. That email asks you to take over the business. When you accept, you become its owner and the person who sent it leaves the team.",
  ],
  areas: [
    { name: "Join your team", description: "The page's title. The line under it shows what the link holds: **Loading invitation details...** while it checks, then the business's name and the address the invitation was sent to, or a message that the invitation is invalid or has expired." },
    { name: "Sign in to accept", description: "Shown when you're signed out. Opens the log-in page, which brings you back here once you're signed in." },
    { name: "Create account to accept", description: "Shown when you're signed out. Opens the sign-up page, which brings you back here once your new account is confirmed." },
    { name: "Accept invitation", description: "Shown when you're signed in. Joins the team. The button stays off while the invitation loads, and when it has expired or can no longer be used. It reads **Accepting invitation...** while it works, and any problem shows above it." },
    { name: "Sign in with another account", description: "Replaces **Accept invitation** when you try to accept while signed in with an address other than the invited one, or with one that isn't confirmed yet. It signs you out and opens the log-in page, which brings you back here." },
    { name: "Back to sign in and Back to team settings", description: "The link under the buttons: **Back to sign in** when you're signed out, and **Back to team settings** when you're signed in." },
    { name: "Terms and Privacy", description: "Links at the bottom of the page that open the terms and the privacy policy in a new tab." },
  ],
  tasks: [
    {
      title: "Accept with a new account",
      steps: [
        "In the invitation email, select **Accept invitation**.",
        "Select **Create account to accept**.",
        "Enter the address the invitation was sent to in **Email**, choose a **Password**, complete the security check and select **Create account**.",
        "Enter the 6-digit code from your email and select **Verify email**. The invitation page opens again.",
        "Select **Accept invitation**.",
      ],
    },
    {
      title: "Accept with an account you already have",
      steps: [
        "In the invitation email, select **Accept invitation**.",
        "Select **Sign in to accept** and sign in with the address the invitation was sent to.",
        "Back on the invitation page, select **Accept invitation**.",
      ],
    },
    {
      title: "Accept when you're signed in with another account",
      steps: [
        "Select **Accept invitation**. The page says which address the invitation is for.",
        "Select **Sign in with another account**.",
        "Sign in with the invited address, then select **Accept invitation**.",
      ],
    },
    {
      title: "Take over a business handed to you",
      steps: [
        "Open the email that asks you to take over the business and select **Accept invitation**.",
        "Sign in, or create an account, with the address the email was sent to.",
        "Select **Accept invitation**. You become the business's owner, and the dashboard opens on its **Team** screen.",
        "If a message says **Some connections are off**, select **Open Integrations** to review them.",
      ],
    },
  ],
  notes: [
    "An invitation works for 7 days. After that, or once it's canceled on the **Team** screen, the link stops working, and an owner or admin needs to invite you again.",
    "Each link works once. After you accept, opening it again says the invitation is invalid or has expired.",
    "The invitation belongs to the address it was sent to. Someone else who opens a forwarded link can't join with it.",
    "If you're already on the team, accepting an invitation keeps the role you have. Taking over a business makes you its owner either way.",
    "One account can belong to several businesses. If you already used the app for another business, the dashboard stays on that business after you accept: choose the one you joined from the business menu at the top of the sidebar.",
    "When you take over a business, the person who sent the link leaves the team and loses access, and their API keys and the invitations they sent stop working. Webhooks that they or a partner set up are turned off, and calendars they connected are disconnected. If any were, a message tells you how many, with **Open Integrations** to turn the webhooks back on or connect your own calendar.",
    "Taking over a business counts toward the number of businesses one account can own. If yours is at its limit, the page says so instead of accepting.",
  ],
  troubleshooting: [
    {
      question: "Why does it say This invitation has expired?",
      answer: "Invitations work for 7 days. Ask an owner or admin of the business to invite you again from the **Team** screen, then use the link in the new email.",
    },
    {
      question: "Why does it say This invitation link is invalid or has expired?",
      answer: "The link was already used, the invitation was canceled, the person who sent it was removed from the team, the business was closed or deleted, or part of the link's address is missing. Open the link from the newest invitation email, or ask for a new invitation.",
    },
    {
      question: "It says the invitation is for another address. What do I do?",
      answer: "You're signed in with a different account, or the invited address hasn't been confirmed yet. Select **Sign in with another account** and sign in with the address the invitation was sent to, entering the code the app emails you if it asks for one. If the message comes back, reset your password from the log-in page with that address, since entering the reset code also confirms the address. Then open the invitation link again.",
    },
    {
      question: "An account was made for me, but signing in says Incorrect email or password. What do I do?",
      answer: "An account made for you has no password until you choose one. On the log-in page, select **Forgot password?**, ask for a code at the address the invitation was sent to and choose your password. The app then opens the dashboard, so open the invitation link again and select **Accept invitation**.",
    },
    {
      question: "Why does it say We couldn't accept this invitation?",
      answer: "The invitation may have been canceled while the page was open, or you may have been signed out. A link that hands over a business also stops working once its sender is no longer an owner, or once a newer handover link is sent. Reload the page and try again, and if it still fails, ask whoever invited you for a new invitation.",
    },
    {
      question: "Why does it say my account already owns the most businesses it can?",
      answer: "Taking over a business makes you its owner, and your account already owns as many businesses as it may. Delete one of your businesses, or, when the message suggests it, upgrade one of them to a higher plan. Then accept the invitation again.",
    },
    {
      question: "I accepted, but the dashboard shows my other business. Where is the one I joined?",
      answer: "The dashboard stays on the business you were using. Open the business menu at the top of the sidebar and choose the business you joined.",
    },
    {
      question: "Can I accept with a different email address?",
      answer: "No. The invitation only works for the address it was sent to. Ask an owner or admin to cancel it on the **Team** screen and invite the address you want to use.",
    },
  ],
  related: ["team", "sign-up", "log-in", "reset-password", "integrations", "webhooks"],
  keywords: ["join a team", "team invitation", "invitation email", "invite link", "accept invite", "join a business", "join workspace", "take over a business", "hand over a business", "become owner", "invitation expired"],
};

export default article;
