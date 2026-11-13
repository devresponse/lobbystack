import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "notifications",
  title: "Notifications",
  section: "settings",
  summary: "Choose which events send you an alert by email or text message and, for owners and admins, who on the team can get an email after each call and what it holds.",
  screenPaths: ["/settings/notifications"],
  location: ["Sidebar", "Manage", "Settings", "Notifications"],
  access: "Everyone on the team can open Notifications and choose their own alerts. Only owners and admins see **Emails after each call**, which decides for the whole business who can get an email after each call and what it holds.",
  purpose: [
    "Alerts tell you when something needs your attention: a caller left a message, a customer sent a text, or something didn't work, such as a call transfer. This tab decides which alerts reach you, and whether they come by email, by text message or both.",
    "Notifications are personal. Each person on the team sets their own, for each business they belong to, and your choices never change what anyone else gets.",
    "Owners and admins also decide whether the team can get an email after each call, and whether that email holds a summary with a link or the whole conversation.",
  ],
  areas: [
    { name: "Channels", description: "Two switches, **Email** and **SMS**, that turn each way of reaching you on or off. While a channel is off, its column disappears from the tables below and you get nothing that way." },
    { name: "Communication", description: "Alerts about your customers, one per row under **Event**: **Voice message captured**, **New text message**, and the email after each call, which is named **Call summary** or **Call transcript** after what it holds." },
    { name: "Emails after each call", description: "For owners and admins only. Sets who on the team can get an email after each call and what it holds." },
    { name: "System issues", description: "Alerts when something didn't work: **Customer SMS notification failed**, **Calendar sync issue**, **Live call transfer failed** and **Webhook endpoint turned off**." },
  ],
  fields: [
    {
      title: "Channels",
      fields: [
        { name: "Email", description: "Receive alerts by email, at the address you sign in with. It starts on." },
        { name: "SMS", description: "Receive alerts by text message on your mobile phone. The first time you turn it on, it asks you to confirm your mobile number with a code or, if your number is already confirmed, to agree to alert texts. Once you've agreed in this business, it turns on and off without asking again, as long as your number stays the same. It is greyed out with \"Unavailable. This workspace has no alert SMS sender.\" when the business has no number that alert texts can be sent from." },
      ],
    },
    {
      title: "Communication",
      description: "Tick the box in the **Email** or **SMS** column to get an alert that way. Each column shows only while its channel is on.",
      fields: [
        { name: "Voice message captured", description: "When a caller leaves a message during a call." },
        { name: "New text message", description: "When a customer texts your business number." },
        { name: "Call summary or Call transcript", description: "An email after each call in which the caller spoke, with what happened and either a link to the call or the whole conversation. It goes by email only, so its **SMS** box is a dash, and it starts off. If your business doesn't send it to you, the row says why and you can't turn it on, though you can still turn it off." },
      ],
    },
    {
      title: "Emails after each call",
      description: "Shown to owners and admins. These choices apply to everyone on the team, and each person still turns the email on for themselves under **Communication**.",
      fields: [
        { name: "Who can get them", description: "Choose **Owners and admins**, **Everyone on the team** or **Nobody**. **Owners and admins** is the default. People you leave out stop getting the email from the next call." },
        { name: "What they hold", description: "**Summary and a link** sends the call's summary and a link to it, so the conversation stays in the dashboard behind sign-in. It is the default. **Summary and the whole conversation** adds every turn, without card or ID numbers, and copies stay in people's mailboxes even after the dashboard deletes the transcript or they leave the team. It can't be changed while **Who can get them** is **Nobody**." },
      ],
    },
    {
      title: "System issues",
      description: "Tick the box in the **Email** or **SMS** column to get an alert that way.",
      fields: [
        { name: "Customer SMS notification failed", description: "When an appointment confirmation or reminder text to a customer fails or isn't delivered." },
        { name: "Calendar sync issue", description: "When an appointment can't sync to the calendar and needs attention." },
        { name: "Live call transfer failed", description: "When the receptionist tried to transfer a caller to a person, but the transfer didn't complete." },
        { name: "Webhook endpoint turned off", description: "When the app stops sending events to one of your webhook endpoints because every delivery failed for about a day." },
      ],
    },
    {
      title: "Your mobile number",
      description: "The dialog that opens when you turn on **SMS** and your mobile number isn't confirmed yet, or when you select **Use a different number**. **Cancel** closes it and leaves **SMS** off.",
      fields: [
        { name: "Country", description: "The calling code in front of the number. Choose your country from the list, which clears the number you typed, or type a number that starts with + and the country is picked for you." },
        { name: "Mobile number", requirement: "required", description: "The mobile number that gets your alert texts. **Send code** stays off until you enter one. Sending the code means you agree to get alert texts at this number." },
      ],
    },
    {
      title: "Enter the code",
      description: "The next step of the same dialog, after **Send code**.",
      fields: [
        { name: "Code", requirement: "required", description: "The 6-digit code texted to your number. It is checked as soon as you type the last digit. A code works for 10 minutes and allows 5 tries." },
      ],
    },
  ],
  tasks: [
    {
      title: "Choose which alerts you get",
      steps: [
        "Open **Settings** in the sidebar and select the **Notifications** tab.",
        "Under **Channels**, turn on **Email**, **SMS** or both.",
        "In **Communication** and **System issues**, tick the box in the **Email** or **SMS** column for each alert you want, and clear the ones you don't want.",
        "Each change saves as soon as you make it.",
      ],
    },
    {
      title: "Turn on text message alerts",
      steps: [
        "Under **Channels**, turn on **SMS**. If no dialog opens, you agreed to alert texts in this business before, and **SMS** is on: go to the last step.",
        "If the dialog shows **Turn on SMS alerts**, your number is already confirmed: select **Turn on** and go to the last step.",
        "Otherwise, in **Your mobile number**, choose the country and enter your mobile number.",
        "Select **Send code**.",
        "Type the 6-digit code from the text. **SMS** turns on once the code is right.",
        "Tick the alerts you want by text in the **SMS** column, which starts with nothing ticked the first time.",
      ],
    },
    {
      title: "Get an email after each call",
      steps: [
        "Make sure **Email** is on under **Channels**.",
        "In **Communication**, tick the **Email** box on the **Call summary** or **Call transcript** row.",
      ],
    },
    {
      title: "Choose who can get emails after each call",
      steps: [
        "Sign in as an owner or admin and open the **Notifications** tab.",
        "Under **Emails after each call**, choose an option in **Who can get them**.",
        "Choose what the email holds in **What they hold**. Each change saves at once.",
        "Tell your team to tick the email for themselves under **Communication**, because it starts off for everyone.",
      ],
    },
    {
      title: "Stop alert texts",
      steps: [
        "Under **Channels**, turn off **SMS**.",
        "Your choices in the **SMS** column are kept. When you turn **SMS** on again in this business, they come back without the dialog.",
      ],
    },
  ],
  notes: [
    "There is no save button on this tab. Each change saves as soon as you make it.",
    "Alerts start on by email for everyone who joins the team. Text alerts and the email after each call start off.",
    "Your choices apply to the business you have open. If you belong to several businesses, set them in each one.",
    "Alerts cover the whole business. With several AI agents, you get them whichever receptionist took the call, and you can't choose alerts for one receptionist only.",
    "Alert texts come from the business's own phone number when it has one that can send texts. Otherwise they come from a number the app uses for alerts, when there is one.",
    "Your confirmed mobile number belongs to your account. In another business, turning on **SMS** only asks you to agree to alert texts and select **Turn on**, unless you choose **Use a different number**.",
    "Turning on text alerts means you agree to get them. As the dialog says, how often they come varies, message and data rates may apply, and you can reply `STOP` to opt out or `HELP` for help. You can also turn off **SMS** here at any time.",
    "Alerts about website chats, **New website chat message** and **Visitor asking for a person**, are set on the **Website widget** screen. Its **Email** and **SMS** switches are the same ones as here.",
    "The email after each call is written in each reader's dashboard language, which they choose on the **Preferences** tab, and it needs the **Email** channel on.",
    "Replying to the email after each call writes to an owner of the business, not to the caller.",
  ],
  troubleshooting: [
    {
      question: "Why is the SMS switch greyed out with \"Unavailable. This workspace has no alert SMS sender.\"?",
      answer: "The business has no number that alert texts can be sent from, so text alerts can't be turned on for anyone. Use email alerts for now. Text alerts become available once the business has its own phone number that can send texts.",
    },
    {
      question: "I don't see the Email or SMS column. Where is it?",
      answer: "Each column shows only while its channel is on. Turn on **Email** or **SMS** under **Channels**.",
    },
    {
      question: "I don't get alert emails. What can I check?",
      answer: "Check that **Email** is on under **Channels** and that the alert is ticked in the **Email** column. Alerts go to the address you sign in with, shown on the **Account** screen, so look in that inbox and its spam folder. Your choices apply only to the business you have open, so check them in each business.",
    },
    {
      question: "I turned on SMS but I don't get any texts. Why?",
      answer: "The **SMS** column starts with nothing ticked. Tick the alerts you want by text in that column.",
    },
    {
      question: "It says \"Enter a valid mobile number.\" What do I check?",
      answer: "Check that the calling code in front of the number is your country's, and that you typed the whole mobile number. You can also type the number starting with + and the country code, and the country is picked for you.",
    },
    {
      question: "The code didn't arrive. What can I do?",
      answer: "Wait a moment, then ask for a new code with **Resend**, next to **Didn't get it?**, or select **Use a different number** to check the number you typed. A new code replaces the one before.",
    },
    {
      question: "It says \"Wait 30 seconds before asking again.\" or \"Too many codes. Try again in an hour.\" Why?",
      answer: "You can ask for a new code 30 seconds after the last one. Each number can get 3 codes an hour, and each person 5 codes an hour, so after that wait up to an hour. Meanwhile, you can keep your alerts by email.",
    },
    {
      question: "It says \"Wrong code.\" or \"Code expired. Ask for a new one.\" What do I do?",
      answer: "Check the digits and type them again. A code works for 10 minutes and allows 5 tries. After that, or after \"Too many wrong codes. Ask for a new one.\", ask for a new code with **Resend**, next to **Didn't get it?**.",
    },
    {
      question: "It says \"This code no longer works. Ask for a new one.\" Why?",
      answer: "Usually the code you typed belongs to an earlier request, because each new code replaces the one before. Type the code from the latest text, or ask for a new one with **Resend**, next to **Didn't get it?**.",
    },
    {
      question: "It says \"Couldn't send the code. Try again.\" or \"Couldn't check the code. Try again.\" What do I do?",
      answer: "Something interrupted the request, such as a lost connection. Check your connection and try again.",
    },
    {
      question: "It says \"Couldn't text this number.\" What do I do?",
      answer: "The code couldn't be delivered to that number. Check that it is a mobile number that can receive texts, then select **Use a different number** and try again.",
    },
    {
      question: "It says \"Alerts come from a toll-free number. Use a US or Canadian number.\" Why?",
      answer: "The alert texts for this business can only reach US and Canadian mobile numbers. Enter a number from one of those countries, or keep your alerts by email.",
    },
    {
      question: "Why can't I tick Call summary or Call transcript?",
      answer: "Your business doesn't send you this email, and the row says why: \"Your business turned these emails off.\" or \"Your business sends these to owners and admins only.\" Ask an owner or admin to change **Who can get them**.",
    },
    {
      question: "I ticked the email after each call, but no emails come. Why?",
      answer: "Check that **Email** is on under **Channels**. The email only comes after calls in which the caller spoke, and stops if an owner or admin changes **Who can get them** so that it leaves you out.",
    },
    {
      question: "It says \"Notification preferences were not saved.\" What do I do?",
      answer: "Your last change didn't save. Check your connection, reload the page and make the change again.",
    },
    {
      question: "It says \"The settings for emails after each call were not saved.\" What do I do?",
      answer: "The choice under **Emails after each call** went back to what it was. Check your connection and choose again.",
    },
  ],
  related: ["website-widget", "team", "preferences", "account", "phone-number", "calls", "messages", "webhooks"],
  keywords: ["alerts", "email alerts", "text alerts", "SMS alerts", "notification settings", "call summary email", "call transcript email", "voice message alert", "new text alert", "verify phone", "verification code", "resend code", "not getting alerts", "stop notifications", "unsubscribe"],
};

export default article;
