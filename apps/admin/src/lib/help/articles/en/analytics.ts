import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "analytics",
  title: "Analytics",
  section: "manage",
  summary: "See how busy your business is and how your AI receptionist is doing, with calls, messages, appointments, response time, call outcomes and channels for any dates you choose.",
  screenPaths: ["/analytics"],
  location: ["Sidebar", "Manage", "Analytics"],
  access: "Everyone on the team can open Analytics: owners, admins, schedulers and viewers. The screen only shows numbers, so there is nothing to change or save.",
  purpose: [
    "Analytics turns your calls, messages and bookings into charts, so you can see how busy the business is, how calls end and how customers reach you. It covers phone calls, calls made from a web browser, text messages and website chats.",
    "Choose the dates and how to group them at the top of the screen. The cards then show the totals for those dates, charts over time and how each number compares with the same number of days just before, so you can spot trends and see the effect of changes you make to the receptionist.",
    "When the business has several AI agents, the screen shows all of them together. The numbers update on their own as calls, messages and appointments come in.",
  ],
  areas: [
    { name: "Engagement Overview", description: "A chart with one line for **Calls** and one for **Messages**, counted in each interval of the dates you picked, such as each week. Point at it, or at the small chart on each number card below it, to see the numbers for one interval." },
    { name: "Number of calls", description: "How many calls started in the dates you picked, phone and web calls alike. Below the total are the dates, a small chart over time and the change from the previous period." },
    { name: "Number of messages", description: "How many messages were sent and received in those dates: texts and website chat messages from customers, the receptionist and your team, and the messages the receptionist took for your team during calls." },
    { name: "Appointments booked", description: "How many appointments take place in those dates, counted by the time they are booked for, not the day they were made. Appointments that were cancelled later are included." },
    { name: "Agent response time", description: "How long the receptionist took, on average, to reply after a customer wrote to it, such as in a website chat. Replies from your team don't count. Below it, a plus sign means slower replies than in the previous period and a minus sign means faster ones." },
    { name: "Call Outcomes", description: "How the calls in those dates ended. **Completed** calls connected and ended normally. **Transferred** calls are those the receptionist put through to your team, or tried to, however they ended. **Live** calls are still going on. **Missed** calls were missed, busy, went to voicemail, failed or never properly connected." },
    { name: "Channels", description: "The share of calls and messages that came through each channel, in whole percentages that add up to 100 when there is any activity: **Phone call**, **Web call** for calls made from a web browser such as through your website widget, **SMS** and **Website chat**. A message counts with the conversation it belongs to, so your team's replies count with the text or chat they answer, and a message the receptionist takes during any call counts under **Phone call**. **Other** appears only when some activity doesn't fit any of these." },
  ],
  fields: [
    {
      title: "Dates and interval",
      description: "The buttons at the top right of the screen. Every card follows them.",
      fields: [
        { name: "Aggregation interval", description: "The first button, which shows how the charts group the numbers: **Yearly**, **Monthly**, **Weekly**, **Daily** or **Hourly**. **Weekly** is the default. An interval too short for the dates you picked is greyed out, and the screen switches to a longer one by itself until you pick fewer dates again." },
        { name: "Date range", description: "The calendar button, which highlights the dates you're looking at. Selecting a day before the highlighted dates moves the start there, and selecting any day after the first highlighted day moves the end there. Selecting the first or the last highlighted day narrows the dates to that one day. The time frame then shows **Custom Range**." },
        { name: "Preset time frame", description: "The button beside the calendar, which names the dates you're looking at. Choose **Today**, **Yesterday**, **This Week**, **This Month**, **Last Month**, **Last 30 Days**, **Last 3 Months**, **This Year**, **Last Year** or **All Time**. **Last 30 Days** is the default." },
      ],
    },
  ],
  tasks: [
    {
      title: "Look at a different period",
      steps: [
        "Open **Analytics** in the sidebar.",
        "Select the time frame button at the top right, which shows **Last 30 Days** at first.",
        "Choose a period, such as **This Month**. Every card updates to the new dates.",
      ],
    },
    {
      title: "Look at dates you choose",
      steps: [
        "Select the calendar button at the top right. The dates you're looking at are highlighted. Use the arrows to move to another month.",
        "Select the first day you want twice, so that only that day is chosen.",
        "Select the last day you want. The time frame changes to **Custom Range** and the cards show those dates.",
      ],
    },
    {
      title: "Change how the charts group the numbers",
      steps: [
        "Select the interval button at the top right, which shows **Weekly** at first.",
        "Choose **Yearly**, **Monthly**, **Weekly**, **Daily** or **Hourly**. A greyed out choice is too short for the dates you picked, so pick fewer dates first.",
      ],
    },
    {
      title: "Compare with the previous period",
      steps: [
        "Look at the line at the bottom of a card, such as **+12.5% vs previous period**.",
        "Read a plus sign as more than in the previous period and a minus sign as fewer. For **Agent response time**, a plus sign means the receptionist replied more slowly.",
        "Read **No change vs previous period** as the two periods being the same.",
      ],
    },
  ],
  notes: [
    "The four number cards compare the dates you picked with the same number of days just before them. On the 13th of a month, **This Month** is compared with the 13 days before the 1st, not with the whole of last month.",
    "On **Number of calls**, **Number of messages** and **Appointments booked**, when the previous period had none, any activity now shows as **+100.0% vs previous period**.",
    "On **Agent response time**, when the receptionist didn't reply to any written messages in the previous period, the whole of this period's average shows with a plus sign, as if replies had slowed down.",
    "Days, weeks and hours on this screen follow Coordinated Universal Time (UTC), not your business's time zone. Activity late in your evening or early in your morning can land on the next or the previous day, and the hourly view shows UTC hours.",
    "Weeks run from Sunday to Saturday, both for **This Week** and for the weekly interval.",
    "**All Time** starts on the day the business was created and goes back at most 10 years.",
    "Calls are counted on the day they started. Test calls you make from the dashboard count too, as web calls.",
    "Archived calls still count here, although they no longer show on the **Calls** screen.",
    "**Agent response time** shows **0s** when the receptionist didn't reply to any written messages in those dates. Phone calls aren't part of it.",
  ],
  troubleshooting: [
    {
      question: "I see \"Analytics are unavailable.\" What can I do?",
      answer: "The numbers couldn't be loaded. Reload the page. If you picked dates more than about 10 years apart with the calendar button, choose a shorter range. If the message stays, check that you're still signed in and try again a little later.",
    },
    {
      question: "Why don't the numbers match what I count on the Calls screen?",
      answer: "This screen counts whole days in Coordinated Universal Time (UTC), not in your time zone, so calls made late in your evening or early in your morning can count on a different day here. It also counts calls that were archived, which the **Calls** list no longer shows, and the calls of every receptionist, while the **Calls** list can be filtered to one receptionist.",
    },
    {
      question: "Why is Hourly greyed out?",
      answer: "**Hourly** works for up to 20 days, and **Daily** for up to a year. Choose a shorter time frame, or pick fewer days with the calendar button, then choose the interval again.",
    },
    {
      question: "Why is Appointments booked lower than the number of bookings made this week?",
      answer: "**Appointments booked** counts appointments by the day they take place, not the day they were made. A booking made today for next month counts in next month's numbers. To count upcoming appointments, pick future dates with the calendar button.",
    },
    {
      question: "What does Other mean under Channels?",
      answer: "It holds activity that doesn't fit **Phone call**, **Web call**, **SMS** or **Website chat**. It only appears when there is some.",
    },
    {
      question: "Can I see the numbers for one receptionist?",
      answer: "Not on this screen. Analytics always counts all of your receptionists together. To look at one receptionist's calls or conversations, use the receptionist filter on the **Calls** or **Messages** screen.",
    },
  ],
  related: ["home", "calls", "messages", "appointments"],
  keywords: ["reports", "statistics", "metrics", "charts", "call volume", "missed calls", "trends", "performance", "response time", "call outcomes", "channels", "KPIs"],
};

export default article;
