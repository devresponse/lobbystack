import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "services",
  title: "Services",
  section: "agent",
  summary: "List the services your business offers and how long each one takes, so your AI receptionist can explain them and book the right appointment.",
  screenPaths: ["/agent/services"],
  location: ["Sidebar", "Agent", "Services"],
  access: "Everyone on the team can see the services. Only owners and admins can add, edit, turn off or delete them.",
  purpose: [
    "Services are what your business offers and books, such as a consultation, a haircut or a repair. The receptionist uses this list to tell callers and website visitors what you offer and to book the right appointment for each request.",
    "Each service has a name, a length in minutes and a description. The receptionist uses the length to find open times where the whole appointment fits, and the description to explain the service.",
    "Whether the receptionist books appointments itself, takes requests for your team to confirm or doesn't book at all is set with **Appointments** on the **AI settings** screen, where your opening hours are set too. When the business has several AI agents, they all offer the services on this list, and each receptionist has its own **Appointments** setting, under **Each receptionist's own**.",
  ],
  areas: [
    { name: "Search", description: "Filters the list to services whose title, description or length in minutes contains what you type." },
    { name: "Add Service", description: "Opens the form for a new service. Only owners and admins see this button." },
    { name: "Services list", description: "Shows each service's **Title**, a **Preview** of its description, or its length when it has no description, its **Status** and the date it was **Added**, in order of name. **Ready** means the receptionist offers the service, and **Disabled** means it is turned off. Owners and admins can select a row to edit the service. An empty list says \"No services added yet.\" before any service is added, and \"No matching entries found.\" when nothing matches the search." },
    { name: "More options", description: "The menu at the end of each row, for owners and admins: **Edit Service**, **Disable** or **Enable**, and **Delete**." },
    { name: "Pages", description: "Below the list, choose how many services show per page and move between pages." },
  ],
  fields: [
    {
      title: "Add Service and Edit Service",
      description: "The form that opens from **Add Service**, or when an owner or admin selects a service in the list.",
      fields: [
        { name: "Title", requirement: "required", description: "The service's name as your customers would say it, such as \"Initial Consultation\". The receptionist uses it to talk about the service and to book it. When you add a service, keep the title to 120 characters or fewer, or it may not save." },
        { name: "Duration", requirement: "required", description: "How long the appointment takes, in whole minutes, at least 1. The form starts at 30. A new service can be up to 1,440 minutes long, which is a whole day." },
        { name: "Content", requirement: "optional", description: "What the service is, what it includes, who it is for and anything the receptionist should mention, such as how to prepare. A new service's description can be up to 2,000 characters." },
        { name: "Bookable", description: "On for a new service. Only bookable services are offered. Turning it off is the same as **Disable** in the list: the service shows **Disabled** and the receptionist no longer offers it." },
      ],
    },
  ],
  tasks: [
    {
      title: "Add a service",
      steps: [
        "Open **Services** in the sidebar.",
        "Select **Add Service**.",
        "Enter a **Title** and the **Duration** in minutes.",
        "In **Content**, describe the service so the receptionist can explain it.",
        "Leave **Bookable** on and select **Save**.",
      ],
    },
    {
      title: "Edit a service",
      steps: [
        "Select the service in the list, or open **More options** at the end of its row and select **Edit Service**.",
        "Change what you need and select **Save changes**.",
      ],
    },
    {
      title: "Stop offering a service for a while",
      steps: [
        "Open **More options** at the end of the service's row.",
        "Select **Disable**. The status changes to **Disabled** and the receptionist stops offering the service.",
        "To offer it again, open the same menu and select **Enable**.",
      ],
    },
    {
      title: "Delete a service",
      steps: [
        "Open **More options** at the end of the service's row and select **Delete**.",
        "Confirm with **Delete**. The receptionist stops offering the service, and appointments already booked for it still show it.",
      ],
    },
  ],
  notes: [
    "Changes reach the receptionist within moments, for calls that start after you save and for the next message in a website chat.",
    "The receptionist only sees the services that are turned on. A **Disabled** service isn't offered or booked, but it stays in this list so you can turn it on again.",
    "When the receptionist books appointments itself, it offers only start times where the whole **Duration** fits inside your opening hours and the time is free. Until you add opening hours on the **AI settings** screen, it takes a message instead of booking.",
    "With no services in the list, the receptionist can still describe what you offer from your **Knowledge**, and take appointment requests when **Appointments** is set to **Takes requests**, but it can't look up open times or book an appointment itself.",
    "Give each service a clear title of its own, the way customers ask for it. The receptionist picks the service from this list by its title when it checks open times or books.",
    "Up to 40 services that are turned on also show on your business's public page, with how long each one takes, when **Services** is turned on under **What the page shows** on the **Public profile** screen.",
    "A deleted service can't be brought back, but you can add a new service with the same title.",
    "The screen lists up to 100 services, in order of name.",
  ],
  troubleshooting: [
    {
      question: "The receptionist doesn't offer a service. What can I check?",
      answer: "Make sure the service shows **Ready**, not **Disabled**. Then check on the **AI settings** screen that **Appointments** is set to **Books appointments** or **Takes requests** for the receptionist that was asked, and that your opening hours are set. When it books appointments itself, the receptionist offers only times where the whole **Duration** fits inside your opening hours, so a long service may have no open time on a short day.",
    },
    {
      question: "Saving a service fails with \"Something went wrong. Please try again.\" What can I check?",
      answer: "Check the limits for a new service: a **Title** of up to 120 characters, a **Duration** of up to 1,440 minutes and **Content** of up to 2,000 characters. Also check that no other service, even a disabled one, has nearly the same title: two titles clash when they differ only in capital letters, spaces, punctuation or letters outside A to Z, such as accented letters, and titles with no letters from A to Z or digits all count as the same. Then select **Save** again.",
    },
    {
      question: "Why can't I see the Add Service button?",
      answer: "Only owners and admins can change services. Ask an owner or admin of the business to make the change, or to change your role on the **Team** screen.",
    },
    {
      question: "The screen says \"Service catalog is unavailable.\" What now?",
      answer: "The list couldn't load. Refresh the page, and if it keeps happening, check your connection and try again later.",
    },
  ],
  related: ["ai-settings", "appointments", "knowledge", "public-profile", "rules"],
  keywords: ["service catalog", "service list", "offerings", "appointment types", "booking", "duration", "bookable", "products", "treatments"],
};

export default article;
