import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "usage",
  title: "Usage",
  section: "settings",
  summary: "See how much of your plan's voice minutes, transfer attempts, SMS alerts and knowledge storage the business has used, and when the monthly allowances start again.",
  screenPaths: ["/settings/usage"],
  location: ["Sidebar", "Manage", "Settings", "Usage"],
  access: "Everyone on the team can open this screen. It only shows figures, so there is nothing to change here. Owners and admins change the plan on the **Plan** screen.",
  purpose: [
    "The **Usage** screen shows how much of what your plan includes the business has used so far: the minutes your AI receptionist spent on calls, its attempts to transfer callers, the text alerts and appointment texts sent for the business and the space the text of your documents and website pages takes. It is the first tab of **Settings**, so it opens when you select **Settings** in the sidebar.",
    "Each line compares what was used with what is included, and a bar fills up as the business uses it. Check it to see how close you are to a limit before calls or texts stop, or before extra usage starts to cost money.",
    "A plan's allowances of minutes, transfers and texts start again at the beginning of each month. Prepaid packs work differently: what they include lasts until each pack ends, so the screen measures usage against what your packs hold instead.",
    "The figures are for the whole business. When the business has several AI agents, every receptionist draws on the same allowances.",
  ],
  areas: [
    { name: "Settings tabs", description: "The row of tabs at the top moves between the settings screens. **Usage** is the first tab and **Plan** is next to it." },
    { name: "Included usage", description: "The heading above the usage lines. The line under it, **Resets on** followed by a date, says when the monthly allowances start again. On prepaid packs, it says instead that your allowances come from your packs and last until each one ends." },
    { name: "Voice minutes", description: "The minutes the receptionist spent on calls, rounded to a tenth of a minute, out of the minutes included." },
    { name: "Transfer attempts", description: "How many calls the receptionist tried to put through to a person at your business, out of the attempts included." },
    { name: "SMS alerts", description: "The text messages sent for the business, counted in segments, out of the segments included: text alerts to your team, the code that verifies a phone for those alerts, and the appointment confirmations and reminders texted to customers." },
    { name: "Knowledge base", description: "The space the text of your documents and website pages takes, in MB, out of the storage your plan includes. This line never shows a limit message, but a full bar means new documents and website pages can't be added." },
    { name: "Limit reached", description: "When a line is used up and can't go further, because your plan stops at its allowance or the **Monthly spending cap** stops it, its bar turns red and the message under it starts with **Limit reached** and says usage is paused until the next period. On prepaid packs, the message says **No minutes left** for voice minutes, or **None left** for transfers and texts, and asks you to buy another pack." },
  ],
  tasks: [
    {
      title: "Check how much is left this month",
      steps: [
        "Select **Settings** in the sidebar. The **Usage** tab opens.",
        "Under **Included usage**, read each line. The first number is what the business used and the second is what the plan includes.",
        "Look at the date after **Resets on** to see when the monthly allowances start again.",
      ],
    },
    {
      title: "Get more minutes, transfers or texts",
      steps: [
        "Select the **Plan** tab.",
        "If you aren't an owner or admin, ask one to do the rest. Only they can change the plan or the spending cap.",
        "If the **Monthly spending cap** there says **Cap reached**, raise or remove the cap.",
        "Otherwise, select the upgrade button under **Your plan** to open the **Upgrade plan** dialog.",
        "Choose a plan that includes more, or a prepaid pack where packs are offered, and complete the payment if a payment page opens.",
        "Come back to the **Usage** tab. The new allowances show as soon as the change goes through.",
      ],
    },
    {
      title: "Check what's left on prepaid packs",
      steps: [
        "Open the **Usage** tab.",
        "Read **Voice minutes**, **Transfer attempts** and **SMS alerts**. Each shows what was used out of what your packs hold in total.",
        "Select the **Plan** tab to see your packs and when they end.",
      ],
    },
  ],
  notes: [
    "Monthly allowances start again on the first day of each month, whatever day your plan renews, and yearly plans work the same way. The month is counted in Coordinated Universal Time (UTC), so the reset can happen a few hours before or after midnight where you are.",
    "**Voice minutes** count the phone calls the receptionist answers and the calls made from a browser, such as test calls from the dashboard and voice calls from your website. Calls shorter than 10 seconds and calls the receptionist ended as spam don't count.",
    "When voice minutes are used up and can't go further, phone callers hear a busy signal and calls from a browser can't start until the allowance starts again or you get more. If the minutes run out during a call, the receptionist warns the caller shortly before, then ends the call politely and invites them to call back.",
    "A call uses one transfer attempt when the receptionist tries to put the caller through, whether or not anyone answers. When none are left, the receptionist offers to take a message instead.",
    "A long text uses more than one segment, and a text with emoji or some special characters fits fewer characters in each segment. When no segments are left, these texts aren't sent. Texts your team sends from the **Messages** screen don't count.",
    "**Knowledge base** counts the text of your documents and website pages, not the size of the files you uploaded, so a large file full of pictures can take little space. Documents that are turned off count too, and text entries don't count. When it's full, new documents and website pages can't be added until some are deleted or the business moves to a plan with more storage, but text entries can still be added.",
    "On plans that bill pay-as-you-go usage, calls, transfers and texts keep working past what's included and the extra is billed. The line then shows more used than included and its bar stays full. Owners and admins can limit that extra cost with the **Monthly spending cap** on the **Plan** screen.",
    "With prepaid packs, each use draws on the pack that ends first. What a pack still holds when it ends is lost, even while another pack is running.",
    "A line that shows what was used followed by **Custom allowance** follows the terms of your custom plan rather than a fixed number, so it has no bar.",
    "Website chats also count toward an allowance on some plans, but this screen doesn't list them.",
    "The screen shows the current month only. After a change of plan, the new allowances show at once, and usage already recorded this month counts against them. After a switch between prepaid packs and a subscription, the new allowances count from the moment of the switch.",
    "Each business has its own plan and usage. If you belong to several businesses, the screen shows the one chosen in the business menu at the top of the sidebar.",
  ],
  troubleshooting: [
    {
      question: "The screen says Usage data is unavailable. What can I do?",
      answer: "Select **Try again**. If the message stays, reload the page and check your internet connection. If it still doesn't clear, contact support.",
    },
    {
      question: "A line says Limit reached. What happens now?",
      answer: "That allowance is used up and can't go further, so that kind of use is paused until the date after **Resets on**: callers hear a busy signal when minutes run out, the receptionist takes a message instead of transferring, and texts aren't sent. On prepaid packs, it stays paused until you buy another pack. To carry on sooner, an owner or admin can move to a plan that includes more on the **Plan** screen, or raise the **Monthly spending cap** if the cap is what stopped the usage.",
    },
    {
      question: "Callers hear a busy signal. Is it because of our usage?",
      answer: "Look at **Voice minutes**. If it says **Limit reached**, or **No minutes left** on prepaid packs, the minutes are used up, so calls get a busy signal until the date after **Resets on**, or on packs until you buy another one. An owner or admin can get more on the **Plan** screen. If the line isn't at its limit, the minutes aren't the cause.",
    },
    {
      question: "Why does a line show more used than included?",
      answer: "Your plan bills pay-as-you-go usage, so use past the allowance carries on and is billed. Owners and admins can set a **Monthly spending cap** on the **Plan** screen to limit what it costs. It can also happen after a move to a plan that includes less, because the usage already recorded this month counts against the new allowance.",
    },
    {
      question: "Why don't the voice minutes match the length of my calls?",
      answer: "Calls shorter than 10 seconds and calls ended as spam don't count, while test calls from the dashboard and calls from your website do. A call in progress can also hold some minutes while it runs, and the count is corrected to the call's real length when it ends.",
    },
    {
      question: "SMS alerts are running out faster than expected. Why?",
      answer: "The line counts more than the alerts your team gets: it also counts the code that verifies a phone for alerts, and the appointment confirmations and reminders texted to customers. It counts segments rather than messages, so a long text uses several, and a text with emoji or some special characters fits fewer characters in each segment.",
    },
    {
      question: "The reset date isn't the day my plan renews. Is that right?",
      answer: "Yes. Allowances count by calendar month and start again on the first day of each month, whatever day the plan renews.",
    },
    {
      question: "Why does a line show no bar?",
      answer: "Either the line follows a custom allowance, or your plan includes none of it. A plan that includes none of something shows zero included, and if the plan stops at its allowances, the line also says the limit is reached.",
    },
    {
      question: "The knowledge base is full. How do I add more knowledge?",
      answer: "An owner or admin can delete documents and website pages you no longer need on the **Knowledge** screen, or move to a plan with more storage. Turning a document off doesn't free any space. The line counts the text of each document, not the file's size, so shorter documents take less space. Text entries don't count, so you can still add them.",
    },
    {
      question: "I see a note instead of the usage lines. Why?",
      answer: "Usage limits and billing don't apply to your workspace, so there is nothing to measure and the screen says so.",
    },
  ],
  related: ["plan", "knowledge", "calls", "notifications", "phone-number", "ai-settings"],
  keywords: ["usage", "minutes used", "minutes left", "out of minutes", "allowance", "quota", "limit reached", "busy signal", "voice minutes", "transfer attempts", "SMS alerts", "text segments", "knowledge storage", "reset date", "billing period", "prepaid pack balance"],
};

export default article;
