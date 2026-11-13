import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "calls",
  title: "Calls",
  section: "general",
  summary: "Review the calls made to your AI receptionist, find one by name, number or topic, listen to recordings and open a call to see what was said.",
  screenPaths: ["/calls"],
  location: ["Sidebar", "General", "Calls"],
  access: "Everyone on the team can see the calls, search them and play their recordings. Archiving a call, which hides it from this list, is done on the call's own page by owners and admins.",
  purpose: [
    "The Calls screen lists your business's calls, newest first, except the ones archived, so you can see who called, what they wanted and how each call ended.",
    "It covers phone calls to your business number and calls made in a web browser: calls from the website widget and the test calls your team makes from the dashboard.",
    "Select a call to open its page, with the transcript, the recording, the steps the call went through and any message or request the receptionist took for your team that is still open.",
    "When the business has several AI agents, the list also shows which receptionist answered each call, and you can filter it by receptionist.",
  ],
  areas: [
    { name: "Live call count", description: "At the top right, the number of calls in progress right now, beside a green dot that pulses while a call is live. It refreshes every few seconds. **Live status unavailable** means the count can't be checked at the moment; the list below isn't affected." },
    { name: "Search", description: "The **Search calls...** box finds calls by the caller's name or phone number, or by words in the call's summary or in the last thing said on the call. The list updates once you stop typing and goes back to its first page." },
    { name: "Receptionist filter", description: "With several AI agents, choose **All receptionists** or one receptionist to see only the calls it answered. The choice stays in the page's address, so reloading the page or sharing the link keeps it. With eight or more receptionists, the list of choices starts with a search box." },
    { name: "Calls list", description: "One row per call, newest first, with the columns described below. Select a row to open the call's page. When there are no calls yet, or nothing matches the search or filter, the list says **No calls match the current filters**. On a small screen, scroll the list sideways to see every column." },
    { name: "Play", description: "At the end of each row that has a recording, the play button plays it without leaving the list, and the row stays highlighted while it plays. Select it again to stop. Playing another call's recording stops the one playing. **Recording pending** means the recording is still being saved, and **No recording** means there isn't one, for example for a missed, busy or blocked call or after the recording has expired." },
    { name: "Pages", description: "Below the list, **Rows per page** sets how many calls show, from 10 to 50, and the arrows and page numbers move between pages." },
  ],
  fields: [
    {
      title: "Calls list",
      description: "The columns of the list, from left to right.",
      fields: [
        { name: "Caller", description: "The caller's saved name. Without one, it shows their phone number or email address, or **Phone caller** or **Web caller** when the caller left no details." },
        { name: "Number", description: "The caller's phone number. A browser call from a caller without a saved number shows **Web call**, and a phone call with no number to show, such as one from a hidden number, shows **No number**." },
        { name: "Purpose", description: "What came of the call: the service and time the caller booked, a booking they started but didn't confirm, or a message they left for follow-up. Otherwise it shows the summary written after the call, or why the call ended, such as no answer, a busy line, a transfer, spam or a blocked caller. A call with none of these shows the last thing said on it, and a call with nothing said shows that no final outcome was captured yet." },
        { name: "Receptionist", description: "Which receptionist answered the call. This column only shows when the business has several AI agents." },
        { name: "Time", description: "The date and time the call started." },
      ],
    },
  ],
  tasks: [
    {
      title: "Find a call",
      steps: [
        "Open **Calls** in the sidebar.",
        "Type a name, a phone number or a word from the call's summary in **Search calls...**. For a number, type its digits without spaces or punctuation.",
        "With several AI agents, choose a receptionist in the filter to narrow the list further.",
        "Select the call's row to open it.",
      ],
    },
    {
      title: "Listen to a call without opening it",
      steps: [
        "Select the play button at the end of the call's row.",
        "Select it again to stop. Playing it again starts from the beginning, and playback stops by itself at the end of the recording.",
        "To pause, move through the call or download the recording, open the call and use its **Recording** tab.",
      ],
    },
    {
      title: "See only one receptionist's calls",
      steps: [
        "Open the receptionist filter beside the search box.",
        "Choose the receptionist. The list goes back to its first page and shows only that receptionist's calls.",
        "To see every call again, choose **All receptionists**.",
      ],
    },
    {
      title: "Remove a test call from the list",
      steps: [
        "Select the call to open its page.",
        "Select **Archive**, then confirm with **Archive call**. Only owners and admins can do this.",
        "**Call archived.** shows, and you return to **Calls**, where the call no longer shows. Nothing is deleted.",
      ],
    },
    {
      title: "Open an archived call",
      steps: [
        "Open **Contacts** in the sidebar and select the caller.",
        "On their **Activity** tab, select the call marked **Archived**. Its page opens as usual.",
      ],
    },
  ],
  notes: [
    "The list updates by itself. A new call shows up as it starts, and its caller name, summary and recording fill in shortly after it ends.",
    "Phone numbers are saved with their country code and without spaces, so search for a number by its digits alone, such as 5551234.",
    "Archived calls are left out of this list and its search, but they still count on **Home**, on the **Analytics** screen and in your usage. The caller's **Activity** tab on the **Contacts** screen still lists them, marked **Archived**.",
    "Recordings, transcripts and summaries are kept for a limited time that depends on your plan. After that, the call stays in the list without them.",
    "Every call tells the caller, right after the greeting, that they're speaking with an AI and that the call is recorded and transcribed. Owners and admins can turn this off with **Tell callers about AI and recording** on the **AI settings** screen, when they tell callers another way.",
    "Calls from a blocked contact are hung up right away, and the list shows that the call was blocked. Block or unblock a caller on their page on the **Contacts** screen.",
    "Times show in your device's time zone, in the **Time format** chosen on the **Preferences** screen.",
  ],
  troubleshooting: [
    {
      question: "A call I expected isn't in the list. What can I check?",
      answer: "Clear the search box and set the receptionist filter to **All receptionists**. If you belong to several businesses, check which one is chosen at the top of the sidebar. An archived call isn't listed: open it from the caller's **Activity** tab on the **Contacts** screen.",
    },
    {
      question: "The list says No calls match the current filters, but I haven't searched. Why?",
      answer: "Either the business has no calls yet, or the list couldn't load. Check your connection and reload the page. If you belong to several businesses, check which one is chosen at the top of the sidebar.",
    },
    {
      question: "A call shows Recording pending but no recording ever comes. Why?",
      answer: "The list expects a recording for every call that wasn't missed, busy or blocked, and a recording is usually saved within a few minutes of the call ending. If the call ended a while ago and its **Recording** tab still says **No recording is available for this call**, the call wasn't recorded and no recording will come.",
    },
    {
      question: "I selected play, but I hear nothing. What can I do?",
      answer: "Check that your device's sound is on and turned up. If still nothing plays, select the button again to stop, then open the call and select **Play** on its **Recording** tab.",
    },
    {
      question: "Why does a call show a phone number or Web caller instead of a name?",
      answer: "A caller's name is saved when they give it, after the call ends. A caller who didn't give a name shows by their number, and a browser call, which has no number, shows **Web caller**.",
    },
    {
      question: "What does Live status unavailable mean?",
      answer: "The number of calls in progress couldn't be checked just now. It doesn't affect the list of calls, and the count comes back by itself once it can be checked again.",
    },
    {
      question: "Can I delete a call?",
      answer: "No, calls can't be deleted. To hide one from this list, such as a test call, an owner or admin can archive it on the call's page. Nothing is deleted, and the call can be restored.",
    },
    {
      question: "Why can't I see the Receptionist column or the receptionist filter?",
      answer: "They only show when the business has several AI agents. With one receptionist, it answers every call.",
    },
  ],
  related: ["call-details", "home", "contacts", "contact-details", "analytics", "ai-settings", "ai-agents", "preferences"],
  keywords: ["call log", "call history", "phone calls", "web calls", "recordings", "listen to calls", "play recording", "search calls", "missed calls", "live calls", "call list", "archived calls", "filter by receptionist"],
};

export default article;
