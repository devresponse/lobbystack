import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "oauth-consent",
  title: "Connect an app",
  section: "account",
  summary: "Approve an outside app, such as an AI assistant or an automation tool, that asks to connect to your account: choose the business it may work with and what it may do.",
  screenPaths: ["/oauth/consent"],
  location: ["Outside app", "Start the connection", "Sign in if asked"],
  access: "You need to be signed in. Only owners and admins can approve a connection, and only for businesses where they have that role. Someone who is an owner or admin of no business sees that they can't connect apps yet.",
  purpose: [
    "An outside app, such as an AI assistant or an automation tool, can work with your business for you: read calls and messages, look up and add contacts, book appointments or add knowledge for the receptionist. You start the connection in that app. It then sends you to this page, through the log-in page if you aren't signed in, so you can decide what it gets.",
    "Here you choose the one business the app may work with and tick what it may do. **Allow access** saves the connection and sends you back to the app. **Cancel** sends you back without connecting anything.",
    "The app keeps the access you allowed, for that business only, until someone disconnects it on the **Connected apps** tab of **Settings**, you're no longer an owner or admin of that business, or the business is canceled or deleted.",
  ],
  areas: [
    { name: "Requested by", description: "A badge at the top with the web address the app identified itself with. It only shows when the app identifies itself by a secure web address. Check that it matches the app you're connecting." },
    { name: "Page title", description: "Names the outside app that's asking to connect, as the app names itself, and the app it wants to connect to. When the outside app gave no name, it says **An app** instead. The line under it says the app wants to work with your AI receptionist and asks you to choose the business and what the app can do." },
    { name: "Business", description: "The business the app may work with. Only businesses where you're an owner or admin are listed." },
    { name: "What the app can do", description: "The permissions the app asked for, among those a connected app can have, under a heading with the app's name. Each shows a plain description with a short code under it, such as `calls:read`. All of them are ticked to start with." },
    { name: "Notice", description: "The box with the shield says the app stays connected until you disconnect it in **Settings > Connected apps**, and to continue only if you started this from that app." },
    { name: "Allow access", description: "Connects the app to the chosen business with the ticked permissions, then sends you back to the app. It reads **Allowing…** while it works, and any problem shows in red above it." },
    { name: "Cancel", description: "Turns the connection down and sends you back to the app. Nothing is connected." },
    { name: "Where you go next", description: "The lines at the bottom. **After you allow access, you'll go to** shows the address where the app receives you, and **Signed in as** shows the email address of the account you're approving with." },
    { name: "You can't connect apps yet", description: "Shows instead of the choices when you aren't an owner or admin of any business. Only **Cancel** is offered." },
    { name: "This link doesn't work", description: "Shows instead of the choices, with no buttons, when the link is missing part of the connection request, or the app that sent it can't be found. Start again from the app you're connecting." },
    { name: "Terms and Privacy", description: "Links at the bottom of the page that open the terms and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "Connect an app",
      fields: [
        { name: "Business", description: "The one business the app may work with. It starts on the business you last had open in the dashboard when you may connect apps to it, and otherwise on the first in the list. When you're an owner or admin of only one business, it's chosen for you and can't be changed." },
        { name: "What the app can do", requirement: "required", description: "Tick the permissions to give, and clear any you don't want the app to have. At least one must stay ticked: with none, **Allow access** shows **Choose at least one permission.** and connects nothing." },
      ],
    },
    {
      title: "Permissions",
      description: "What each permission in the list lets the app do. The list shows only the ones this app asked for.",
      fields: [
        { name: "Read business details, hours, services and staff", description: "Shown as `business:read`. The app can look up the business's details, opening hours, services, staff and receptionists." },
        { name: "Update business details and hours", description: "Shown as `business:write`. The app can replace the business's weekly opening hours. A connected app can't change the business's other details." },
        { name: "Read calls, summaries and transcripts", description: "Shown as `calls:read`. The app can read the calls the receptionist handled, with their summaries and transcripts." },
        { name: "Read contacts", description: "Shown as `contacts:read`. The app can look up your contacts." },
        { name: "Create and update contacts", description: "Shown as `contacts:write`. The app can add contacts and change their details." },
        { name: "Read appointments and open times", description: "Shown as `appointments:read`. The app can see appointments and check which times are open for booking." },
        { name: "Book, cancel and reschedule appointments", description: "Shown as `appointments:write`. The app can book appointments, cancel them and move them to another time." },
        { name: "Read messages the receptionist took", description: "Shown as `messages:read`. The app can read the messages the receptionist took for your team." },
        { name: "Read the questions the receptionist couldn't answer", description: "Shown as `knowledge:read`. The app can see the questions callers and website visitors asked that the receptionist couldn't answer." },
        { name: "Add knowledge entries and FAQs", description: "Shown as `knowledge:write`. The app can add facts and questions with answers for the receptionist to use, including answers to the questions it couldn't answer." },
      ],
    },
  ],
  tasks: [
    {
      title: "Connect an app to your business",
      steps: [
        "Start the connection in the outside app, following its own steps.",
        "If the log-in page opens, sign in with your dashboard account.",
        "On the page that opens, check the app's name in the title, and the **Requested by** address when there is one.",
        "Under **Business**, choose the business the app may work with.",
        "Clear any permission you don't want to give.",
        "Select **Allow access**. You go back to the app, which can now work with that business. The app also shows on the **Connected apps** tab of that business.",
      ],
    },
    {
      title: "Turn down a connection",
      steps: [
        "Select **Cancel**. You go back to the app, and nothing is connected.",
      ],
    },
    {
      title: "Disconnect an app later",
      steps: [
        "Open the business the app works with from the business menu at the top of the sidebar.",
        "Open **Settings** in the sidebar and select the **Connected apps** tab.",
        "Select **Disconnect** on the app's row and confirm with **Disconnect**. The app loses access to the business right away.",
      ],
    },
    {
      title: "Change what an app may do",
      steps: [
        "Disconnect the app on the **Connected apps** tab.",
        "Start the connection again from the app.",
        "On this page, clear the permissions it shouldn't have and select **Allow access**. The list only offers what the app asks for, so it can't be given more.",
      ],
    },
  ],
  notes: [
    "Only owners and admins can approve a connection, and only for businesses where they are an owner or admin.",
    "A connection is for one business. To use the app with another business, connect it again and choose that business.",
    "A connection covers the whole business. When the business has several AI agents, the app can work with every receptionist, within the permissions you allow.",
    "The request from the app works for 10 minutes. If the page has been open longer, your choice can't be saved, and you start again from the app.",
    "This page shows every time the app asks to connect, even if you approved it before.",
    "Connected apps can't be given access to billing, the team, phone numbers or webhooks: those permissions are never offered here.",
    "A connected app stops working when the person who approved it leaves the team or is no longer an owner or admin. Someone who still is can connect it again.",
    "Continue only if you started the connection yourself. If this page opened when you didn't expect it, select **Cancel**.",
    "API keys, made on the **API keys** tab, are the other way for tools to reach the business.",
  ],
  troubleshooting: [
    {
      question: "It says \"You can't connect apps yet\". Why?",
      answer: "Only owners and admins of a business can connect apps to it, and you aren't an owner or admin of any business. Ask an owner or admin to connect the app or to make you an admin, then start again from the app.",
    },
    {
      question: "It says \"This link doesn't work\". What do I do?",
      answer: "The link is missing part of the connection request, or the app that sent it can't be found. Start again from the app you're connecting, rather than opening an old link.",
    },
    {
      question: "It says \"We couldn't finish connecting\". What happened?",
      answer: "The request may have run past its 10 minutes, you may have been signed out, or your role on the business may have changed. The same message can show after **Cancel**. Nothing was connected. Start again from the app.",
    },
    {
      question: "The app asks me to approve it again. Why?",
      answer: "This page opens every time the app asks to connect, even after you approved it before. An app has to ask again when it hasn't worked with the business for 30 days, and some apps can't renew their access on their own, so they ask again after an hour. Check the details and select **Allow access** again.",
    },
    {
      question: "It says \"Choose at least one permission.\" What do I do?",
      answer: "Every permission is cleared. Tick at least one in the list of what the app can do, then select **Allow access**.",
    },
    {
      question: "The business I want isn't in the list. Why?",
      answer: "The list shows only businesses where you're an owner or admin. Ask an owner or admin of that business to connect the app, or to make you an admin.",
    },
    {
      question: "Why can't I change the business?",
      answer: "You're an owner or admin of only one business, so the page chooses it for you.",
    },
    {
      question: "I'm signed in with the wrong account. How do I switch?",
      answer: "Check the address after **Signed in as** at the bottom of the page. Select **Cancel**, sign out from the menu with your email address at the bottom of the dashboard's sidebar, then start again from the app and sign in with the right account.",
    },
    {
      question: "It says I'll go to a localhost address after I allow access. Is that right?",
      answer: "Apps that run on your own computer receive the approval at a `localhost` or `127.0.0.1` address. That's expected when you started the connection from such an app. If you didn't, select **Cancel**.",
    },
  ],
  related: ["connected-apps", "api-keys", "team", "log-in"],
  keywords: ["connect an app", "connect AI assistant", "authorize app", "allow access", "app permissions", "OAuth", "consent screen", "automation tool", "third party app", "grant access", "MCP", "connector"],
};

export default article;
