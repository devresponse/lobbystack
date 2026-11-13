import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-plan",
  title: "Choose your plan",
  section: "getting-started",
  summary: "Compare the plans on offer and choose the one your business starts on, paying on a secure payment page when the plan has a price, or unlock a plan with a promo code.",
  screenPaths: ["/onboarding/plan"],
  location: ["Sign up", "Onboarding", "Step 6 of 8"],
  access: "Anyone on the team who is brought to this step can see the plans. Only owners and admins can choose a plan, pay for one, use a promo code or go on from this step.",
  purpose: [
    "This step sets how your business pays for the app. Each card shows one plan on offer: its price, what it includes, such as voice minutes, receptionists and a phone number, and a button to start it.",
    "A plan with a price opens a secure payment page. After you pay, you come back to this step, and setup goes on by itself as soon as the payment is confirmed. Nothing is charged until you pay on that page.",
    "The plan you choose decides the next step. The free plan, where one is offered, skips the phone number step and opens the last one. A paid or prepaid plan that includes a phone number goes on to the step where you pick one, and one without a number goes on to the last step.",
    "The plans, their prices and what they include can change over time, and the step always shows the current ones. After setup, you see and change your plan on the **Plan** screen.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's own logo and name, as on the sign-in page." },
    { name: "Payment messages", description: "Show at the top only when you come back from paying for a prepaid plan. **Adding your minutes...** means the step is waiting for the payment to arrive. If it hasn't arrived after about a minute and a half, the step says the payment is still processing and offers **Check again**. If the payment didn't go through, or was refunded or charged back before it arrived, a message in red says so and you can choose again." },
    { name: "Monthly and Annual", description: "Tabs for how often you pay, shown for the ways the plans on offer can be paid, and not at all when no plan is paid monthly or yearly. On **Annual** you pay for a year at once, each card shows what that costs per month, and the tab can show what you save. When plans can be bought on only one of the tabs, the other is turned off." },
    { name: "Have a promo code?", description: "A link above the plan cards that opens a box for a promo code. It shows only when plans can be bought on this step. A code that works shows the plan it unlocks, any discount and for how long, what the plan includes, and its price for each way you can pay, with a button such as **Subscribe monthly**. A price that can't be bought now says **Not on sale right now** instead." },
    { name: "Plan cards", description: "One card for each plan on offer, with its name, its price and how often it's paid, a short description, a button to start it and a list of what it includes. A card can be marked with a badge, such as **Popular**. A plan priced by agreement shows **Custom** in place of a price, and a dash in place of a price means the plan isn't sold on the tab you selected. A button you can't use is turned off." },
    { name: "Prepaid plans", description: "Where they're offered, plans paid once, with no monthly bill and no renewal, for a set number of days or with no end date. Each one's price is followed by how many days it lasts, or **paid once** when it has no end date. Their cards sit among the other plans, or follow them in a section of their own with a heading such as **Prepaid plans**, and a tab for each length when they come in several. A prepaid plan that can't be bought now has its button turned off, with the reason under it." },
    { name: "Billing email", description: "Shows only when your own email can't be used for this business's billing. It asks for another address for the business's receipts." },
    { name: "Messages under the plans", description: "Say in red when a plan couldn't start or setup couldn't go on, and why." },
    { name: "Plan comparison", description: "Where the step has one, a table under the cards, with a heading such as **Compare plans in detail**, that compares the plans feature by feature, in groups, with a column for each plan. A check mark means the plan includes the feature, and a dash means it doesn't. On a small screen, swipe the table sideways to see every plan." },
    { name: "Already on a plan", description: "Shows in place of the cards when the business already has a paid plan, for example one set up for you, with the words \"This business is already on the\" followed by the plan's name. A business with a prepaid plan sees \"This business already has a prepaid plan.\" Select **Continue** to go on." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step is the sixth. From the second dot on, the dot of a step your business has already reached opens that step." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at the step your business is on." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "Have a promo code?",
      description: "The box that opens from the **Have a promo code?** link.",
      fields: [
        { name: "Promo code", requirement: "required", description: "The code you were given: letters and digits, sometimes in groups joined by hyphens. Letter case and spaces don't matter. **Apply** stays off until you enter a code. Select **Apply** to check it, which shows **Checking...** for a moment, or **Cancel** to close the box." },
      ],
    },
    {
      title: "Billing email",
      description: "Shows only when the step asks for it.",
      fields: [
        { name: "Billing email", requirement: "required", description: "Another address for this business's receipts, asked for when your own email can't be used for its billing, for example because it's already used for another business's billing. **Continue** stays off while the field is empty. Select **Continue** to go on with it, or **Cancel** to choose again instead." },
      ],
    },
  ],
  tasks: [
    {
      title: "Choose a plan with a price",
      steps: [
        "If the step shows **Monthly** and **Annual**, select how often you want to pay. Each card's price and button follow the tab you select.",
        "Compare the cards, and the table under them if there is one.",
        "Select the button on the card of the plan you want. A spinner shows while the payment page opens.",
        "Enter your payment details on the secure payment page and pay.",
        "Wait on this step when you come back. Once the payment is confirmed, the step for picking a phone number opens.",
        "If the plan includes no phone number, this step says instead that the business is already on its plan. Select **Continue** to go on to the last step.",
      ],
    },
    {
      title: "Start on a free plan",
      steps: [
        "Where a free plan is on offer, select the button on its card.",
        "No payment is needed. Setup skips the phone number step and opens the last step.",
      ],
    },
    {
      title: "Buy a prepaid plan",
      steps: [
        "Find the prepaid plan's card. If the prepaid plans have tabs for different lengths, select the length you want.",
        "Select the button on the card, and pay on the secure payment page.",
        "Wait on this step when you come back. It shows **Adding your minutes...** until the payment arrives.",
        "The step for picking a phone number opens, or the last step if the prepaid plan includes no phone number.",
      ],
    },
    {
      title: "Use a promo code",
      steps: [
        "Select the **Have a promo code?** link above the plan cards.",
        "Enter the code in **Promo code** and select **Apply**.",
        "Check the plan the code unlocks, its discount and what it includes.",
        "Select **Subscribe monthly** or **Subscribe yearly**, then pay on the secure payment page.",
        "Wait on this step when you come back, until the next step opens.",
      ],
    },
    {
      title: "Ask about a plan priced by agreement",
      steps: [
        "Find the card that shows **Custom** in place of a price.",
        "Select its button. Your email app opens a new message to the app's contact address, so you can discuss what your business needs.",
      ],
    },
    {
      title: "Go on with the plan the business already has",
      steps: [
        "When the step says the business is already on a plan, select **Continue**.",
        "The step for picking a phone number opens, or the last step if the plan includes no phone number.",
      ],
    },
  ],
  notes: [
    "Looking at the plans changes nothing. Nothing is charged until you pay on the payment page, and leaving that page without paying brings you back to this step to choose again.",
    "A card lists what the plan includes, such as voice minutes, receptionists, a phone number and alert texts. Where a plan charges for use beyond what's included, the card shows the rate after the included amount.",
    "A plan without a phone number can't take phone calls. Its voice minutes, if it has any, are for calls made from a web browser, such as a test call to your receptionist from the dashboard. You can get a number later by moving to a plan that includes one.",
    "A prepaid plan is paid once, for the number of days its card shows or with no end date. It doesn't renew, and everything it includes lasts that whole time.",
    "If you signed up from a link that carries a promo code, the box opens with the code filled in and checked when you reach this step, as long as you use the same browser.",
    "Purchases for a business go one at a time. While the payment page for one purchase is being prepared, another purchase for the same business is refused. Wait a minute and try again.",
    "Only owners and admins can buy a plan or a prepaid plan, or use a promo code. If plans can't be bought here for your account, their buttons are turned off and the promo code link doesn't show.",
    "After setup, see your plan, change it or buy another on the **Plan** screen under **Settings**.",
  ],
  troubleshooting: [
    {
      question: "The step says \"We couldn't load the plans. Please try again.\" What can I do?",
      answer: "Select **Try again**. If the plans still don't load, you can select **Start free** to go on with setup and choose a paid plan later on the **Plan** screen.",
    },
    {
      question: "Why is the button on a plan's card turned off?",
      answer: "The plan can't be bought on the tab you selected, so try the other tab, or plans can't be bought here for your account. The buttons are also off for a moment while a payment page opens. A prepaid plan's card says why under its button, such as \"Packs can't be bought here right now.\" Only owners and admins can buy a plan. If you are one and the buttons stay off, contact support.",
    },
    {
      question: "The step says it couldn't continue, or couldn't open the payment page. What can I do?",
      answer: "Messages such as \"We couldn't continue right now. Please try again.\", \"Request failed.\" or one saying the payment page couldn't open or expired mean the plan didn't start and nothing was charged. Check your connection and select the plan's button again. If it keeps happening, contact support.",
    },
    {
      question: "I paid, but the step still shows the plans. Should I pay again?",
      answer: "No. When you come back from the payment page, the step checks for your payment and opens the next step by itself once the payment is confirmed, which can take a little while. If nothing changes after a few minutes, reload the page. If the plans still show, sign out and sign in again: setup opens at the step your business is on. When the plan step says the business is already on its plan, select **Continue**.",
    },
    {
      question: "The step says \"Your payment is still processing.\" Should I pay again?",
      answer: "No. Some payments take longer to arrive. Select **Check again** in a few minutes, and the step opens the next one once the payment is in.",
    },
    {
      question: "The step says my payment didn't go through, or was refunded or charged back.",
      answer: "No prepaid plan was added to the business. Choose a plan again, and check your payment details on the payment page.",
    },
    {
      question: "The step asks for a billing email. Why?",
      answer: "Your own email couldn't be used for this business's billing, for example because it's already used for another business's billing. Enter a different address for this business's receipts in **Billing email** and select **Continue**.",
    },
    {
      question: "The step says another purchase or plan change is in progress.",
      answer: "Someone started buying a plan or a prepaid plan for this business a moment ago, maybe in another tab. Wait a minute and try again.",
    },
    {
      question: "The step says \"Too many checkouts started.\" or \"Too many tries. Try again later.\" What now?",
      answer: "Too many payment pages were started within the hour, for plans and prepaid plans together: a business can start 10 an hour, and each person 20 across all of their businesses. Wait the number of minutes the message gives, or a little while if it gives none, then try again.",
    },
    {
      question: "My promo code doesn't work. What do the messages mean?",
      answer: "\"This code isn't valid.\" means the code is wrong or can't be used, so check its spelling. \"You're already on this plan.\" means the business has the plan the code unlocks. \"This plan isn't sold with that billing period.\" means you should pick the other way of paying. \"Too many codes tried. Try again later.\" means you should wait before trying another code. \"Unable to check this code. Try again.\" means the check didn't go through, so try again in a moment.",
    },
    {
      question: "The step says \"You do not have access to this business.\" Why?",
      answer: "Only owners and admins can choose the business's plan. If you joined a business someone else owns and it isn't set up yet, ask one of its owners or admins to finish setup.",
    },
    {
      question: "The step says \"A plan started before this payment arrived, so no pack was added.\" What happened?",
      answer: "A plan bought for the business took effect before the payment for the prepaid plan arrived, so setup goes on with that plan. The payment for the prepaid plan will be refunded.",
    },
  ],
  related: ["onboarding-greeting", "onboarding-number", "onboarding-attribution", "plan", "usage", "phone-number"],
  keywords: ["plan", "pricing", "prices", "subscription", "choose a plan", "free plan", "prepaid plan", "prepaid pack", "promo code", "coupon", "discount", "billing", "payment", "monthly", "annual", "checkout", "billing email"],
};

export default article;
