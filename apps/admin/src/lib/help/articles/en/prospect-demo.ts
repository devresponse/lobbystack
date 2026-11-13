import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "prospect-demo",
  title: "Try a demo receptionist",
  section: "getting-started",
  summary: "Talk to an AI receptionist made from a business's website in a live voice call in your browser, then claim it if you want to keep it.",
  screenPaths: ["/demo", "/demo/{token}"],
  location: ["No link in the app", "Open the demo link you were sent"],
  access: "Anyone with the demo link can open this page and call the receptionist, without an account and without signing in. Claiming the receptionist needs an account.",
  purpose: [
    "A demo lets a business hear what an AI receptionist would sound like for it, before anything is set up. The app's demo operator prepares it from the business's name and website on the **Prospect demos** screen, publishes it and sends the business its link. By the time the demo is ready, the receptionist has read the website, so it can answer questions about the business the way it would answer a caller.",
    "You talk to the receptionist in a live voice call on this page, with your browser and your microphone. You don't need a phone number, an app or an account. The page suggests a few questions to ask, and you can ask anything a customer would.",
    "A demo is limited. The receptionist answers questions and can take a message, but it doesn't book appointments, transfer the call or send texts or emails. If you like what you hear, **Claim this receptionist** makes it yours: you create an account or sign in, and the business the demo was made for, receptionist included, becomes a business on your account, ready for the rest of setup.",
    "If you sent the link, this page is what the other person sees. The messages below explain why a link doesn't open the demo and what to do about it.",
  ],
  areas: [
    { name: "Top bar", description: "At the left, the app's logo opens the app's website. On the right, **Log in** and **Try for free** open the usual log-in and sign-up pages and don't claim this demo, and the question mark after them opens this help beside the page. On a phone or a narrow window, **Log in** is hidden, and the sign-up page that **Try for free** opens has **Sign in** under the form. To keep this receptionist, use **Claim this receptionist** instead." },
    { name: "Loading...", description: "Shows with a spinning circle while the page checks the demo link." },
    { name: "Demo for the business", description: "The title once the demo is ready: **Demo for** followed by the business's name. On a large screen, the suggested questions and **Claim this receptionist** sit on the left and the call button on the right. On a phone or a narrow window, the call button comes first and the questions follow." },
    { name: "Call button", description: "The large round button with a phone. Select it to call the receptionist: your browser may ask to use your microphone, a **Connecting...** button shows while the call starts, and the phone turns into a microphone as the call connects. The hint **Tap the button to start a live voice call.** shows under it, or at the bottom of the page on a large screen." },
    { name: "Hang up", description: "Shows under the call button while you're connected. Select it to end the call. Selecting the round button during the call ends it too, and the receptionist can end the call itself, for example when the conversation is over." },
    { name: "Call messages", description: "When a call can't start or is cut off, a message shows in red under the call button, such as **Microphone access was blocked.** or **The voice connection dropped.** Select the call button to try again. The troubleshooting below explains each message." },
    { name: "Try asking", description: "Under the heading **Try asking:**, up to three questions chosen for this business by the person who prepared the demo. Ask them out loud during the call, in your own words, or ask anything else about the business." },
    { name: "Limited demo notice", description: "The line **This is a limited demo. Live calls work, but booking and other full receptionist features aren't enabled.** reminds you what a demo leaves out." },
    { name: "Claim this receptionist", description: "Starts making the receptionist yours. It opens the sign-up page, where you create an account or sign in to one you have, and then the claim page, which finishes on its own. If you're already signed in to the app in this browser, it goes straight to the claim, for the account you're signed in to. Stay in the same browser tab until it's done, because the claim page finds the demo there." },
    { name: "This demo link isn't valid", description: "Shows instead of the demo when the page can't find a demo for the link: the link is cut off or mistyped, a newer link for the same demo has replaced it, or the page couldn't check it because the connection dropped. The message asks you to get a fresh link." },
    { name: "Demo being prepared", description: "Titled **The demo for** followed by the business's name and **is being prepared**. Shows until the demo is published: while the receptionist is still learning from the business's website, or before the demo is ready to share. The page keeps checking and opens the demo by itself once it's ready, so you can leave it open." },
    { name: "Demo expired", description: "Titled **The demo for** followed by the business's name and **has expired**. Shows when the demo's time is up: a demo is open for 30 days from when it was created. The message asks you to reach out for a new one." },
    { name: "Demo no longer available", description: "Titled **The demo for** followed by the business's name and **is no longer available**, with **This demo link has been turned off.** Shows when the demo has been turned off, either by the person who prepared it or by the app once its 30 days were up. The link won't work again." },
    { name: "Demo already claimed", description: "Titled **The demo for** followed by the business's name and **has already been claimed**. Shows once someone has claimed the receptionist. It says the receptionist is now owned by an account in the app, and the demo is closed to everyone else." },
    { name: "Opening secure demo link...", description: "Shows for a moment when you open an older style of demo link, and then the demo page opens by itself. Older links work the same way as new ones." },
  ],
  tasks: [
    {
      title: "Call the demo receptionist",
      steps: [
        "Open the demo link you were sent, on a computer or phone with a microphone.",
        "Select the round call button.",
        "If your browser asks to use your microphone, allow it.",
        "When the receptionist greets you, talk as you would on a phone call. The questions under **Try asking:** are a good place to start.",
        "Select **Hang up** when you're done.",
      ],
    },
    {
      title: "Let the page use your microphone",
      steps: [
        "Open your browser's settings for this page, usually from the icon beside the page's address.",
        "Allow the microphone.",
        "Reload the page and select the call button again.",
      ],
    },
    {
      title: "Keep the receptionist",
      steps: [
        "Select **Claim this receptionist**. If you're already signed in, the claim starts straight away.",
        "Create an account and enter the 6-digit code the app emails you, or select **Sign in** under the form to use an account you already have.",
        "Wait in the same browser tab while the claim page makes the receptionist yours. Setup then opens on your business's name.",
      ],
    },
    {
      title: "Check a demo link before you send it",
      steps: [
        "Open the link in your browser.",
        "Check that the page shows **Demo for** and the business's name, not a message.",
        "If it says the demo is being prepared, wait until the demo is ready and publish it on the **Prospect demos** screen, then send the link.",
        "If you call the receptionist to try it, keep it to a call or two. Your calls count toward the 5 that your browser and your internet connection can make to this demo.",
      ],
    },
  ],
  notes: [
    "A demo is open for 30 days from when it was created on the **Prospect demos** screen, however late it was published or its link was sent. After that, the page says the demo has expired, and soon after, that it is no longer available. A demo that was never published goes from being prepared to no longer available.",
    "Each demo takes up to 5 calls from the same browser and 5 from the same internet connection in a 30-day period. Only so many calls can start in an hour across everyone trying it, too.",
    "A demo has no phone number. Calls happen in your browser, so keep the page open during the call.",
    "The receptionist answers from what it read on the business's website when the demo was prepared. When it doesn't know something, it says so and offers to take a message.",
    "In a demo the receptionist only answers questions and takes messages. It doesn't book or check appointments, transfer the call, or promise texts or emails. It may ask for a name and contact details, as it would for a caller who wants a quote, and sample details are fine.",
    "Demo calls don't count toward any plan's usage, before or after someone claims the receptionist.",
    "Calls made on the demo page, including any the person who prepared it makes to check it, stay with the business, along with any messages the receptionist took on them. Whoever claims the receptionist can see them on the **Calls** and **Messages** screens.",
    "Anyone who has the link can try the demo and claim the receptionist, so share it only with the business it was made for. The page doesn't show up in search engines.",
    "For the person who sent the link: the page says the demo is being prepared until the demo is published on the **Prospect demos** screen, and then opens the demo by itself. **Rotate link** on that screen replaces the link, so older links say they aren't valid, and **Revoke** turns the demo off for good.",
    "Once someone claims the receptionist, the demo closes, and the person who prepared it leaves the business's team.",
  ],
  troubleshooting: [
    {
      question: "The page says This demo link isn't valid. What can I do?",
      answer: "Make sure you opened the whole link: the demo's code is at its end, and some email and chat apps cut long links in two. If your connection dropped while the page was loading, reload it. If the message stays, the link may have been replaced by a newer one, so ask the person who sent it for a fresh link.",
    },
    {
      question: "The page says the demo is being prepared. How long will it take?",
      answer: "Usually a few minutes, while the receptionist learns from the business's website. Leave the page open: it opens the demo by itself once it's ready. If it's still being prepared much later, ask the person who sent the link, since the demo may not have been published yet.",
    },
    {
      question: "Why does it say the demo has expired or is no longer available?",
      answer: "A demo is open for 30 days from when it was created, and the person who prepared it can turn it off sooner. Either way, the link won't work again. Ask them for a new demo.",
    },
    {
      question: "Why does it say the demo has already been claimed?",
      answer: "Someone has claimed the receptionist, so it now belongs to their account. If that was you, select **Log in** at the top of the page and sign in with the account you claimed it with. On a phone or a narrow window, where **Log in** doesn't show, select **Try for free** and then **Sign in** under the form. Otherwise, ask the person who sent the link for a new demo.",
    },
    {
      question: "Why can't I see Claim this receptionist?",
      answer: "The button shows only while the demo is open, under the suggested questions. On a phone, scroll down past the call button. When the page shows a message instead of the demo, such as that the demo is being prepared, has expired or has already been claimed, the demo can't be claimed from it.",
    },
    {
      question: "The call won't start because of my microphone. What can I check?",
      answer: "**Microphone access was blocked.** means the browser was told not to let this page use the microphone: allow it in the browser's settings for this page, reload and try again. **No microphone was found on this device.** means you need to connect a microphone or a headset. **The microphone is already in use by another app.** means another app, such as a video call, is using it: close that app and try again.",
    },
    {
      question: "It says this browser does not support microphone calls or live voice calls. What do I do?",
      answer: "Open the link in an up-to-date browser on a computer or phone that has a microphone. If you opened it from inside an email or chat app, open it in your usual browser instead.",
    },
    {
      question: "Why does it say Too many test calls have been started?",
      answer: "The demo has taken as many calls as it allows from your browser or your internet connection, which is 5 in a 30-day period, or too many calls to this demo, or to the app as a whole, have started in a short time. In that second case, try again in a little while. Otherwise, ask the person who sent the link for a new demo, or claim the receptionist, finish setup and keep trying it with **Test Call** on your dashboard, where calls count toward your plan's usage.",
    },
    {
      question: "The call stopped on its own. Why?",
      answer: "The receptionist ends a call when the conversation is over, after a long silence, or when the call reaches its time limit. If the page says **The voice connection dropped.**, your connection was lost. Select the call button to call again.",
    },
    {
      question: "It says Something went wrong while starting the call, or The call took too long to connect.",
      answer: "Check your internet connection and select the call button again. If it keeps happening, reload the page: if the demo was closed while the page was open, the page then says so. A message that the page can't reach the app also points to the connection, or to a work network that blocks calls, so try another network. **Your AI receptionist is unavailable right now.** means the call couldn't start on the app's side: try again in a few minutes.",
    },
    {
      question: "It says We couldn't find this workspace. What does that mean?",
      answer: "The business the demo was made for is no longer open in the app, so its receptionist can't take calls. Ask the person who sent the link for a new demo.",
    },
    {
      question: "The call connected, but I can't hear the receptionist.",
      answer: "Check that your device's volume is up and that sound goes to the speaker or headset you expect. Then select **Hang up** and start a new call.",
    },
    {
      question: "Can I call the demo receptionist on the phone?",
      answer: "No. A demo has no phone number, so calls happen in the browser. After you claim the receptionist, setup offers you a phone number if your plan includes one.",
    },
    {
      question: "The receptionist got something wrong about the business. Why?",
      answer: "It answers from what it read on the business's website when the demo was prepared, so it doesn't know what isn't there or what it couldn't read. After you claim it, you can add documents and other information on the **Knowledge** screen.",
    },
  ],
  related: ["claim-demo", "prospect-demos", "sign-up", "log-in", "onboarding-business", "calls", "messages", "knowledge"],
  keywords: ["demo", "demo link", "live demo", "try the receptionist", "voice demo", "browser call", "suggested questions", "demo expired", "demo link not valid", "demo being prepared", "microphone", "prospect demo", "keep the receptionist"],
};

export default article;
