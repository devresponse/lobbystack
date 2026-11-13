import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "public-profile",
  title: "Public profile",
  section: "settings",
  summary: "Publish a web page for your business with its hours, services, location, phone number and a chat with your AI receptionist, choose what it shows, and choose which receptionists visitors can pick.",
  screenPaths: ["/settings/profile"],
  location: ["Sidebar", "Manage", "Settings", "Public profile"],
  access: "Everyone on the team can open **Public profile**, copy the page's link and open the page or its preview. Only owners and admins can change the details, publish or unpublish the page and choose its receptionists. Others see the settings greyed out, with a note that only owners and admins can change them.",
  purpose: [
    "Your public profile is a web page for your business at an address of its own. It shows your business name, what you do, your opening hours and whether you're open now, your services, your phone number, your address with a map and directions, and a chat with your AI receptionist.",
    "Share the link wherever customers look for you, such as your social media profiles, your email signature or a printed QR code from the **QR code** screen. The page stays private until you publish it: until then, only people signed in to your team can see it, as a preview.",
    "Much of what the page shows comes from the rest of your settings: the business name from **Team**, the phone number from **Phone Number**, your hours from **AI settings** and your services from **Services**. This screen holds the details only the page uses, the sections it shows and the website widget that runs its chat.",
    "When the business has several AI agents, visitors can choose who they talk to under **You're talking to**, and **Receptionists on your page** decides which receptionists they can choose and in what order. Each receptionist also has a page of its own.",
  ],
  areas: [
    { name: "Your page", description: "The page's address with **Copy link**, and **Open page** or, while the page isn't published, **Preview**, which open the page in a new tab. Below it, **Published** with the date it was published, or **Not published**, and the button that publishes or unpublishes the page." },
    { name: "Details", description: "The page's category, public email, description and address. Your business name and phone number aren't here, because they come from the rest of your settings." },
    { name: "What the page shows", description: "A switch for each of the **Phone number**, **Opening hours**, **Services** and **Map** sections. **Edit hours** opens the **AI settings** screen and **Edit services** opens the **Services** screen. A section with nothing to show stays hidden, even with its switch on." },
    { name: "Chat", description: "The website widget whose chat the page shows, or **No chat**. **Website widget settings** opens the **Website widget** screen, where you create and change widgets." },
    { name: "Save", description: "Below the cards, for owners and admins. **Save** turns on once you change something, and **Saved** shows beside it once your changes are kept. A message beside it says when something couldn't be saved." },
    { name: "Receptionists on your page", description: "Shown when the business has several AI agents. It lists the receptionists visitors can choose on the page, in order, with the default one marked **Default** and **Always first**. A paused one says it's off the page until it resumes, and with no other receptionist listed, a note says visitors don't choose. Owners and admins choose which ones are listed and their order here, and these changes save as you make them, without **Save**." },
  ],
  fields: [
    {
      title: "Details",
      fields: [
        { name: "Category", requirement: "optional", description: "What kind of business you are, such as `Dental clinic`. It shows above your business name, with your city, and in the page's title in search results. Up to 80 characters." },
        { name: "Public email", requirement: "optional", description: "An email address visitors can write to, shown with your contact details. It must be a complete address, such as `hello@example.com`." },
        { name: "Description", requirement: "optional", description: "What you do and who you help, in a few sentences. A counter under the box shows how many of the 750 characters you've used. Until you first save the page, it starts with the business summary your receptionist uses." },
      ],
    },
    {
      title: "Address",
      description: "Part of **Details**. The page shows your address with your contact details, and the map and **Directions** need at least a street address or a city.",
      fields: [
        { name: "Street address", requirement: "optional", description: "The street and number, up to 200 characters." },
        { name: "Suite, unit or floor", requirement: "optional", description: "The rest of the address, if it has more, up to 200 characters." },
        { name: "City", requirement: "optional", description: "The city or town, up to 120 characters. It also shows above your business name." },
        { name: "Province or state", requirement: "optional", description: "The province, state or region, up to 120 characters." },
        { name: "Postal code", requirement: "optional", description: "The postal code or ZIP code, up to 20 characters." },
        { name: "Country", description: "Choose your country from the list, or **No country**, the default." },
      ],
    },
    {
      title: "What the page shows",
      description: "Each switch is on to start with.",
      fields: [
        { name: "Phone number", description: "The number callers reach your receptionist on, with a button to call it. The section stays hidden until the business has a number." },
        { name: "Opening hours", description: "Your weekly hours from the **AI settings** screen, with whether you're open now. Select **Edit hours** to change them." },
        { name: "Services", description: "Your bookable services, in order of name, with how long each one takes. The page lists up to 40. Select **Edit services** to change them." },
        { name: "Map", description: "Your address on a map. The **Directions** button shows whenever the address can be found on a map, even with this switch off." },
      ],
    },
    {
      title: "Chat",
      fields: [
        { name: "Website widget", description: "The widget whose chat shows on the page, where visitors chat with your receptionist or call it from their browser when the widget allows it. The list shows your active widgets, most recently used first, by label with the date each was last used if it has been, followed by **No chat**. Widgets created before snippets were saved aren't listed. Until the page is first saved, it starts with the widget used most recently. Without an active widget to list, the card says **You don't have an active website widget yet.** in place of the list." },
      ],
    },
    {
      title: "Receptionists on your page",
      description: "Shown when the business has several AI agents. Only owners and admins see these two settings, and everyone sees the list under them.",
      fields: [
        { name: "Listed", description: "The receptionists, besides the default one, that visitors can choose on the page. Open the box and tick or clear each one. The default receptionist is always listed and always first, and a paused receptionist stays off the page until it resumes." },
        { name: "Order", description: "**Alphabetical** lists them by name after the default one, and a receptionist you add takes its place by name. **Custom** lists them in the order you set with the up and down arrows beside each one, and a receptionist you add goes last. It's the same order the receptionist lists across the dashboard use, such as on the **AI agents** screen." },
      ],
    },
  ],
  tasks: [
    {
      title: "Set up and publish your page",
      steps: [
        "Open **Settings** in the sidebar and select the **Public profile** tab.",
        "Under **Details**, enter your category, a public email if you want one, a description and your address.",
        "Under **What the page shows**, turn off any section you don't want on the page.",
        "Under **Chat**, choose the website widget for the page's chat, or **No chat**.",
        "Select **Save**, then select **Preview** to check the page. Only your team can see it for now.",
        "Select **Publish page**. Anyone with the link can now see the page.",
      ],
    },
    {
      title: "Change your page",
      steps: [
        "Change the details, switches or chat.",
        "Select **Save**. Visitors see the changes the next time they open the page.",
      ],
    },
    {
      title: "Share your page",
      steps: [
        "Under **Your page**, select **Copy link**. The button reads **Link copied**.",
        "Paste the link where you want it, such as your social media profiles or your email signature.",
        "To print the link as a QR code, open the **QR code** tab.",
      ],
    },
    {
      title: "Take your page down",
      steps: [
        "Under **Your page**, select **Unpublish page**.",
        "Visitors who open the link are now told the page doesn't exist, and only your team can open it, as a preview. Your settings are kept for when you publish it again.",
      ],
    },
    {
      title: "Choose which receptionists visitors can pick",
      steps: [
        "Under **Receptionists on your page**, open **Listed** and tick each receptionist visitors can choose.",
        "Under **Order**, choose **Alphabetical**, or choose **Custom** and move each receptionist with the up and down arrows.",
        "Each change saves as you make it. The list below shows the receptionists in the order visitors see them.",
      ],
    },
  ],
  notes: [
    "**Publish page** and **Unpublish page** also save any changes you've made in the form.",
    "A published page can be found by search engines as well as opened from its link.",
    "The page's address is made from your business name when the business is created. Renaming the business on the **Team** screen doesn't change it, so links and QR codes you've shared keep working.",
    "A widget chosen here runs on the page even when the page's address isn't in the widget's **Allowed origins**. The chat only shows once the page is published, and the preview shows a note in its place.",
    "When the widget chosen here is paused or revoked, the page shows no chat and this screen says so, with **No chat** in the list. To show a chat again, choose another widget and select **Save**, or resume the widget on the **Website widget** screen.",
    "Without a chat, a page that shows a phone number offers a panel to call your receptionist instead.",
    "With several numbers, the page shows the newest one that rings the page's receptionist, or else the newest one that rings the default receptionist, or else the newest of all. A number whose receptionist is paused rings the default receptionist meanwhile.",
    "When a website address was given while setting up the business, the page links to it with your contact details. This screen doesn't change it.",
    "When the receptionist books appointments itself and your hours are set, the page can also show **Next opening**: the earliest free time in the next 14 days for the first of your services by name.",
    "The bottom of the page says your calls and chats are answered by an AI receptionist. When the receptionist answering the page has a **Default transfer number** on the **AI settings** screen, the page usually adds that visitors can ask for a person at any time. A tool that uses an API key with `business:write` access can change when that receptionist transfers calls, and the page then says visitors can ask for a person during opening hours, or leaves that out.",
    "Visitors can switch the page between English, French, Spanish and Serbian with the language links on the page.",
    "Each receptionist's own page opens for visitors once the business page is published. Receptionists that aren't listed can still be reached from their own page address, website widgets, phone numbers and QR links.",
  ],
  troubleshooting: [
    {
      question: "Visitors see \"This page doesn't exist\" when they open my link. Why?",
      answer: "The page isn't published, or the link was mistyped. Select **Publish page** under **Your page**, then share the link again with **Copy link**.",
    },
    {
      question: "Saving says \"Enter an email address such as hello@example.com.\" What do I do?",
      answer: "**Public email** must be a complete email address. Fix it, or clear the field, and save again.",
    },
    {
      question: "Saving says the text has hidden characters. What do I do?",
      answer: "Text pasted from some apps carries invisible characters that can change how it reads. Type the text again, or paste it as plain text, then save.",
    },
    {
      question: "Saving says \"That widget is paused or revoked.\" What do I do?",
      answer: "The widget you chose was paused or revoked after this screen loaded. Under **Chat**, choose another widget or **No chat** and save again, or resume the widget on the **Website widget** screen.",
    },
    {
      question: "Why doesn't my page show a chat?",
      answer: "The chat shows only once the page is published, and only when **Chat** names an active website widget. If the card says the widget is paused or revoked, choose another one or resume it on the **Website widget** screen. Without any active widget, create one there first.",
    },
    {
      question: "Why is the map missing from my page?",
      answer: "The map needs **Map** turned on and an address with at least a street address or a city.",
    },
    {
      question: "Why are my hours or services missing from the page?",
      answer: "A section with nothing to show stays hidden. Set your opening hours on the **AI settings** screen and make sure your services are bookable on the **Services** screen, and check that the section's switch is on.",
    },
    {
      question: "Why can't I change anything on this screen?",
      answer: "Only owners and admins can change the public profile, and a note at the top says so. Ask an owner or admin of the business to make the change, or to change your role on the **Team** screen.",
    },
    {
      question: "Saving says \"The public profile couldn't be saved. Try again.\" What can I check?",
      answer: "Check your connection and select **Save** again. If it still fails, reload the page and make the change again.",
    },
    {
      question: "Saving says \"Some details can't be saved. Check them and try again.\" What do I do?",
      answer: "Something in the form isn't accepted. Look over the details and the address for anything unusual, such as text pasted from another app, then select **Save** again. If it keeps happening, reload the page and make the change again.",
    },
    {
      question: "The screen says \"The public profile can't be loaded right now.\" What can I do?",
      answer: "Reload the page. If it keeps happening, check your connection and try again later.",
    },
    {
      question: "I renamed the business. Why didn't the page's address change?",
      answer: "The address is kept when the business is renamed, so links and QR codes you've already shared keep working. The page itself shows the new name.",
    },
  ],
  related: ["qr-code", "website-widget", "ai-settings", "services", "phone-number", "ai-agents", "team"],
  keywords: ["business page", "public page", "profile page", "landing page", "publish page", "business listing", "page link", "share link", "page address", "preview page", "opening hours", "map", "directions", "unpublish", "receptionist page"],
};

export default article;
