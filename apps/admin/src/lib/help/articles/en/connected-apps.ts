import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "connected-apps",
  title: "Connected apps",
  section: "settings",
  summary: "Review the AI assistants that someone connected to this business, see what each one may do and when it last worked, and disconnect the ones you no longer use or trust.",
  screenPaths: ["/settings/connected-apps"],
  location: ["Sidebar", "Manage", "Settings", "Connected apps"],
  access: "Only owners and admins can see the list and disconnect apps. Everyone else sees a message asking them to contact an owner or admin.",
  purpose: [
    "An AI assistant can work with your business for you, for example to read calls and contacts, book appointments or add knowledge for the receptionist. To allow it, an owner or admin connects the assistant to the app, signs in and approves what the assistant may do.",
    "Each approval shows on this tab as a connected app. It works for this business only, with the access that was approved, until someone disconnects it.",
    "Check this tab from time to time to see which assistants can reach the business, and disconnect any you no longer use.",
  ],
  areas: [
    { name: "Connected apps list", description: "One row for each assistant connected to this business. **App** shows its name, or **Unnamed app**, with its identifier underneath. **Access** shows what it may do. **Connected** shows the date and who connected it. **Last used** shows when it last worked with the business, or **Never**." },
    { name: "Access badges", description: "Each badge in the **Access** column is one kind of access, written as a short code such as `calls:read`. Point at a badge with the mouse to see what it allows in plain words." },
    { name: "Disconnect", description: "The button at the end of each row. It asks you to confirm, then cuts the app off from this business." },
    { name: "Empty list", description: "\"No connected apps yet\" shows when no assistant is connected. To connect one, add the app in the assistant's settings and sign in." },
  ],
  fields: [
    {
      title: "Access",
      description: "What each badge allows. An app only has the badges that were approved when it was connected.",
      fields: [
        { name: "Business details", description: "`business:read` reads business details, hours, services and staff. `business:write` updates business details and hours." },
        { name: "Calls", description: "`calls:read` reads calls, with their summaries and transcripts." },
        { name: "Contacts", description: "`contacts:read` reads contacts. `contacts:write` creates and updates contacts." },
        { name: "Appointments", description: "`appointments:read` reads appointments and open times. `appointments:write` books, cancels and reschedules appointments." },
        { name: "Messages", description: "`messages:read` reads the messages the receptionist took." },
        { name: "Knowledge", description: "`knowledge:read` reads the questions the receptionist couldn't answer. `knowledge:write` adds knowledge entries and FAQs." },
      ],
    },
    {
      title: "Connect the assistant to the app",
      description: "The page that opens in your browser when you connect an assistant, after you sign in. Its title names the assistant. Only owners and admins can approve it, and **Cancel** turns the request down.",
      fields: [
        { name: "Business", description: "The business the assistant may work with. The list shows only the businesses where you are an owner or admin, starts on the one you have open, and is greyed out when there is only one. To use the assistant with another business, connect it again and choose that one." },
        { name: "What the assistant can do", requirement: "required", description: "The label names the assistant. It lists the kinds of access the assistant asked for, all ticked to start with. Clear any you don't want to give. With none ticked, selecting **Allow access** only shows \"Choose at least one permission.\", so at least one must stay ticked." },
      ],
    },
  ],
  tasks: [
    {
      title: "Connect an AI assistant",
      steps: [
        "In the assistant's settings, add the app as a connection.",
        "When the assistant asks, sign in with your dashboard account.",
        "On the page that asks you to connect the assistant, choose the **Business** it may work with.",
        "Clear any access you don't want to give.",
        "Select **Allow access**. The assistant now shows on the **Connected apps** tab of that business.",
      ],
    },
    {
      title: "Disconnect an app",
      steps: [
        "Open **Settings** in the sidebar and select the **Connected apps** tab.",
        "Select **Disconnect** on the app's row.",
        "Confirm with **Disconnect**. A message confirms **App disconnected**, and the app loses access to this business right away.",
      ],
    },
    {
      title: "Change what an app may do",
      steps: [
        "Disconnect the app on this tab.",
        "Connect it again from the assistant, and tick only the access it should have before you select **Allow access**.",
      ],
    },
  ],
  notes: [
    "Only owners and admins can connect an assistant, and only to businesses where they are an owner or admin.",
    "A connected app stops working when the person who connected it leaves the team or is no longer an owner or admin. Its row stays on this tab until someone disconnects it. Someone who is still an owner or admin can connect it again.",
    "After you disconnect an app, it needs to be connected and approved again before it can work with the business.",
    "As the page that asks you to connect warns, continue only if you started the connection from the assistant yourself.",
    "The same page names the account you're signed in as and, when it can, the website that asked for access and the one you go to after **Allow access**. Check them before you allow access.",
    "If the account is canceled from the **Team** tab, connected apps stop working. If the business is deleted, they are removed with it.",
    "API keys are the other way for tools to reach the business. They are made and revoked on the **API keys** tab.",
  ],
  troubleshooting: [
    {
      question: "I see \"Only owners and admins can manage connected apps\". What can I do?",
      answer: "Your role on this business doesn't include connected apps. Ask an owner or admin of the business to review them for you.",
    },
    {
      question: "The list says \"No connected apps yet\". How do I connect one?",
      answer: "Connecting starts in the assistant, not here. Add the app as a connection in the assistant's settings, sign in, choose the business and select **Allow access**.",
    },
    {
      question: "An assistant that used to work has stopped. Why?",
      answer: "Someone may have disconnected it, or the person who connected it is no longer an owner or admin of the business. Check this tab, then connect the assistant again as an owner or admin.",
    },
    {
      question: "When I connect an assistant, the page says \"You can't connect apps yet\". Why?",
      answer: "Only owners and admins of a business can connect apps to it, and you aren't an owner or admin of any business. Ask an owner or admin to connect the app or to make you an admin.",
    },
    {
      question: "When I connect an assistant, the page says \"This link doesn't work\". What do I do?",
      answer: "The connection request is missing or has expired. Start again from the assistant you're connecting.",
    },
    {
      question: "After I select Allow access, it says \"We couldn't finish connecting.\" What do I do?",
      answer: "The assistant wasn't connected. The message names the assistant to start again from: go back to it and connect again.",
    },
    {
      question: "It says \"We couldn't disconnect the app. Try again.\" What do I do?",
      answer: "The app is still connected. Check your connection and select **Disconnect** again.",
    },
  ],
  related: ["oauth-consent", "api-keys", "team", "integrations", "webhooks"],
  keywords: ["AI assistant", "connected apps", "connect assistant", "connector", "MCP", "app access", "permissions", "authorize app", "revoke access", "disconnect app", "third party access"],
};

export default article;
