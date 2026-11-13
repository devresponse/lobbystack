import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "website-widget",
  title: "Website widget",
  section: "manage",
  summary: "Put a chat with your AI receptionist on your website: create a widget, choose how it looks, what it asks and who answers it, copy its snippet, and choose your own alerts for website chats.",
  screenPaths: ["/settings/widget"],
  location: ["Sidebar", "Manage", "Website widget"],
  access: "Everyone on the team can open **Website widget**, see the widgets and copy their snippets. Only owners and admins can create, change, pause, resume or revoke a widget: others see the same forms, but saving tells them they don't have access. Each person sets their own website chat alerts at the bottom of the screen.",
  purpose: [
    "The website widget puts a chat button on your website. Visitors select it to chat with your AI receptionist, which answers their questions and can book appointments the way it does on calls. The widget can also ask visitors for their contact details, offer a call from the browser, and bring someone from your team into the chat when a visitor asks for a person.",
    "Each widget has its own key, its own list of websites where its chat can run, its own look and its own settings. You add a widget to your website by pasting its embed snippet, a short line of code, into your pages. Make one widget for each website, or for each part of a website that needs different settings.",
    "When the business has several AI agents, each widget names the receptionist that answers its chats and calls, so a website for one location can reach that location's receptionist. A new widget starts with the default receptionist.",
    "The bottom of the screen holds your own alerts for website chats. Each person on the team chooses theirs, and your choices never change what anyone else gets.",
  ],
  areas: [
    { name: "Widget key created", description: "Shown at the top of the screen after you create a widget. It shows the new key with **Copy**, the embed snippet with **Copy embed snippet**, and **Done** to close it. You can copy the snippet again later from the widget's card." },
    { name: "Create a widget key", description: "The form for a new widget, with **Create widget key** at the bottom. When creating new widgets isn't available for the business, a notice titled **New website widgets are not available yet** shows in its place. Widgets you already have keep working, and you can still change or pause them." },
    { name: "Widget keys", description: "One card for each widget, newest first, under your business's name. **Refresh** reloads the list, which says **No widget keys yet.** until you create a widget, and **Widget keys are unavailable.** when it can't load." },
    { name: "Widget card", description: "Each card shows the widget's label, or **Untitled widget**, and its status: **Active**, **Paused** or **Revoked**. Below are the widget's settings, with a reminder that color and position changes take about two minutes to reach your website, then its **Embed snippet** with **Copy embed snippet**, **Save**, and, once the widget has been used, **Last used** with the date a visitor last opened its chat." },
    { name: "Pause, Resume and Revoke", description: "The buttons at the top of each card. **Pause** turns a widget off for now and **Resume** turns it back on. **Revoke** turns it off for good, after you confirm. A revoked widget keeps its card, without a snippet or these buttons." },
    { name: "Channels", description: "Your own **Email** and **SMS** switches, the same ones as on the **Notifications** screen. While a channel is off, its column disappears from the table below and you get nothing that way." },
    { name: "Communication", description: "Your alerts about website chats: **New website chat message** and **Visitor asking for a person**. Tick the box in the **Email** or **SMS** column to get an alert that way." },
  ],
  fields: [
    {
      title: "Create a widget key",
      description: "The same settings show on each widget's card under **Widget keys**, where you change them and select **Save**.",
      fields: [
        { name: "Label", requirement: "optional", description: "A name your team sees here and in the widget list on the **Public profile** screen, such as `Main website`. Visitors never see it. Only the first 120 characters are kept. A widget created without a label shows as **Untitled widget**. Once a widget has a label, emptying the field and saving keeps the old one." },
        { name: "Allowed origins", requirement: "conditional", description: "The websites where this widget's chat can run, separated by commas, such as `https://example.com, https://www.example.com`. Each entry covers every page of that website, and an address typed without `https://` gets it added. The field may start with the app's own address: replace it with your website's. Needed to create a widget: **Create widget key** stays greyed out while the field is empty. On a widget's card the field can be saved empty, and then no website can run the chat." },
        { name: "Accent color", description: "The color of the chat button and of the chat's highlights. Pick it with the color box, and the color's code shows beside it. It starts with a default color." },
        { name: "Position", description: "Where the chat button sits on your pages: **Bottom right**, the default, **Bottom left** or **Bottom center**." },
        { name: "Title", requirement: "optional", description: "The name at the top of the chat, such as `Chat with us`. Left empty, the chat shows your business name. Up to 160 characters." },
        { name: "Subtitle", requirement: "optional", description: "A short line under the title, such as `We reply within a few minutes`. Left empty, no line shows. Up to 320 characters." },
        { name: "Greeting", requirement: "optional", description: "A first message the chat shows under its welcome line before the visitor writes, such as `Hi there. How can we help?` Left empty, the chat opens with the welcome line alone. Up to 400 characters." },
        { name: "Language", description: "The language of the chat's own words, such as its buttons and notices. **Visitor's language**, the default, uses the first of the visitor's browser languages that the chat comes in. If the chat comes in none of them, it uses the business's default language from the **AI settings** screen when the chat comes in that one, and English otherwise. Choose **English**, **French**, **Spanish** or **Serbian** to always use that one. The receptionist starts replying in the chat's language and switches when the visitor writes in another language or asks for one." },
        { name: "Ask visitors for their contact details", description: "Off to start with. When it's on, the chat shows a **Leave your details** button after the visitor's first message, which opens a form for their name, email and phone number. Ticking it shows **Require email**, **Require phone** and **Ask before chat**. On a widget's card, this box is **Enabled** under **Lead form**." },
        { name: "Require email", description: "The contact form then needs a valid email address before the visitor can send it. Visitors can still select **Skip**." },
        { name: "Require phone", description: "The contact form then needs a valid phone number before the visitor can send it. Visitors can still select **Skip**." },
        { name: "Ask before chat", description: "The contact form shows as soon as the visitor opens the chat, before their first message, instead of waiting behind **Leave your details**. The visitor can fill it in, select **Skip**, or just send a message, which puts it away. While it shows, the welcome line and **Greeting** wait until the visitor sends the form or selects **Skip**." },
        { name: "Let visitors chat with your team", description: "Off to start with. During opening hours, a visitor who asks for a person gets someone from your team in the chat. Your team gets an alert and replies from **Messages**, and if nobody replies within 3 minutes, the receptionist offers to take a message." },
        { name: "Receptionist", description: "Shown when the business has several AI agents. The receptionist that answers this widget's chats and calls. While it's paused, the default receptionist answers them, and a note under the field says so. If the receptionist chosen was archived, the default receptionist answers, and a note asks you to pick another one. A revoked widget doesn't show it." },
      ],
    },
    {
      title: "Lead form",
      description: "On each widget's card, the contact details settings sit together under **Lead form**.",
      fields: [
        { name: "Enabled", description: "The same as **Ask visitors for their contact details** on the form for a new widget. Tick it to show the contact form, then choose **Require email**, **Require phone** and **Ask before chat**, and select **Save**." },
      ],
    },
    {
      title: "Channels",
      description: "At the bottom of the screen. These are your own settings and save as soon as you change them. If a change can't be saved, you see \"Notification preferences were not saved.\" and can try again.",
      fields: [
        { name: "Email", description: "Receive your alerts by email, at the address you sign in with. It starts on." },
        { name: "SMS", description: "Receive your alerts by text message on your mobile phone. The first time you turn it on, it asks you to confirm your mobile number with a code or, if your number is already confirmed, to agree to alert texts. Once you've agreed in this business, it turns on and off without asking again, as long as your number stays the same. It is greyed out with \"Unavailable. This workspace has no alert SMS sender.\" when the business has no number that alert texts can be sent from." },
      ],
    },
    {
      title: "Communication",
      description: "Tick the box in the **Email** or **SMS** column to get an alert that way. Each column shows only while its channel is on. Both alerts start ticked in the **Email** column and not in the **SMS** column.",
      fields: [
        { name: "New website chat message", description: "When a visitor sends a message through your website widget. You get at most one alert per chat each day." },
        { name: "Visitor asking for a person", description: "When a website visitor asks to talk with someone from your team. Reply from **Messages** within 3 minutes to join the chat." },
      ],
    },
  ],
  tasks: [
    {
      title: "Put a chat on your website",
      steps: [
        "Open **Website widget** in the sidebar.",
        "Under **Create a widget key**, enter a **Label**, such as the website's name.",
        "In **Allowed origins**, enter your website's address, such as `https://example.com`. Add every address the website uses, separated by commas.",
        "Choose the color, position, words and options you want.",
        "Select **Create widget key**.",
        "Under **Widget key created**, select **Copy embed snippet**, then select **Done**.",
        "Paste the snippet into every page that should show the chat, or into the place your website builder takes custom code for all pages, and publish your website.",
        "Open your website, select the chat button and send a test message. The chat shows on the **Messages** screen.",
      ],
    },
    {
      title: "Change a widget",
      steps: [
        "Find the widget's card under **Widget keys**.",
        "Change its settings.",
        "Select **Save**. **Saved** shows beside the button.",
        "Your website picks up the change with the snippet it already has. Color and position changes can take about two minutes to show.",
      ],
    },
    {
      title: "Copy a widget's snippet again",
      steps: [
        "Find the widget's card under **Widget keys**.",
        "Under **Embed snippet**, select **Copy embed snippet**. The button reads **Snippet copied**.",
      ],
    },
    {
      title: "Ask visitors for their contact details",
      steps: [
        "Find the widget's card under **Widget keys**.",
        "Under **Lead form**, tick **Enabled**.",
        "Tick **Require email** or **Require phone** if the form must have them, and **Ask before chat** to show the form as soon as the chat opens.",
        "Select **Save**. Details that include an email address or phone number add the chat to a contact on the **Contacts** screen.",
      ],
    },
    {
      title: "Let visitors chat with your team",
      steps: [
        "On the widget's card, tick **Let visitors chat with your team** and select **Save**.",
        "At the bottom of the screen, under **Communication**, make sure **Visitor asking for a person** is ticked in the **Email** or **SMS** column. Each person on the team chooses their own.",
        "When the alert comes, open the chat on the **Messages** screen and reply within 3 minutes. Otherwise the receptionist offers to take a message.",
      ],
    },
    {
      title: "Pause or resume a widget",
      steps: [
        "Select **Pause** on the widget's card. Its status changes to **Paused**, and the chat stops working on your website.",
        "To turn it back on, select **Resume**.",
      ],
    },
    {
      title: "Revoke a widget",
      steps: [
        "Select **Revoke** on the widget's card.",
        "Confirm. Its status changes to **Revoked**, and websites that use its snippet stop showing a working chat.",
        "Remove the snippet from your website, or replace it with a new widget's snippet. A revoked widget can't be turned back on.",
      ],
    },
    {
      title: "Choose who answers a widget",
      steps: [
        "Find the widget's card. **Receptionist** shows only when the business has several AI agents.",
        "Choose the receptionist in **Receptionist**.",
        "Select **Save**.",
      ],
    },
    {
      title: "Get alerts for website chats",
      steps: [
        "At the bottom of the screen, under **Channels**, turn on **Email**, **SMS** or both.",
        "Under **Communication**, tick **New website chat message**, **Visitor asking for a person** or both, in the **Email** or **SMS** column.",
        "Each change saves as soon as you make it.",
      ],
    },
  ],
  notes: [
    "Anyone can see a widget's key in your website's code. That's expected: only the websites in **Allowed origins** can run the chat, and your public page can run the widget chosen for it on the **Public profile** screen while the page is published.",
    "A website has to match an entry in **Allowed origins** exactly. An address with www and one without it are different, and so are http and https, so list each one your website uses.",
    "On a website with the snippet of a paused or revoked widget, the chat button still shows, but the chat says the widget is not available.",
    "Changes reach your website without a new snippet. Color and position take up to about two minutes, and the other settings apply the next time a page with the chat loads.",
    "Website chats show on the **Messages** screen, where your team can read them, reply and take over. A chat closes when the visitor writes again after a day without messages.",
    "Chatting with your team works during the opening hours set on the **AI settings** screen, or at any time when no hours are set. The visitor sees the first name of the person who joins. If your team goes quiet for 10 minutes, the receptionist answers the visitor's next message.",
    "When a visitor's contact details include an email address or phone number, the chat is added to a contact on the **Contacts** screen: a new one, or the contact that already has that email or phone number. An existing contact isn't changed by what the visitor typed. A name alone doesn't make a contact.",
    "The chat offers a call from the browser when the business has a phone number, calls from the browser are available for your account and the business has voice minutes left. These calls use voice minutes like phone calls do. A line under the call button says calls are answered by an AI assistant and are recorded and transcribed, unless **Tell callers about AI and recording** is turned off on the **AI settings** screen.",
    "When the business has used all the website chats its plan or packs include, chats the receptionist already answers keep getting replies, but it doesn't answer new ones, and those visitors are told your team will reply. Their messages still reach **Messages** and still send alerts.",
    "With several AI agents, the widget's receptionist answers chats on your website. Your business page is answered by the default receptionist, and choosing another one under **You're talking to** opens that receptionist's own page, where it answers. A widget's **Greeting** shows only when the widget's own receptionist answers.",
    "This screen is also the **Website widget** tab in **Settings**.",
  ],
  troubleshooting: [
    {
      question: "The chat button doesn't show on my website. What can I check?",
      answer: "Check that the snippet is on the page and that your website builder published the change, then reload the live page rather than a preview. The button shows wherever the snippet is, even when the website isn't in **Allowed origins** or the widget is paused or revoked: those problems show inside the chat once it's opened.",
    },
    {
      question: "The chat says \"This website is not authorized to load this widget.\" Why?",
      answer: "The website's address isn't in the widget's **Allowed origins**, or it's listed differently, such as without www or with http instead of https. Add the exact address your browser shows, select **Save** and reload your website.",
    },
    {
      question: "The chat says \"This widget is not available.\" Why?",
      answer: "The widget is paused or revoked. Select **Resume** on a paused widget's card to turn it back on. A revoked widget can't be turned back on, so create a new widget and replace the snippet on your website.",
    },
    {
      question: "The chat says \"The widget could not be loaded.\" or \"Your message couldn't be sent. Please try again.\" What can I check?",
      answer: "The chat couldn't start or send just then. Reload the page and try again in a moment. If it keeps happening, check that the widget is **Active** on its card, and if the chat shows an **Error ID**, give it to support.",
    },
    {
      question: "Why don't I see Create a widget key?",
      answer: "Creating new widgets isn't available for the business right now, and a notice says so in its place. The widgets you already have keep working, and you can still change, pause or revoke them.",
    },
    {
      question: "Saving says \"You do not have access to this business.\" Why?",
      answer: "Only owners and admins can create and change widgets. Ask an owner or admin of the business to make the change, or to change your role on the **Team** screen.",
    },
    {
      question: "Why doesn't the chat offer a call?",
      answer: "The call button shows only when the business has a phone number, calls from the browser are available for your account and the business has voice minutes left. Get a number on the **Phone Number** screen, and check your minutes on the **Usage** screen.",
    },
    {
      question: "A visitor asked for a person, but nobody from the team joined. Why?",
      answer: "Check that **Let visitors chat with your team** is ticked on the widget and that the visitor asked during your opening hours. Only people who ticked **Visitor asking for a person** get an alert, and they have 3 minutes to reply from **Messages** before the receptionist offers to take a message.",
    },
    {
      question: "Visitors see \"This month's chat session limit has been reached.\" What does it mean?",
      answer: "The business has used all the website chats its plan or packs include, so the receptionist isn't answering more of them. Visitors' messages still reach **Messages**, so reply from there. On a plan, website chats start again on the first day of each month, with the other allowances, and with packs they last until each pack ends. Neither the **Usage** screen nor **What's included** on the **Plan** screen lists website chats.",
    },
    {
      question: "A widget's card has a note instead of its snippet. Why?",
      answer: "Widgets created before snippets were kept can't show theirs. The snippet already on your website keeps working. To get a snippet you can copy at any time, create a new widget and use its snippet instead.",
    },
    {
      question: "Saving a widget says \"Request failed.\" What can I check?",
      answer: "Check the lengths: the **Title** can be up to 160 characters, the **Subtitle** up to 320 and the **Greeting** up to 400. Shorten them and select **Save** again. If it still fails, check your connection and try again.",
    },
    {
      question: "Saving says \"That receptionist was archived. Refresh the page and pick another one.\" What do I do?",
      answer: "Someone archived the receptionist you picked after the screen loaded. Reload the page, choose another one in **Receptionist** and select **Save**.",
    },
    {
      question: "The list says \"Widget keys are unavailable.\" What can I do?",
      answer: "The widgets couldn't load. Select **Refresh** or reload the page. If it keeps happening, check your connection and try again later.",
    },
  ],
  related: ["public-profile", "qr-code", "messages", "notifications", "contacts", "ai-agents", "ai-settings", "phone-number", "usage", "plan"],
  keywords: ["chat widget", "website chat", "live chat", "web chat", "embed code", "embed snippet", "widget key", "chat button", "allowed origins", "lead form", "contact form", "install chat on website", "talk to a person", "chat alerts", "pause widget", "revoke widget"],
};

export default article;
