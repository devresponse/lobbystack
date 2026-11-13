import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "home",
  title: "Home",
  section: "general",
  summary: "See at a glance what needs your team: callbacks and requests your AI receptionist took, the next appointments, and how busy the last 30 days were.",
  screenPaths: ["/"],
  location: ["Sidebar", "General", "Home"],
  access: "Everyone on the team can open Home. Owners and admins also see how many questions the receptionist couldn't answer and the **Getting started** card, and only they can make test calls, claim a phone number or buy a plan. Owners, admins and schedulers can cancel appointments and approve cancellation requests from Home.",
  purpose: [
    "Home is the first screen you see after signing in. It gathers what still needs a person, such as a message the receptionist took for your team or a caller's request to cancel an appointment, along with the appointments coming up next and a summary of recent calls.",
    "Use it as your daily starting point. A callback or request that came from a call opens that call's page, and the line counting unanswered questions opens the **Questions** screen. Conversations handed to your team are answered on the **Messages** screen. The numbers at the top show how many calls and bookings the last 30 days brought, compared with the 30 days before.",
    "While your receptionist has no phone number of its own, a card at the top can walk you through hearing it answer and giving it a number.",
    "Home updates by itself while it is open. A new call, message, booking or cancellation shows up without reloading the page.",
  ],
  areas: [
    { name: "Top bar", description: "The top of every dashboard screen holds the same tools. The question mark at the top left opens the help page for the screen you are on, in a panel beside it. On larger screens, the top right also holds **Test Call**, which calls your receptionist from this browser so you can hear it answer. Only owners and admins can make test calls. When more than one receptionist is active, a dropdown beside it chooses which one answers. Next come the gift icon, labeled **Affiliate Program**, which opens the **Affiliate program** screen, and the speech bubble, **Feedback**, which opens a box for a short note about the dashboard to the team that makes the app, with a **Contact us** link when you need help. On a phone, the top bar holds only the menu button and the question mark." },
    { name: "Hear your agent answer", description: "A card that shows until the business has its own phone number. It first invites you to call your receptionist from the browser with **Start a call**, and once the app has read your website, it says how many pages it read. After your first test call that connects and ends, it changes to **Claim your phone number** with **Pick a number** when your plan includes a number you haven't picked yet, or to **Give your agent a phone number** with **Choose a plan**. Only owners and admins can make the call, claim a number or buy a plan. While the app is still reading your website, the card shows that progress instead: how many pages it has read and how many are ready for questions." },
    { name: "Calls, Appointments and Average duration", description: "Three numbers for the last 30 days, each with the change from the 30 days before, such as **+12.5% from last month** or **No change from last month**. **Calls** counts every call that started, test calls and archived calls included. **Appointments** counts the appointments booked in that time, whatever day they are for, cancelled ones included. **Average duration** is the average length of those calls, and its change shows in minutes and seconds." },
    { name: "Action required", description: "What still needs a person, newest first, with a count beside the title. When there are open questions, owners and admins first see a line such as **3 questions your receptionist couldn't answer**; select it to answer them on the **Questions** screen. Below come up to six items: **Callback** for a message the receptionist took for your team, such as a callback or appointment request, **Cancellation** for a caller who asked to cancel an appointment, and **Handoff** for a conversation handed to your team, such as a chat a team member took over or a website visitor waiting for a person. **Urgent** marks a request the caller said was urgent. Each item's title sums up the request and names the customer, and below it come the number to call back, when the caller left one, and when the item came in. A **Cancellation** names the appointment when the request matched one, with **Approve cancellation** for owners, admins and schedulers, or says that no upcoming appointment matches the request or that the appointment is already cancelled. The title of an item that came from a call opens that call's page. When nothing is waiting, the section says **No action required**." },
    { name: "Upcoming", description: "The next five appointments that aren't cancelled, soonest first, with a count beside the title. Each shows the customer, the status, such as **Confirmed**, how it was booked, such as **Phone call**, **Web call**, **Website chat** or **API**, the service, or **Unknown service** when none is saved, and the day and time in the appointment's own time zone. Owners, admins and schedulers see **Cancel** under each appointment. When nothing is booked, the section says **No upcoming appointments**." },
    { name: "Calls per month", description: "A bar chart of the calls the business received in each of the last 12 months, this month included. Like the numbers at the top, it counts test calls and archived calls." },
    { name: "Recent Calls", description: "The five latest calls, leaving out archived ones. Each shows who called, then their number when the caller has a saved name, or the time of the call otherwise, and how long it lasted in seconds. A call with no length recorded, such as one still in progress, shows its status instead. These rows don't open the call: use the **Calls** screen for that." },
    { name: "Getting started", description: "Owners and admins see this card at the bottom of the sidebar on every screen, with how many setup steps are done or skipped, such as **2 / 4 completed**, until all of them are. Select it to open the setup guide." },
  ],
  tasks: [
    {
      title: "Follow up on a callback",
      steps: [
        "In **Action required**, find the item marked **Callback**.",
        "Select its title to open the call's page. Only an item that came from a call opens one.",
        "On the **Details** tab, read the message, the number to call back and when the caller would like the call.",
        "Call the customer back, then select **Mark done**. The item leaves **Action required**.",
      ],
    },
    {
      title: "Approve a cancellation request",
      steps: [
        "In **Action required**, find the item marked **Cancellation**. It names the appointment the caller asked to cancel.",
        "Select **Approve cancellation**. Only owners, admins and schedulers see it.",
        "In **Cancel this appointment?**, check the appointment, then select **Cancel appointment**, or **Keep appointment** to leave it booked.",
        "**Appointment cancelled** confirms it. The appointment is taken off your connected calendar, its reminder is skipped and the request closes.",
      ],
    },
    {
      title: "Cancel an upcoming appointment",
      steps: [
        "In **Upcoming**, select **Cancel** under the appointment. Only owners, admins and schedulers see it.",
        "In **Cancel this appointment?**, select **Cancel appointment** to confirm, or **Keep appointment** to leave it booked.",
        "**Appointment cancelled** shows, and the appointment leaves **Upcoming**.",
      ],
    },
    {
      title: "Answer the questions your receptionist couldn't",
      steps: [
        "In **Action required**, select the line that counts the questions the receptionist couldn't answer. Only owners and admins see it.",
        "Answer or dismiss each question on the **Questions** screen.",
      ],
    },
    {
      title: "Hear your receptionist answer",
      steps: [
        "On a larger screen with more than one active receptionist, choose who answers in the dropdown beside **Test Call**. Otherwise the default receptionist answers.",
        "Select **Start a call** on the card at the top or, on a larger screen, **Test Call** in the top bar. Only owners and admins can make test calls.",
        "Allow the browser to use your microphone when it asks.",
        "Talk to the receptionist as a customer would, then select **Hang up**.",
        "The call then appears on the **Calls** screen like any other, as a web call.",
      ],
    },
    {
      title: "Give your receptionist its own phone number",
      steps: [
        "Make a test call. Once it has connected and ended, the card at the top moves on to its next step.",
        "If your plan includes a number, select **Pick a number** and choose one on the **Phone Number** screen. Only owners and admins can claim a number or buy a plan.",
        "Otherwise, select **Choose a plan** and pick a plan that includes a number in the **Upgrade plan** dialog.",
        "Once the business has its own number, the card no longer shows. The **Phone Number** screen is also always under **Settings**.",
      ],
    },
  ],
  notes: [
    "Home shows the business chosen at the top of the sidebar. If you belong to several businesses, switch there to see another one's activity.",
    "With several AI agents, Home covers all of them together.",
    "If the business's setup isn't finished, signing in opens the setup steps instead of Home.",
    "The numbers at the top compare the last 30 days with the 30 days before them, which the screen calls last month. When the 30 days before had no calls or no bookings, that number's change shows as **+100.0% from last month**.",
    "**Action required** lists at most six items at a time, newest first. Its count is the number of items listed, plus one for the line counting unanswered questions when it shows. Older items appear as newer ones are dealt with.",
    "A message the receptionist took for your team on a call is one item, however many messages the caller left. Each request to cancel an appointment is an item of its own.",
    "A **Handoff** leaves the list when someone selects **Resume AI** for the conversation on the **Messages** screen, when the conversation is closed or archived, or when the receptionist takes a website chat back, for example because nobody from the team joined within 3 minutes.",
    "Cancelling an appointment here works as it does on the **Appointments** screen. The customer gets a cancellation text if they agreed to receive texts and the appointment hasn't started yet.",
    "Appointment times, in **Upcoming** and on a cancellation request, show in the appointment's own time zone. Other times show in your device's time zone. All times follow the **Time format** chosen on the **Preferences** screen.",
    "When a payment for your plan doesn't go through, owners and admins see a **Payment unsuccessful** banner across the top of every dashboard screen until the payment goes through. The service stays active during the grace period. Where the billing portal is available, the banner offers **Update payment method**.",
  ],
  troubleshooting: [
    {
      question: "An item in Action required doesn't open anything when I select it. Why?",
      answer: "Only an item that came from a call opens that call's page, where you can mark it done. A **Handoff** is a conversation, so open it on the **Messages** screen. A message the receptionist took in a website chat isn't linked to a call, so its title doesn't open anything either.",
    },
    {
      question: "An item in Action required only says it expired. What happened?",
      answer: "Follow-ups are kept for a limited time that depends on your plan, and then what the caller said is removed. If you have dealt with it, open the call's page and select **Mark done** on the **Details** tab to clear it.",
    },
    {
      question: "The numbers at the top don't match what I see on the Calls screen. Why?",
      answer: "**Calls** at the top counts every call from the last 30 days, test calls and archived calls included, while the **Calls** screen leaves archived calls out. **Appointments** counts the bookings made in the last 30 days, whatever their date and including cancelled ones, while **Upcoming** lists only the next five that aren't cancelled.",
    },
    {
      question: "Why can't I see Approve cancellation on a cancellation request?",
      answer: "It shows only to owners, admins and schedulers, and only when the request matches exactly one upcoming appointment. When nothing matched, the item says so: find the appointment on the **Appointments** screen and cancel it there, then mark the request done on the call's page. When the item says the appointment is already cancelled, there is nothing to approve: mark the request done on the call's page.",
    },
    {
      question: "Cancelling shows We couldn't cancel the appointment. Try again.",
      answer: "The cancellation didn't go through, and the appointment is still booked. Check your connection, wait a moment and try again. If someone else cancelled it a moment before you, cancelling still shows **Appointment cancelled**.",
    },
    {
      question: "Why don't I see the unanswered questions line or the Getting started card?",
      answer: "Both are for owners and admins only. The questions line shows only while there are questions to answer, and **Getting started** disappears once every setup step is done or skipped.",
    },
    {
      question: "My test call doesn't connect. What can I check?",
      answer: "Only owners and admins can make test calls: schedulers and viewers see **Test Call** and **Start a call**, but their calls don't start. Allow the browser to use your microphone: if it is blocked or missing, the call says so, for example **Microphone access was blocked**. If it says the browser doesn't support live voice calls, use another browser. If it says **Too many test calls have been started**, wait a little and try again. If it says your AI receptionist is unavailable right now, the business may have used the voice minutes its plan includes, which the **Usage** screen shows.",
    },
    {
      question: "I made a test call, but the card at the top didn't move on. Why?",
      answer: "The card moves on after a test call made from the dashboard, not from your website, that connected and then ended. It can take a few seconds after you hang up. If the call never connected, for example because the microphone was blocked, make another one.",
    },
    {
      question: "The card at the top of Home disappeared. Where did it go?",
      answer: "It shows only until the business has its own phone number. You can still call your receptionist from the browser with **Test Call** in the top bar. If you never see the card, it isn't offered for your account.",
    },
    {
      question: "The numbers at the top are missing and the lists are empty. What can I do?",
      answer: "Home couldn't load the business's activity. Check your connection and reload the page. If you belong to several businesses, check which one is chosen at the top of the sidebar.",
    },
    {
      question: "A box titled Before you go appeared. What is it?",
      answer: "It is a short, optional survey that asks whether you ran into an issue or are missing something. It can appear when your pointer leaves the top of the window or when the dashboard sits untouched for a few minutes. Answer either question and select **Send**, or select **Not now** to close it. It shows at most once every 30 days for each business in the same browser.",
    },
  ],
  related: ["calls", "call-details", "messages", "questions", "appointments", "analytics", "setup-guide", "phone-number", "plan", "usage", "affiliate-program"],
  keywords: ["dashboard", "overview", "start page", "home page", "action required", "callbacks", "follow-ups", "handoffs", "cancellation requests", "approve cancellation", "upcoming appointments", "recent calls", "calls per month", "test call"],
};

export default article;
