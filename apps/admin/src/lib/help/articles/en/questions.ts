import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "questions",
  title: "Questions",
  section: "agent",
  summary: "See the questions your AI receptionist couldn't answer, and answer each one once so the receptionist can answer it from then on.",
  screenPaths: ["/agent/questions"],
  location: ["Sidebar", "Agent", "Questions"],
  access: "Everyone on the team can see the questions. Only owners and admins can answer or dismiss them.",
  purpose: [
    "When a caller or website visitor asks something about your business and the receptionist can't find the answer in its knowledge, the question is listed here. The list shows you what the receptionist is missing, starting with the questions people ask most.",
    "Answer a question once and your answer is added to the **Knowledge** screen as a text entry, titled with the question. The receptionist uses it on calls and chats from then on, and the question leaves the list.",
    "Dismiss a question you don't want to answer, such as one about something the receptionist shouldn't discuss, to take it off the list.",
    "When the business has several AI agents, each question shows which receptionists heard it, and you choose whether your answer is for every receptionist or only for those.",
  ],
  areas: [
    { name: "Unanswered Questions", description: "The heading of the list, with the number of open questions beside it. With a receptionist chosen in the filter, it counts the questions that receptionist heard." },
    { name: "Receptionist filter", description: "Shows when the business has several AI agents. Choose a receptionist to see only the questions it heard, or **All receptionists** to see them all. Each receptionist in the filter shows how many open questions it heard." },
    { name: "Question list", description: "Each question, with how many times it was asked and the date it was last asked. With several AI agents, **Heard by** names the receptionists that heard it, the one that heard it most first: up to two names, then how many more, with **(archived)** after a receptionist that has been archived since. The questions asked most often come first and, among those asked as often, the most recently asked. With none waiting, the list says **No unanswered questions**." },
    { name: "Answer and Dismiss", description: "The buttons beside each question, for owners and admins. **Answer** opens a box under the question for your answer, and **Dismiss** takes the question off the list." },
    { name: "Pages", description: "Below the list, choose how many questions show per page and move between pages." },
  ],
  fields: [
    {
      title: "Answer",
      description: "The box that opens under a question when you select **Answer**. **Save Answer** saves it, and **Cancel** closes the box.",
      fields: [
        { name: "Write what your receptionist should say", requirement: "required", description: "The answer the receptionist should give people who ask this question, in full sentences. **Save Answer** stays greyed out until you write something. Up to 5,000 characters." },
        { name: "Who uses this answer", description: "Shows when the business has several AI agents and a receptionist that heard the question hasn't been archived. **Every receptionist** is chosen at first. **Only the receptionist that heard it** keeps the answer for the receptionists that heard the question. When several heard it, this choice says how many, such as **Only the 2 receptionists that heard it**." },
      ],
    },
  ],
  tasks: [
    {
      title: "Answer a question",
      steps: [
        "Open **Questions** in the sidebar.",
        "Select **Answer** beside the question.",
        "Write what the receptionist should say in the box.",
        "If the business has several AI agents, choose under **Who uses this answer** whether every receptionist uses it or only the ones that heard the question.",
        "Select **Save Answer**. The question leaves the list, and a message says the answer was added to your knowledge, as a text entry on the **Knowledge** screen.",
      ],
    },
    {
      title: "Dismiss a question",
      steps: [
        "Select **Dismiss** beside the question.",
        "The question leaves the list right away, without asking you to confirm.",
      ],
    },
    {
      title: "Change an answer you saved",
      steps: [
        "Open **Knowledge** in the sidebar.",
        "Search for the question, which is the title of your answer, and select the entry.",
        "Change the **Content** and select **Save changes**.",
      ],
    },
    {
      title: "See the questions one receptionist heard",
      steps: [
        "Choose the receptionist in the filter above the list.",
        "To see every question again, choose **All receptionists**.",
      ],
    },
  ],
  notes: [
    "After a call ends, the app adds up to five questions from it that the receptionist couldn't answer. They are written as short questions in your business's language, so they may not be the caller's exact words. Website chats add their questions while the chat goes on.",
    "Questions the receptionist answered, requests it handled, such as bookings, messages or transfers, and questions that aren't about the business aren't added.",
    "When the same question is asked again, its count goes up instead of adding a new line. Questions count as the same when their words match, whatever the capital letters or punctuation.",
    "Each answer becomes a text entry on the **Knowledge** screen, titled with the question. Edit, turn off or delete it there, like any other entry.",
    "An answer reaches the receptionist within moments, for calls that start after you save it and for the next message in a website chat.",
    "A dismissed question stays off the list, even when someone asks it again. It can't be brought back, but you can always add the information on the **Knowledge** screen.",
    "Depending on your plan, a question may be deleted some time after it was last asked, like other content from calls and chats. A dismissed question asked again after that comes back to the list as a new one.",
    "If the receptionist still can't answer a question you answered, the question comes back to the list as a new one. Check that your answer on the **Knowledge** screen is turned on and says clearly what to tell people.",
    "Owners and admins also see how many questions are waiting on the **Home** screen, under **Action required**, with a link to this page.",
  ],
  troubleshooting: [
    {
      question: "Why is the list empty?",
      answer: "**No unanswered questions** means the receptionist hasn't met a question it couldn't answer, or every question has been answered or dismissed. If a receptionist is chosen in the filter, the list shows only the questions it heard: choose **All receptionists** to see them all.",
    },
    {
      question: "Why can't I see the Answer and Dismiss buttons?",
      answer: "Only owners and admins can answer or dismiss questions. Ask an owner or admin of the business to do it, or to change your role on the **Team** screen.",
    },
    {
      question: "It says someone already answered or dismissed this question. What happened?",
      answer: "Another person on your team dealt with it first. The list refreshes to show the questions still open, and an answer they saved is on the **Knowledge** screen.",
    },
    {
      question: "It says every receptionist that heard the question is archived. What now?",
      answer: "The receptionists that heard the question were archived after the list loaded, so the answer can't be kept for them only. Your answer stays in the box: select **Save Answer** again to save it for every receptionist.",
    },
    {
      question: "The receptionist still can't answer a question I answered. What can I check?",
      answer: "Find the answer on the **Knowledge** screen and check that it shows **Ready** and, with several AI agents, that it is available to the receptionist that was asked. Make the answer a full sentence that says what to tell people. A call already in progress keeps the text entries it started with, so try a new call. If the business has many text entries, turn off the ones you don't need, because each receptionist uses up to 50 of them, and answers saved on this screen come after the entries added on the **Knowledge** screen.",
    },
    {
      question: "Answering or dismissing says \"Something went wrong. Please try again.\" What can I do?",
      answer: "The answer or dismissal didn't save. Check your connection and try again. An answer you were writing stays in the box until you save it or select **Cancel**.",
    },
    {
      question: "The page says it couldn't load my unanswered questions.",
      answer: "Refresh the page to try again. If it keeps happening, check your connection.",
    },
  ],
  related: ["knowledge", "home", "ai-agents", "rules", "calls", "messages"],
  keywords: ["unanswered questions", "missing answers", "knowledge gaps", "FAQ", "train the AI", "dismiss question", "answer question", "what callers ask"],
};

export default article;
