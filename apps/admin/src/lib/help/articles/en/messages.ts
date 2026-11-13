import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "messages",
  title: "Messages",
  section: "general",
  summary: "Read and answer texts, website chats and the messages your AI receptionist took on calls, and join a website chat when a visitor asks for a person.",
  screenPaths: ["/messages"],
  location: ["Sidebar", "General", "Messages"],
  access: "Everyone on the team can read conversations. Owners, admins and schedulers can reply, take over a website chat and hand it back to the receptionist. Viewers see the reply box and the chat buttons, but their replies and take-overs are refused. Only owners and admins can archive and restore conversations.",
  purpose: [
    "Messages is your team's inbox. Each row is one conversation with one person: a text thread with your business number, a chat from the website widget, or a call on which the receptionist took a message for your team, such as a callback, an appointment request or a request to cancel an appointment. The conversation with the newest message is at the top.",
    "Your AI receptionist answers website chats, but it never answers texts. When someone texts your business number, a person on your team reads the text here and replies by hand. Replies to texts, and to messages the receptionist took on calls, go out as texts from your business number.",
    "Your team can step into any open website chat. When **Let visitors chat with your team** is turned on for the website widget, a visitor can also ask for a person, and the chat waits here for someone to join.",
    "When the business has several AI agents, each conversation names its receptionist: the one that answered the chat or call, or the one whose phone number was texted. You can filter the list by receptionist.",
  ],
  areas: [
    { name: "Filters", description: "Above the list. **All** shows every conversation that isn't archived. **Web** shows website chats. **SMS** shows texts and the calls on which the receptionist took a message. **Archived** shows the archived conversations of every kind, or **No archived conversations** when there are none." },
    { name: "Receptionist filter", description: "Shows only the conversations of one receptionist, or **All receptionists**. You see it only when the business has several AI agents, and with eight or more receptionists its list of choices starts with a search box. The choice stays in the page's address, so a reload or a shared link keeps it." },
    { name: "Search conversations...", description: "Finds conversations by the person's name or phone number, the email a website visitor gave, or words in the latest message. It searches within the filters you chose." },
    { name: "Conversation list", description: "Each row shows the person's name or, when no name is known, their phone number, the email a website visitor gave, or a label such as **Website visitor** or **Phone caller**. It also shows when the latest message came (the time for today, **Yesterday**, or the date) and the start of that message. A small robot icon marks a website chat, **Closed** marks a website chat that has ended, and **Wants a person** marks a visitor waiting for your team. With several AI agents and **All receptionists** chosen, the row also names the receptionist. **Load more** at the bottom shows the next 50 conversations." },
    { name: "Conversation header", description: "The person's name and, under it, their phone number, the email a website visitor gave, or **No contact channel saved**. With several AI agents, it also shows **Receptionist:** followed by its name. In an open website chat, a badge shows who is answering, beside the buttons that apply. **AI Active** means the receptionist answers, and **Take over** lets you step in. **Visitor waiting** means a visitor asked for a person: **Join chat** gives you the chat, and **Resume AI** hands it back to the receptionist without joining. **Pause AI** is a status, not a button: your team has the chat and the receptionist stays quiet there, and **Resume AI** hands it back. A website chat that has ended shows **Closed** instead, without these buttons. Owners and admins also see **Archive**, or **Restore** in an archived conversation." },
    { name: "Notice line", description: "A line under the header explains anything that affects replies: the chat is closed, with **Open new chat** when the visitor has started another one, a visitor is waiting for a person, or the person can't get texts, with the reason. An archived conversation also says **Archived on** and the date, and that a new message brings it back." },
    { name: "Thread", description: "The messages, oldest at the top, each with its time, and its date when it came before today. The person's messages, and messages the receptionist took for your team on a call, are on the left. Replies from the receptionist and from your team, and automatic replies, are on the right. Under each text sent from your business, its delivery shows: **Sending**, **Sent**, **Delivered**, **Not delivered** or **Failed to send**, with the reason when it failed. Until you open a conversation, this side reads **Select a conversation to review the thread**." },
    { name: "Reply box", description: "At the bottom of an open conversation. Type your reply and select **Send**, the arrow button. The box reads **Reply via SMS...** in a text conversation or a call, and **Reply via Web...** in a website chat. When a reply can't reach the person, the box is turned off and reads **This chat is closed** or **You can't text this contact**." },
  ],
  fields: [
    {
      title: "Reply box",
      description: "At the bottom of an open conversation. The box you see depends on the kind of conversation.",
      fields: [
        { name: "Reply via SMS...", requirement: "required", description: "Your reply in a text conversation, or to a message the receptionist took on a call. It goes to the person as a text from your business number. **Send** stays off until you type something, and the box is turned off when the person can't get texts." },
        { name: "Reply via Web...", requirement: "required", description: "Your reply in a website chat. The visitor sees it in the chat on your website with the first name on your account, never your email. Sending it takes the chat over, so the receptionist stops answering there. The box is turned off once the chat is closed." },
      ],
    },
  ],
  tasks: [
    {
      title: "Reply to a text",
      steps: [
        "Open **Messages** in the sidebar and select **SMS**.",
        "Select the conversation.",
        "Type your reply in **Reply via SMS...** and select **Send**.",
        "Watch the line under your reply. It changes from **Sending** to **Sent**, then to **Delivered** when the person's phone gets it.",
      ],
    },
    {
      title: "Follow up on a message the receptionist took on a call",
      steps: [
        "Open **Messages** and select **SMS**, which lists texts and the calls on which the receptionist took a message.",
        "Select the conversation. The message is on the left and says what the caller needs, such as a callback or an appointment request.",
        "Call the person back, or type a reply in **Reply via SMS...** and select **Send** to answer by text.",
        "When it's handled, open the call from **Action required** on **Home** or from the **Calls** screen, and select **Mark done** on its **Details** tab. Replying here doesn't clear it from **Action required**.",
      ],
    },
    {
      title: "Answer a visitor who asked for a person",
      steps: [
        "Open **Messages** and look for **Wants a person** in the list.",
        "Select the conversation. The badge reads **Visitor waiting**, and the receptionist has stopped answering.",
        "Within 3 minutes, select **Join chat**, or type a reply and select **Send**. Either one gives you the chat, and the badge changes to **Pause AI**.",
        "When you're done, select **Resume AI** to hand the chat back to the receptionist.",
      ],
    },
    {
      title: "Take over a website chat",
      steps: [
        "Open the chat. The badge reads **AI Active** while the receptionist answers.",
        "Select **Take over**. The badge changes to **Pause AI**, and the receptionist stops answering.",
        "Write to the visitor in **Reply via Web...** and select **Send**.",
        "Select **Resume AI** when the receptionist should answer again.",
      ],
    },
    {
      title: "Archive a conversation",
      steps: [
        "Open the conversation and select **Archive** at the right of its header.",
        "Read **Archive this conversation?** and confirm with **Archive conversation**, or select **Cancel** to keep it.",
        "**Conversation archived.** shows, and the conversation leaves the list. Nothing is deleted.",
      ],
    },
    {
      title: "Find and restore an archived conversation",
      steps: [
        "Select **Archived** above the list. Search works here too.",
        "Open the conversation. A line under its header says when it was archived.",
        "Select **Restore**. **Conversation restored.** shows, and the conversation goes back to your other conversations.",
      ],
    },
  ],
  notes: [
    "Every text waits for your team, because the receptionist never answers texts. Each person chooses the alerts they get for this screen: **New text message** and **Voice message captured** on the **Notifications** screen, and **New website chat message** and **Visitor asking for a person** on the **Website widget** screen. **New website chat message** comes at most once per chat each day.",
    "A reply by text only goes out when the person can get texts from you: they agreed to texts or texted this conversation themselves, they haven't texted STOP, they aren't blocked, and your business has a number that can send texts. When one of these is missing, the reply box is turned off and the notice line says why.",
    "When your business has more than one phone number, replies by text go out from its newest number that can send texts, which may not be the number the person texted.",
    "Writing in a website chat takes it over, and the receptionist stops answering there. It answers again when someone selects **Resume AI**, or when the visitor writes after your team has said nothing for 10 minutes.",
    "When a visitor asks for a person, the receptionist stops answering and your team has 3 minutes to reply or select **Join chat**. After that, the receptionist takes the chat back and offers to take a message. The first person to join keeps the chat.",
    "Visitors can ask for a person only during the **Opening hours** set on **AI settings**, or at any time when none are set, and only on a website widget with **Let visitors chat with your team** turned on. **Take over** works in any open website chat.",
    "A website chat closes when the visitor writes again after a day without messages. It also closes when the visitor starts chatting with a different receptionist, unless your team has the chat or the visitor is waiting for your team. The visitor no longer sees a closed chat, so it takes no replies. When they started a new chat, **Open new chat** opens it.",
    "Archiving only hides a conversation: from this list and, for a website chat your team has or a visitor is waiting in, from **Action required** on **Home**. Its messages are kept, whoever had a website chat keeps it, and a new message brings the conversation back to the list.",
    "A person who texts HELP or START gets a standard automatic reply, which shows in the thread. A blocked contact gets none, and neither does someone who texted STOP and then sends HELP.",
    "A person who texts STOP gets no more texts from your business until they text START. A text that is only UNSUBSCRIBE, END, QUIT, CANCEL or STOPALL works like STOP, and one that is only UNSTOP or SUBSCRIBE works like START. So a customer who texts just the word Cancel about an appointment also stops getting texts.",
    "When the receptionist takes a message or a request on a call, from a phone or a browser, it shows here in a conversation with the caller, and **Home** lists it under **Action required**. A message the receptionist takes in a website chat goes only to **Action required**, not into the chat.",
    "The list and the open conversation update by themselves as messages come in. A conversation shows its newest 500 messages.",
    "On a phone, the list fills the screen. Open a conversation to read it, and use the back arrow to return to the list.",
    "After a while, the text of old messages may be cleared, and how long it's kept can depend on your plan. A cleared message reads **[content expired]**, and the conversation stays.",
  ],
  troubleshooting: [
    {
      question: "The reply box says You can't text this contact. Why?",
      answer: "The notice line under the header gives the reason: the contact has no phone number, is blocked, texted STOP, hasn't agreed to texts or texted you in this conversation, or your business has no number that can send texts. If that changes while you're writing, selecting **Send** shows the reason instead, and the box turns off. An owner or admin can unblock a contact on the **Contacts** screen. A contact who texted STOP gets texts again only after they text START.",
    },
    {
      question: "My text shows Failed to send or Not delivered. What happened?",
      answer: "Under a text that failed, the reason shows. **This number can't get texts** means the phone number can't receive texts. **Your business's number isn't allowed to text this country** means your number can't send texts there. For **The text couldn't be sent**, try a shorter message, or send it again later. The reason can also be one the notice line gives, such as a contact who texted STOP before the text went out. **Not delivered** means the text went out but never reached the phone.",
    },
    {
      question: "Why can't I reply in this website chat?",
      answer: "The chat is **Closed**. The visitor's chat window no longer shows it, so they would never see your reply, and **This chat is closed, so your reply wasn't sent** shows if you try. When the visitor started a new chat, select **Open new chat** and reply there.",
    },
    {
      question: "A website visitor's message has no answer from the receptionist. Why?",
      answer: "The receptionist didn't reply to it, for example because your business has used all the website chats your plan includes, or because the reply failed. The visitor's message still reaches this screen, so answer it yourself in **Reply via Web...**, which takes over the chat. The **Plan** screen shows what your plan includes.",
    },
    {
      question: "Take over or Join chat shows Couldn't update the handoff state. Why?",
      answer: "Viewers can read conversations but can't take over chats or reply, and a reply from a viewer shows **Couldn't send your message**. Ask an owner, admin or scheduler to take over the chat, or ask an owner or admin to change your role on the **Team** screen. If your role allows it, try again in a moment. When the chat closed in the meantime, the message reads **This chat is closed, so it can't be taken over** instead.",
    },
    {
      question: "Why don't I see Archive?",
      answer: "Only owners and admins can archive and restore conversations, because archiving hides a conversation from the whole team.",
    },
    {
      question: "Archiving shows Couldn't archive the conversation.",
      answer: "The change didn't go through, and the conversation is where it was. Try again in a moment. **Couldn't restore the conversation.** means the same for **Restore**.",
    },
    {
      question: "A conversation I archived came back. Why?",
      answer: "A new message in an archived conversation brings it back, whether it comes from the person, the receptionist or your team, so nothing your team should see stays hidden. Archive it again when it's finished.",
    },
    {
      question: "Why didn't the receptionist answer a text?",
      answer: "The receptionist answers phone calls and website chats only. Texts to your business number wait here for your team to reply.",
    },
    {
      question: "I can't find a conversation.",
      answer: "Check the filters: **Web** and **SMS** each show one kind of conversation, and archived conversations only show under **Archived**. With several AI agents, set the receptionist filter to **All receptionists**. Search looks only at names, phone numbers, the emails website visitors gave and the latest message of each conversation. A call shows here only when the receptionist took a message on it: find other calls on the **Calls** screen. The list stays empty until the first text, website chat or message taken on a call.",
    },
  ],
  related: ["contacts", "contact-details", "website-widget", "notifications", "home", "calls", "call-details", "ai-settings", "plan"],
  keywords: ["inbox", "texts", "SMS", "text messages", "website chat", "live chat", "conversations", "reply to customers", "take over chat", "human handoff", "archive conversation", "voice messages", "callback requests", "opt out", "unsubscribe"],
};

export default article;
