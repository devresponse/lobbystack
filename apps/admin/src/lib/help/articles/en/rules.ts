import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "rules",
  title: "Rules",
  section: "agent",
  summary: "Write standing instructions that tell your AI receptionist what to do in particular situations, such as when to transfer a call or what to ask before booking.",
  screenPaths: ["/agent/rules"],
  location: ["Sidebar", "Agent", "Rules"],
  access: "Everyone on the team can see the rules. Only owners and admins can add, edit, reorder, turn off or delete them.",
  purpose: [
    "Rules are instructions in plain words, written the way you would brief a new member of your front desk. The receptionist follows them on calls and in website chats.",
    "Use rules for how the receptionist should act: when to transfer a caller, what to ask before booking, what to say about topics you don't discuss, or how to handle urgent requests. Facts the receptionist should know, such as prices, policies or directions, belong on the **Knowledge** screen instead.",
    "When the business has several AI agents, they all follow the same rules. The order of the list is the rules' priority: the receptionist reads them from the top, so put the most important ones first.",
  ],
  areas: [
    { name: "Search", description: "Filters the list to rules whose title or text contains what you type." },
    { name: "Add Rule", description: "Opens the form for a new rule. Only owners and admins see this button." },
    { name: "Rules list", description: "Shows each rule's **Title**, a **Preview** of its text, its **Status** and the date it was **Added**, in priority order. **Ready** means the receptionist follows the rule, and **Disabled** means it is turned off. Owners and admins can select a row to edit the rule. An empty list says \"No rules added yet.\" before any rule is added, and \"No matching entries found.\" when nothing matches the search." },
    { name: "More options", description: "The menu at the end of each row, for owners and admins: **Move up**, **Move down**, **Disable** or **Enable**, and **Delete**. **Move up** is greyed out on the first rule, and **Move down** on the last." },
    { name: "Pages", description: "Below the list, choose how many rules show per page and move between pages." },
  ],
  fields: [
    {
      title: "Add Rule and Edit Rule",
      description: "The form that opens from **Add Rule**, or when you select a rule in the list.",
      fields: [
        { name: "Title", requirement: "required", description: "A short name that tells you what the rule is about, such as \"Transfer billing questions\". The receptionist reads it along with the rule, so make it describe the situation. Up to 160 characters." },
        { name: "Content", requirement: "required", description: "What the receptionist should do, in full sentences, such as \"When someone asks about an invoice, take their name and number and tell them the office will call back the same day.\" Up to 10,000 characters." },
      ],
    },
  ],
  tasks: [
    {
      title: "Add a rule",
      steps: [
        "Open **Rules** in the sidebar.",
        "Select **Add Rule**.",
        "Enter a **Title** and, in **Content**, describe what the receptionist should do.",
        "Select **Save**. The rule goes to the bottom of the list, which is its priority.",
      ],
    },
    {
      title: "Edit a rule",
      steps: [
        "Select the rule in the list.",
        "Change the **Title** or **Content**.",
        "Select **Save changes**. The rule keeps its place in the list.",
      ],
    },
    {
      title: "Change a rule's priority",
      steps: [
        "Open **More options** at the end of the rule's row.",
        "Select **Move up** or **Move down**. Repeat until the rule sits where you want it.",
      ],
    },
    {
      title: "Turn a rule off without deleting it",
      steps: [
        "Open **More options** at the end of the rule's row.",
        "Select **Disable**. The status changes to **Disabled** and the receptionist stops following the rule.",
        "To use it again, open the same menu and select **Enable**.",
      ],
    },
    {
      title: "Delete a rule",
      steps: [
        "Open **More options** at the end of the rule's row and select **Delete**.",
        "Confirm with **Delete**. A deleted rule can't be brought back.",
      ],
    },
  ],
  notes: [
    "A new or changed rule reaches the receptionist moments after you save it, for calls that start after that and for the next message in a website chat. A call already in progress keeps the rules it started with.",
    "Write one situation per rule. Short, specific rules are easier for the receptionist to follow and easier for you to reorder or turn off.",
    "The receptionist follows the first 50 rules that are turned on, in list order, and reads up to 4,000 characters of each. Calls, including calls made from a web browser, have less room: they read the rules that fit, from the top, and skip a rule that is too long to fit.",
    "**Move up** and **Move down** work while the list holds up to 100 rules. With more, moving a rule fails, so delete the rules you don't need.",
    "Texts sent to your business number aren't answered by the receptionist, so rules don't apply to them. Your team answers texts on the **Messages** screen.",
    "A rule can't put a website visitor through to a phone line. When a rule says to transfer someone who is chatting on your website, the receptionist offers to take a message so your team can call back, or, where live chat is turned on for the website widget, asks your team to join the chat.",
  ],
  troubleshooting: [
    {
      question: "The receptionist isn't following my rule. What can I check?",
      answer: "Make sure its status is **Ready**, not **Disabled**. Then look for a rule higher in the list that says something different, and move the more important one up. If the rule is long, shorten it or move it up, because calls only read the rules that fit, starting from the top.",
    },
    {
      question: "Why can't I see the Add Rule button?",
      answer: "Only owners and admins can change rules. Ask an owner or admin of the business to add the rule, or to change your role on the **Team** screen.",
    },
    {
      question: "My transfer rule doesn't transfer calls. Why?",
      answer: "A call can only be put through to the **Default transfer number** on the **AI settings** screen, so set it there first. With several AI agents, each receptionist has its own. A number written in a rule isn't used for the transfer. By default, the receptionist puts a call through when the caller asks to speak to someone, so word the rule to offer that. Only phone calls can be transferred, not website chats or calls made from a web browser.",
    },
    {
      question: "Saving a rule fails with \"Something went wrong. Please try again.\" What can I check?",
      answer: "Check the rule's length: the **Title** can be up to 160 characters and the **Content** up to 10,000. Shorten it and save again. If it still fails, check your connection and try again.",
    },
  ],
  related: ["knowledge", "ai-settings", "services", "questions"],
  keywords: ["instructions", "behavior", "call handling", "transfer rules", "policies", "prompts", "agent instructions", "priority"],
};

export default article;
