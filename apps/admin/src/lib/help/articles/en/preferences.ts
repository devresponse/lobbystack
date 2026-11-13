import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "preferences",
  title: "Preferences",
  section: "settings",
  summary: "Choose the language the dashboard shows you and how it writes times, and, for owners and admins, whether this business shares anonymized usage data to help improve the app.",
  screenPaths: ["/settings/appearance"],
  location: ["Sidebar", "Manage", "Settings", "Preferences"],
  access: "Everyone on the team can open Preferences and choose their own language and time format. Only owners and admins can change **Share telemetry data**, which applies to the whole business.",
  purpose: [
    "Preferences sets how the dashboard looks to you: the language of its menus, labels and messages, and whether times show on a 24-hour clock or with AM and PM.",
    "Your language and time format are your own. Changing them doesn't change what other people on the team see, what your customers see, or the language the receptionist speaks.",
    "The last setting, **Share telemetry data**, is for the whole business. It lets the app collect anonymized usage and error data from this business to help improve the app.",
  ],
  areas: [
    { name: "Dashboard language", description: "A list of the languages the dashboard comes in. The dashboard switches as soon as you pick one." },
    { name: "Time format", description: "Choose between **24-hour** and **AM/PM** for the times shown across the dashboard." },
    { name: "Share telemetry data", description: "A switch that turns the sharing of anonymized usage and error data on or off for this business. It is greyed out for anyone who isn't an owner or admin." },
  ],
  fields: [
    {
      title: "Preferences",
      fields: [
        { name: "Dashboard language", description: "Choose **English**, **Français**, **Español** or **Srpski**. The choice is saved to your account, so the dashboard opens in that language on any device you sign in on." },
        { name: "Time format", description: "Choose **24-hour** or **AM/PM**. Until you choose, the dashboard shows AM/PM times in English and 24-hour times in the other languages. The choice is kept in this browser only." },
        { name: "Share telemetry data", description: "When it's on, the app collects anonymized usage and error data from this business, such as which screens are opened, to help improve the app. It starts on, and only owners and admins can turn it off or back on." },
      ],
    },
  ],
  tasks: [
    {
      title: "Change the dashboard language",
      steps: [
        "Open **Settings** in the sidebar and select the **Preferences** tab.",
        "Open the list next to **Dashboard language** and choose a language.",
        "The dashboard switches at once and saves the choice to your account.",
      ],
    },
    {
      title: "Show times as 24-hour or AM/PM",
      steps: [
        "Open the **Preferences** tab.",
        "Next to **Time format**, choose **24-hour** or **AM/PM**.",
      ],
    },
    {
      title: "Stop sharing telemetry data",
      steps: [
        "Sign in as an owner or admin of the business and open the **Preferences** tab.",
        "Turn off **Share telemetry data**. The change saves at once and applies to everyone on the team.",
      ],
    },
  ],
  notes: [
    "There is no save button on this tab. Each change saves as soon as you make it.",
    "Some emails follow your dashboard language too: the invitations you send from the **Team** tab are written in it, and so are the email after each call that you get and the email that confirms canceling the account.",
    "The language the receptionist speaks with callers isn't set here. It is set on the **AI settings** screen. When the business has several AI agents, a receptionist can also have a language of its own, which you can set on the **AI settings** or **AI agents** screen.",
    "The time format is kept in your browser. On another browser or device, choose it again.",
    "The light or dark look isn't on this tab. Open the menu with your email address at the bottom of the sidebar and select **Toggle theme**. Until you do, the dashboard follows your device's light or dark setting. Like the time format, your choice is kept in your browser.",
    "**Share telemetry data** is set for each business. If you belong to several businesses, each has its own setting.",
  ],
  troubleshooting: [
    {
      question: "Why is Share telemetry data greyed out?",
      answer: "Only owners and admins can change it, because it applies to the whole business. Ask an owner or admin if you want it changed.",
    },
    {
      question: "The dashboard is in a language I can't read. How do I switch it back?",
      answer: "Open **Settings** in the sidebar, the item with the gear icon, and select the fifth tab, which is **Preferences**. The first list holds the languages, and each one is written in its own language, such as **English** or **Español**, so choose yours there.",
    },
    {
      question: "It says \"We couldn't save your language preference. Please try again.\" What happened?",
      answer: "The language wasn't saved, so the dashboard went back to the one you had. Check your connection and choose the language again.",
    },
    {
      question: "It says \"We couldn't save your telemetry preference. Please try again.\" What happened?",
      answer: "The change wasn't saved, so the switch went back to where it was. Check your connection and try again.",
    },
    {
      question: "Times show in the wrong format on another computer. Why?",
      answer: "The time format is kept in each browser. Open the **Preferences** tab on that computer and choose **24-hour** or **AM/PM** there.",
    },
    {
      question: "The receptionist answers callers in the wrong language. Can I fix it here?",
      answer: "No. **Dashboard language** only changes what you see in the dashboard. Set the language the receptionist speaks on the **AI settings** screen. When the business has several AI agents, check whether that receptionist has a language of its own, under **Each receptionist's own** on the **AI settings** screen or on the **AI agents** screen.",
    },
  ],
  related: ["notifications", "team", "ai-settings", "ai-agents", "account"],
  keywords: ["language", "dashboard language", "change language", "translate dashboard", "wrong language", "time format", "24-hour clock", "12-hour clock", "AM/PM", "telemetry", "usage data", "data sharing", "appearance", "theme", "dark mode"],
};

export default article;
