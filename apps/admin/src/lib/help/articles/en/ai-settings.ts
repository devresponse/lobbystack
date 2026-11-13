import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "ai-settings",
  title: "AI settings",
  section: "agent",
  summary: "Choose how your AI receptionist answers: its greeting, what it says about the business, its language and time zone, where it transfers calls, how it books, your opening hours and whether callers can change appointments.",
  screenPaths: ["/agent", "/agent/basic-settings"],
  location: ["Sidebar", "Agent", "AI settings"],
  access: "Everyone on the team can open AI settings and see each setting. Only owners and admins can change them: schedulers and viewers can look at every receptionist's settings, but the fields and buttons that change them are turned off.",
  purpose: [
    "AI settings decides how your AI receptionist handles calls and chats: the first words callers hear, what it says about your business, the language and time zone it works in, the number it puts callers through to, whether it books appointments, your opening hours, and whether callers can cancel or move an appointment without your team.",
    "What the receptionist knows is set on other screens. Facts such as prices and policies go on the **Knowledge** screen, instructions for particular situations on the **Rules** screen, and what you offer on the **Services** screen.",
    "With one receptionist, the screen shows **Defaults**, **Booking**, **Opening hours** and **Appointment changes**, in that order. When the business has more than one receptionist that isn't archived, paused ones included, the screen is arranged in two parts. **Shared by every receptionist** comes first, followed by **Opening hours** and **Appointment changes**, which every receptionist shares too. **Each receptionist's own** comes last and holds the greeting, language, transfer number and booking of the receptionist you choose in the **Receptionist** dropdown.",
  ],
  areas: [
    { name: "Defaults", description: "With one receptionist, the first card: **Greeting**, **Tell callers about AI and recording**, **Business summary**, **Default customer language**, **Business timezone** and **Default transfer number**." },
    { name: "Booking", description: "With one receptionist, the **Appointments** setting, which decides whether the receptionist books appointments, takes requests or doesn't book. When it books but the business has no opening hours, a notice below it says **Add opening hours to book appointments**. Its **Add opening hours** button opens the hours editor for owners and admins." },
    { name: "Shared by every receptionist", description: "With several AI agents, the first card: **Business summary**, **Tell callers about AI and recording**, **Business language** and **Business timezone**. These belong to the business, so a change here applies to every receptionist." },
    { name: "Opening hours", description: "One line with your weekly hours, or **Not set**, and **Edit** to change them. The receptionist offers appointments only inside these hours. A note above the line says when the hours were filled in from your website and documents and need checking, or that no hours are set yet. The hours are the business's, shared by every receptionist." },
    { name: "Appointment changes", description: "Whether callers can cancel or reschedule an appointment with the receptionist, and how they prove it's theirs. These rules are shared by every receptionist." },
    { name: "Each receptionist's own", description: "With several AI agents, the **Receptionist** dropdown and the chosen receptionist's **Greeting**, **Language**, **Default transfer number** and **Appointments**. The notice about opening hours shows below it when that receptionist books appointments and no hours are set." },
  ],
  fields: [
    {
      title: "Defaults",
      description: "The first card when the business has one receptionist. With several AI agents, the same settings are split between **Shared by every receptionist** and **Each receptionist's own**, as each one says below.",
      fields: [
        { name: "Greeting", requirement: "required", description: "The first thing the receptionist says when it answers a call, such as \"Thank you for calling. How can I help you today?\" Select **Edit**, write it in the box and select **Save**. It can't be saved empty and can be up to 2,000 characters. It plays as written, so write it in the language calls start in. Calls made from a browser, such as from the website widget, open with it too, but website chats don't show it. With several AI agents, each receptionist has its own." },
        { name: "Tell callers about AI and recording", description: "On unless you turn it off. Right after the greeting, calls say that the caller is speaking with an AI assistant and that the call is recorded and transcribed, in the language the call starts in. The screen quotes the words callers hear in the business's language. Many places require telling callers that a call is recorded, so turn this off only if you tell them another way. While it's on, a website widget that offers calls also says, under its call button, that calls are answered by an AI assistant and are recorded and transcribed. Shared by every receptionist." },
        { name: "Business summary", requirement: "optional", description: "What the receptionist tells callers about your business, in a few sentences. You don't have to write it: until someone does, the AI writes it from the articles available to every receptionist and rewrites it as they change. Select **Edit** to write your own: the box can't be saved empty, takes up to 2,000 characters, and from then on the summary stays as you wrote it. Shared by every receptionist." },
        { name: "Default customer language", description: "The language calls start in. When a caller speaks another language, the receptionist switches to it. Call summaries are written in this language. The list has English, Spanish, French, German, Hindi, Japanese, Korean, Portuguese, Mandarin Chinese, Italian, Ukrainian, Russian and Arabic, each shown in its own language. With several AI agents it's called **Business language**: the default receptionist speaks it, and so does each receptionist without a language of its own." },
        { name: "Business timezone", description: "The time zone of your opening hours and of the appointment times the receptionist offers. Zones are grouped by region and listed by city with their current offset from GMT, such as Tokyo (GMT+09:00). Shared by every receptionist." },
        { name: "Default transfer number", requirement: "optional", description: "The phone number the receptionist puts a phone call through to when a caller asks to speak with a person, such as your front desk or a manager's mobile. Type the full number, starting with + and the country code, and select **Save** beside it. Leave it empty and select **Save** to stop transfers: the receptionist then offers to take a message. With several AI agents, each receptionist has its own." },
      ],
    },
    {
      title: "Booking",
      description: "With several AI agents, **Appointments** is under **Each receptionist's own**, so each receptionist can handle bookings differently.",
      fields: [
        { name: "Appointments", description: "**Books appointments**: the receptionist checks your open times and books the appointment. **Takes requests**: it notes the service and the caller's preferred time, and the request reaches your team as a **Callback** under **Action required** on **Home**, so you can confirm the time. **Doesn't book**: it takes a message instead of booking. The change saves as soon as you choose." },
      ],
    },
    {
      title: "Opening hours",
      description: "The box that opens from **Edit** under **Opening hours**, with one row for each day of the week, Monday first. Select **Save hours** to keep your changes or **Cancel** to leave them.",
      fields: [
        { name: "Open on", description: "The switch beside each day. Turn it on for a day you're open, and the day starts with the hours 09:00 to 17:00, which you can change. A day turned off shows **Closed**." },
        { name: "Opening time and closing time", requirement: "conditional", description: "Required for each set of hours on a day that is open. The closing time must come after the opening time on the same day, and a day's sets of hours can't overlap. Choose midnight as the closing time to stay open to the end of the day." },
        { name: "Add hours", description: "Adds another set of hours to the same day, such as the afternoon after a lunch break. The new set starts when the one before it closes and ends at 17:00, so set its times. A day can have up to 4. When a day has more than one, the cross beside a set of hours removes it." },
      ],
    },
    {
      title: "Appointment changes",
      description: "Shared by every receptionist. Each setting saves as soon as you change it.",
      fields: [
        { name: "Allow AI cancellations", description: "On to start with. Lets the receptionist cancel a future appointment once the caller has passed the check in **Caller verification**." },
        { name: "Allow AI rescheduling", description: "On to start with. Lets the receptionist move a future appointment to another open time once the caller has passed the check. Only a receptionist set to **Books appointments** can reschedule, because it has to check open times." },
        { name: "Caller verification", description: "How callers prove an appointment is theirs. **Phone number and booking details**, the choice to start with: they call from the number the appointment was booked with and say its time or service. **Texted one-time code**: they also read back a code texted to that number. **Keypad PIN**: they also type the PIN saved on their contact on the phone keypad, and callers without a PIN are passed to your team. A fourth choice, **Your team makes changes**, shows only when the business already has it saved: the receptionist then doesn't change appointments and passes requests to your team." },
      ],
    },
    {
      title: "Each receptionist's own",
      description: "Shows only when the business has several AI agents. The greeting, transfer number and appointments in this part are described above.",
      fields: [
        { name: "Receptionist", description: "Chooses whose settings the card below shows. It lists every receptionist that isn't archived: the default receptionist is marked **Default** and a paused one **Paused**. From 8 receptionists, the list has a search box. Owners and admins also see **Add receptionist**, which opens the **AI agents** screen ready to add one, and **Manage receptionists**, which opens that screen. **AI settings** in a receptionist's menu on that screen opens this page with the receptionist already chosen." },
        { name: "Language", description: "The language this receptionist's calls start in. **Business language** follows the language set under **Shared by every receptionist**. The default receptionist always speaks the business's language, so its language can't be changed here." },
      ],
    },
  ],
  tasks: [
    {
      title: "Change the greeting",
      steps: [
        "Open **AI settings** in the sidebar.",
        "With several AI agents, choose the receptionist in the **Receptionist** dropdown under **Each receptionist's own**.",
        "Beside **Greeting**, select **Edit**.",
        "Write what the receptionist should say first, in the language its calls start in.",
        "Select **Save**. **Changes saved** shows under the setting.",
      ],
    },
    {
      title: "Set the number calls are transferred to",
      steps: [
        "With several AI agents, choose the receptionist in the **Receptionist** dropdown first.",
        "Under **Default transfer number**, type the full phone number, starting with + and the country code.",
        "Select **Save** beside the number.",
        "To stop transfers, clear the field and select **Save** again.",
      ],
    },
    {
      title: "Choose how the receptionist handles appointments",
      steps: [
        "With several AI agents, choose the receptionist in the **Receptionist** dropdown first.",
        "In **Appointments**, choose **Books appointments**, **Takes requests** or **Doesn't book**. The change saves at once.",
        "If you chose **Books appointments**, set your opening hours on this screen and make sure at least one service is bookable on the **Services** screen.",
      ],
    },
    {
      title: "Set your opening hours",
      steps: [
        "Under **Opening hours**, select **Edit**.",
        "Turn on each day you're open and turn off each day you're closed.",
        "Set the opening and closing time of each open day.",
        "For a break during the day, set the first closing time to when the break starts, select **Add hours**, and set the second set of hours to start when the break ends.",
        "Select **Save hours**. The line under **Opening hours** shows your new week.",
      ],
    },
    {
      title: "Let callers cancel or move appointments",
      steps: [
        "Under **Appointment changes**, turn on **Allow AI cancellations**, **Allow AI rescheduling** or both.",
        "In **Caller verification**, choose how callers prove the appointment is theirs.",
        "If you chose **Keypad PIN**, give each customer a PIN with **Set PIN** under **Keypad PIN** on their contact's **Details** tab, and tell them their PIN.",
      ],
    },
    {
      title: "Change the language calls start in",
      steps: [
        "With one receptionist, choose the language in **Default customer language**. It saves at once.",
        "With several AI agents, choose **Business language** under **Shared by every receptionist**. The default receptionist speaks it, and so does each receptionist set to **Business language**.",
        "To give one receptionist a language of its own, choose it in the **Receptionist** dropdown under **Each receptionist's own**, then choose its **Language**.",
        "Rewrite the greeting in the new language, because it plays exactly as written.",
      ],
    },
    {
      title: "Write or rewrite the business summary",
      steps: [
        "Beside **Business summary**, select **Edit**.",
        "Change the text and select **Save**. From then on, it stays as you wrote it.",
        "To have the AI write it again from your knowledge, open the same box and select **Rewrite with AI**. The line under the summary says the AI is rewriting it, so check back in a minute.",
      ],
    },
    {
      title: "Change one receptionist's settings",
      steps: [
        "Under **Each receptionist's own**, open the **Receptionist** dropdown and choose the receptionist.",
        "Change its **Greeting**, **Language**, **Default transfer number** or **Appointments**. These changes apply to that receptionist only.",
        "To change what every receptionist shares, use the cards above the dropdown.",
      ],
    },
  ],
  notes: [
    "Switches and dropdowns save as soon as you change them. The greeting and the business summary save from their box with **Save**, the transfer number with the **Save** button beside it, and opening hours with **Save hours**.",
    "Most settings show **Saving…** while a change saves, and every setting shows **Changes saved** once it's saved. When a save fails, a message says \"We couldn't save your settings. Please try again.\" instead.",
    "A change reaches the receptionist shortly after you save it, for calls that start after that and for the next message in a website chat. A call already in progress keeps the settings it started with.",
    "To hear a change, use **Test Call** at the top right of the dashboard. It isn't shown on a phone's small screen. When more than one receptionist is active, choose who answers in the dropdown beside it. A test call runs in your browser, so it can't be transferred and can't cancel or move an appointment.",
    "Only phone calls can be transferred. In a website chat or a call made from a browser, the receptionist can't put anyone through: it offers to take a message and, when your phone calls can be transferred, gives your business number to call.",
    "In a website chat where **Let visitors chat with your team** is on for the website widget, the receptionist asks your team to join the chat instead of offering a transfer. It does this during opening hours, or at any time when no opening hours are set.",
    "Transfers always go to the **Default transfer number** of the receptionist answering, even when a rule names another number. Each transfer counts toward the transfer attempts your plan includes, and when your plan can't take another one, the receptionist offers to take a message instead.",
    "Callers can cancel or move an appointment themselves only on a phone call from the number the appointment was booked with. When that isn't the case, or a check fails, the receptionist changes nothing: it passes a cancellation to your team, which shows as **Cancellation** under **Action required** on **Home**, and offers to take a message for anything else, such as moving the appointment. A receptionist set to **Doesn't book** doesn't change appointments at all.",
    "Hours filled in from your website and documents carry a note until you check and save them. Once you save your hours, they're never replaced automatically.",
    "A day's hours can't run past midnight. To stay open late, close the day at midnight and open the next day at midnight.",
    "Changing the time zone keeps your opening hours at the same clock times, and appointments already booked keep their times.",
    "Changing the business's language also renames the default receptionist while it still has the name the app gave it in the old language, such as from Front desk to Recepción for Spanish. A name someone chose stays as it is.",
    "The business summary is written only from articles available to every receptionist, so an article chosen for some receptionists on the **Knowledge** screen never shows in it.",
  ],
  troubleshooting: [
    {
      question: "Why can't I change anything on this screen?",
      answer: "Only owners and admins can change AI settings. Ask an owner or admin of the business to make the change, or to change your role on the **Team** screen.",
    },
    {
      question: "Saving fails with \"We couldn't save your settings. Please try again.\" What can I check?",
      answer: "The change didn't save, even if the setting still shows it. Check your connection, reload the page to see what is saved, and make the change again. A greeting longer than 2,000 characters can't be saved either, so shorten a long one.",
    },
    {
      question: "Saving the transfer number says \"Enter a complete valid transfer number before saving.\" Why?",
      answer: "The field doesn't hold a complete phone number yet. Type the whole number, starting with + and the country code, then select **Save** again.",
    },
    {
      question: "I changed the greeting, but calls still open with the old one. Why?",
      answer: "A change reaches calls shortly after you save it, and a call already in progress keeps the greeting it started with. With several AI agents, make sure you changed the greeting of the receptionist that answers that number: **Answered by** on the **Phone Number** screen shows who it is, and while that receptionist is paused, the default one answers instead. Use **Test Call** to hear the greeting.",
    },
    {
      question: "Calls start in the wrong language. What can I check?",
      answer: "With one receptionist, check **Default customer language**. With several AI agents, check the **Language** of the receptionist answering, under **Each receptionist's own**: **Business language** there means the one set under **Shared by every receptionist**. Then make sure the greeting is written in that language, because it plays exactly as written. The receptionist still switches when a caller speaks another language.",
    },
    {
      question: "The receptionist takes messages instead of booking appointments. What can I check?",
      answer: "Make sure **Appointments** is set to **Books appointments** for the receptionist answering, that your opening hours are set, and that at least one service is bookable on the **Services** screen. If you connected a calendar on the **Integrations** screen and it hasn't synced recently, the receptionist can't confirm times and offers to take a message instead.",
    },
    {
      question: "What does **Add opening hours to book appointments** mean?",
      answer: "The receptionist is set to book appointments, but the business has no opening hours, so there are no times to offer. Until you add them, it takes a message instead. Select **Add opening hours** and set your week.",
    },
    {
      question: "Why does saving my hours say each closing time must come after its opening time?",
      answer: "On that day, a set of hours closes before it opens, a time is empty, or two sets overlap. A set added with **Add hours** starts when the one before it closes and ends at 17:00, so check its times too. Fix the times on that day, then select **Save hours** again.",
    },
    {
      question: "Calls aren't being transferred. What can I check?",
      answer: "Make sure the receptionist answering has a **Default transfer number** saved. Transfers happen only on phone calls to your business number, never in **Test Call** or a website chat, and each one counts toward the transfer attempts your plan includes.",
    },
    {
      question: "Callers say they can't cancel their appointment by phone. Why?",
      answer: "Check that **Allow AI cancellations** is on and that the receptionist isn't set to **Doesn't book**. Callers must call from the number the appointment was booked with and say its time or service. With **Texted one-time code**, your business also needs a number that can text them, and with **Keypad PIN**, a PIN saved on their contact. A caller gets 3 tries at the PIN for one change, and 5 wrong PINs in a row, across calls, lock it until someone sets a new one on the contact. When a check fails, the request goes to your team instead.",
    },
    {
      question: "Why don't I see **Rewrite with AI**?",
      answer: "It shows in the summary's box only after someone has written the summary. While the AI writes it, the summary already updates on its own as your knowledge changes.",
    },
    {
      question: "The business summary box is empty. Is something wrong?",
      answer: "The AI writes the summary a few minutes after the business has articles available to every receptionist on the **Knowledge** screen, such as your website or documents. You can also write it yourself with **Edit**.",
    },
    {
      question: "Where is the **Receptionist** dropdown?",
      answer: "It shows only when the business has more than one receptionist that isn't archived. You can add one on the **AI agents** screen.",
    },
    {
      question: "Why can't I choose a language for the default receptionist?",
      answer: "The default receptionist always speaks the business's language. Change **Business language** under **Shared by every receptionist**, or make another receptionist the default on the **AI agents** screen.",
    },
    {
      question: "Appointment times look a few hours off. What should I check?",
      answer: "Check **Business timezone**: the receptionist offers times in that zone, so choose the city your business is in.",
    },
  ],
  related: ["ai-agents", "knowledge", "rules", "services", "phone-number", "website-widget", "contact-details", "home", "integrations"],
  keywords: ["agent settings", "receptionist settings", "greeting", "welcome message", "call transfer", "forward calls", "transfer number", "opening hours", "business hours", "time zone", "language", "booking", "appointments", "cancel appointment", "reschedule appointment", "caller verification", "one-time code", "keypad PIN", "recording notice", "AI disclosure", "business summary"],
};

export default article;
