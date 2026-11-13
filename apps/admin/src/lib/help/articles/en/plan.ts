import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "plan",
  title: "Plan",
  section: "settings",
  summary: "See your plan and what it includes, move to another plan or buy a prepaid pack, use a promo code, cap overage spending and manage payments and invoices.",
  screenPaths: ["/settings/plan"],
  location: ["Sidebar", "Manage", "Settings", "Plan"],
  access: "Everyone on the team can see the plan, what it includes, the packs the business holds and the spending cap. Only owners and admins can upgrade, buy a pack, use a promo code, change the spending cap, manage or cancel the subscription and see the transaction history.",
  purpose: [
    "The **Plan** screen shows the business's plan: its name, its price and what it includes for your AI receptionist. It is also where owners and admins move to another plan, buy a prepaid pack, use a promo code and manage payments.",
    "A paid plan renews every month or every year, and its allowances of voice minutes, transfer attempts and SMS alerts start again each month. A paid plan that shows **+ pay-as-you-go usage** also bills the usage past those allowances, which the **Monthly spending cap** can limit. A prepaid pack is paid once and lasts a set number of days, or has no end date, without renewing, and what it includes stops when it runs out.",
    "You pay on the secure payment page, and you manage your payment method and invoices in the billing portal, which **Manage subscription** opens. The plans, packs and prices on offer are shown in the **Upgrade plan** dialog and can change over time.",
  ],
  areas: [
    { name: "Payment unsuccessful", description: "A banner across the top of every dashboard screen that owners and admins see when a payment for a paid plan is past due. It says the service stays active during the payment grace period. Select **Update payment method** to fix it in the billing portal before the service is interrupted." },
    { name: "Your plan", description: "The plan's name and its price, followed by **/ month**, or **/ month, billed annually** for a yearly plan. A paid plan that bills usage over its allowances adds **+ pay-as-you-go usage**, and a plan with custom pricing says so instead of showing a price. Lines under the price can show a promo discount and when the promo plan ends, the date your plan ends or changes to another plan, that your bank asks you to confirm a payment, or how usage over your allowance is billed. On one prepaid pack, it shows the pack's name, its price for its length and the date it ends, or that it has no end date. With several packs, it shows **Prepaid Plan** and the date the last one ends, or that it has no end date." },
    { name: "What's included", description: "What the plan includes: voice minutes, how many receptionists can be active at once, transfer attempts and SMS alerts each month, and knowledge storage. On prepaid packs, it shows what your packs include for their whole length, and on a custom plan it says which allowances are custom." },
    { name: "Your packs", description: "Shown when the business holds several prepaid packs, or a pack beside another plan. Each pack shows its name, its price for its length, the minutes left out of its total with a bar, and the date it ends or **Never ends**. **On hold while a payment dispute is open** means nothing can be drawn from that pack until the dispute is settled." },
    { name: "Have a promo code?", description: "A link that opens a field for a promo code. A valid code shows the plan it unlocks, any discount and for how long, what the plan includes and its prices. Only owners and admins see it, and not on a plan with custom pricing." },
    { name: "Plan buttons", description: "The buttons under the plan, which only owners and admins see. **Complete payment** shows when your bank asks you to confirm a payment. The upgrade button opens the **Upgrade plan** dialog: it reads **Upgrade to** followed by a higher plan's name when plans can be bought, and **Upgrade plan** when only prepaid packs can. **Manage subscription** opens the billing portal. Where your plan can be changed from this screen, **Cancel plan**, **Resume** and **Keep my plan** show when they apply." },
    { name: "Monthly spending cap", description: "Shown on paid plans that bill pay-as-you-go usage. It shows **No spending cap is set**, or the **Current overage spend** this month against the cap with a bar, and **Cap reached** once the spend gets there. Owners and admins can set, update or remove the cap, and everyone else sees a note that only owners and admins can change it." },
    { name: "Transaction history", description: "The business's 20 most recent orders, refunds and setup fees from the payment provider, with the **Date**, **Description**, **Amount**, **Status** and an **Invoice** link where there is one. The status reads, for example, **Paid**, **Pending**, **Refunded** or **Partial refund**. A refund shows with a minus sign, and a refunded payment shows how much was refunded under its amount. Only owners and admins see it, once the business has at least one transaction." },
  ],
  fields: [
    {
      title: "Have a promo code?",
      description: "The form that opens from the **Have a promo code?** link. A code from a promo link, or one kept from sign-up, is filled in and checked as soon as the screen opens. In the offer, an allowance the plan includes more of than the regular plan it's based on is marked **More than** followed by that plan's name. If the business holds prepaid packs, the offer warns that starting its plan ends them and the minutes left on them.",
      fields: [
        { name: "Promo code", requirement: "required", description: "The code you were given: letters and digits, sometimes in groups joined by hyphens. Letter case and spaces don't matter. **Apply** stays off until you enter a code. Select **Apply** to check it, which shows **Checking...** for a moment, or **Cancel** to close the form." },
        { name: "Monthly and Yearly", description: "After a valid code, a box for each billing period the plan is sold with shows its price, with the regular price crossed out when the code takes money off. Its button reads **Subscribe monthly** or **Subscribe yearly**, or **Switch to it monthly** or **Switch to it yearly** when you already pay for a plan. **Not on sale right now** means that period can't be bought. When the business already has the plan the code unlocks, the offer says so instead of showing the prices." },
      ],
    },
    {
      title: "Upgrade plan",
      description: "The dialog that opens from the upgrade button on this screen, from the upgrade item in the menu with your email address at the bottom of the sidebar, and from screens that need a higher plan. When the business already pays for a plan, it says that choosing another one changes the subscription instead of opening a payment page, and that any difference is charged to the saved payment method.",
      fields: [
        { name: "Monthly and Annual", description: "Tabs that switch the prices between paying each month and paying for a year at once. A yearly price is shown as what it comes to per month, and the **Annual** tab can show what you save. Only the periods the plans are sold with appear." },
        { name: "Plan cards", description: "One card for each plan on offer, with its name, its price per month, a short description, what it includes and a button. The button reads **Current plan** on the plan you're on and starts or upgrades to the other plans. A plan with custom pricing shows **Custom** in place of a price, and its **Contact us** button opens an email to sales. A plan you can't move to from here, such as a lower one, has its button greyed out. While you're on packs, the free plan's card reads **When your packs end**, because the business returns to it once they run out. A card can carry a badge, such as one marking the most popular plan." },
        { name: "Prepaid pack cards", description: "Where packs are sold, each pack has a card with its name, its price followed by how long it lasts, what it includes for that time and a button to start it, such as **Start for** followed by its length, or **Start now** for a pack with no end date. A greyed out button has a note under it saying why the pack can't be bought now. Packs sit among the plans or follow them under a heading of their own, with a tab for each length when there are several." },
      ],
    },
    {
      title: "Monthly spending cap",
      description: "Shown on paid plans that bill pay-as-you-go usage. Only owners and admins can change it.",
      fields: [
        { name: "Overage cap", requirement: "optional", description: "The most pay-as-you-go usage may cost in a month, in your plan's currency, which the label names. Type a whole amount or one with up to two decimals, using the decimal mark of the dashboard's language and no thousands separators, such as `25.00`, then select **Save**, or **Update** when a cap is set. Leave it empty for no cap. Clearing the field doesn't take off a cap that's set: select **Remove cap** for that." },
      ],
    },
    {
      title: "Billing email",
      description: "Appears in the **Upgrade plan** dialog or under a promo code's offer when the payment provider can't use your email for this business, for example because it already handles another business's billing.",
      fields: [
        { name: "Billing email", requirement: "required", description: "The email that should get this business's receipts. **Continue** stays off while the field is empty. Select **Continue** to try the payment again with it, or **Cancel** to stop." },
      ],
    },
  ],
  tasks: [
    {
      title: "Upgrade your plan",
      steps: [
        "Open **Settings** in the sidebar and select the **Plan** tab.",
        "Select the upgrade button under **Your plan**, which starts with **Upgrade**. The **Upgrade plan** dialog opens.",
        "Choose **Monthly** or **Annual** where both are offered.",
        "Select the button on the plan you want.",
        "If the business doesn't pay for a plan yet, pay on the secure payment page that opens. You come back to the **Plan** screen afterwards.",
        "If the business already pays for a plan, the change is made without a payment page and any difference is charged to the saved payment method. The new plan shows once the payment provider confirms it.",
      ],
    },
    {
      title: "Buy a prepaid pack",
      steps: [
        "Select the upgrade button under **Your plan** to open the **Upgrade plan** dialog.",
        "Find the pack you want. If the packs have a tab for each length, select the length first.",
        "Select the pack's button. If the business pays for a monthly plan, a dialog lists what ending that plan means. Select **End plan and buy** to go on, or **Go back**.",
        "Pay on the secure payment page. When you come back, a message says the pack was added, and it shows under **Your plan**. If the payment is still processing, the message says so and the pack shows once the payment arrives.",
      ],
    },
    {
      title: "Use a promo code",
      steps: [
        "Select **Have a promo code?** under **Your plan**.",
        "Type the code in **Promo code** and select **Apply**.",
        "Check the plan the code unlocks, its discount and what it includes.",
        "Select the button for the billing period you want, such as **Subscribe monthly**.",
        "Pay on the secure payment page. If the business already pays for a plan, the plan changes without one.",
      ],
    },
    {
      title: "Set or change the monthly spending cap",
      steps: [
        "Under **Monthly spending cap**, type the most pay-as-you-go usage may cost in a month in **Overage cap**.",
        "Select **Save**, or **Update** if a cap is already set. A message confirms the cap is saved.",
        "To stop capping the cost, select **Remove cap**.",
      ],
    },
    {
      title: "Update your payment method or get an invoice",
      steps: [
        "Select **Manage subscription** under **Your plan**. The billing portal opens.",
        "Update your payment method or find your invoices there.",
        "For a recent payment, you can also select **Invoice** on its row in **Transaction history**.",
      ],
    },
    {
      title: "Cancel your plan",
      steps: [
        "Select **Cancel plan** under **Your plan**.",
        "Read **Cancel your plan?**, then select **Cancel plan** to confirm, or **Go back** to keep the plan.",
        "The plan stays active until the end of the period you paid for, then moves to the free plan. The end date shows under **Your plan**.",
        "If you don't see **Cancel plan**, select **Manage subscription** and cancel in the billing portal where it allows it, or contact support.",
      ],
    },
    {
      title: "Undo a cancellation",
      steps: [
        "Before the end date, select **Resume** under **Your plan**.",
        "A message says your plan will keep renewing, and the end date goes away.",
        "If you don't see **Resume**, check the billing portal from **Manage subscription**, or contact support.",
      ],
    },
    {
      title: "Confirm a payment your bank asks for",
      steps: [
        "When **Your plan** says your bank asks you to confirm the payment for the new plan, select **Complete payment**.",
        "Confirm the payment on the page that opens.",
        "Come back to the **Plan** screen. The new plan shows once the payment goes through.",
      ],
    },
    {
      title: "Keep your plan when a change is waiting",
      steps: [
        "When **Your plan** says your plan changes to another plan on a date, select **Keep my plan**.",
        "A message says you're staying on your current plan, and the waiting change is dropped.",
      ],
    },
  ],
  notes: [
    "Allowances start again on the first day of each month, whatever day the plan renews, for monthly and yearly plans alike. The **Usage** screen shows how much has been used.",
    "The **Upgrade plan** dialog doesn't move a paid plan down to a lower one. To do that, use the billing portal from **Manage subscription** where it allows it, or contact support.",
    "Changing plans ends a promo plan and its discount, and the dialog warns you first.",
    "When you cancel, usage over what's included is still billed until the end date.",
    "A promo plan can last a set number of months. A line under **Your plan** says until when, and whether it then moves to the regular plan it's based on or ends, and the owners get an email a week before. A promo plan set to end this way can't be resumed here.",
    "A promo code can be used once by each business.",
    "A prepaid pack is paid once, never renews and has no pay-as-you-go usage. Each use draws on the pack that ends first, and what a pack still holds when it ends is lost.",
    "While a pack is the plan, the owners get an email when a fifth of the minutes is left, when none is left, and 30 and 7 days before a pack ends.",
    "When the last pack ends, the business goes back to the free plan, and receptionists beyond what it includes are paused. If that plan includes no phone number, the number stops answering calls and texts right away and is released 30 days after the last pack ended, unless you buy another pack or start a plan that includes a number before then, which brings it back. The **Phone Number** screen shows the date.",
    "Buying a pack while you pay for a monthly plan ends that plan right away. The rest of its month isn't refunded, its usage so far is still billed, and a promo code it used is lost for good. Starting a plan while you hold packs ends the packs and the minutes left on them.",
    "Packs can't be bought on a yearly plan, while a payment is past due or while your bank still needs you to confirm a payment. Set a yearly plan to end at its renewal and buy the pack once it has ended. Settle a past due payment under **Manage subscription**, or complete the payment your bank is waiting for, then buy the pack.",
    "When you move between a pack and a subscription, what's left of the old one is gone and the new allowances count from the moment of the switch.",
    "If the new plan includes fewer receptionists than are active, the newest extra ones are paused and the default one keeps answering, also for the paused ones' numbers and links. Nothing is deleted, and you can choose which to keep on the **AI agents** screen.",
    "If the new plan includes less knowledge storage than the business uses, nothing is deleted, but new documents and website pages can't be added until it's under the limit. Text entries don't count toward knowledge storage, so they can still be added.",
    "The spending cap counts only what pay-as-you-go usage costs, and starts again each month. When it's reached, anything still within its allowance and website chats keep working, while use that would cost more is paused. A cap of `0` allows no pay-as-you-go usage at all.",
    "**At least** before the spend means some calls or texts are still being counted, so the figure isn't final yet.",
    "While a purchase or plan change is being set up for the business, another one can be refused with a message to try again in a minute.",
    "Each business has its own plan, packs and transaction history, and a pack is never shared with your other businesses. If you belong to several businesses, the screen shows the one chosen in the business menu at the top of the sidebar.",
  ],
  troubleshooting: [
    {
      question: "Why can't I see the upgrade button, Have a promo code? or Manage subscription?",
      answer: "Only owners and admins see them. The upgrade button also needs a higher plan or a pack you can buy from your current plan, and **Manage subscription** appears once the business has, or has had, a subscription. None of them show on a plan that's managed for you, such as one with custom pricing. If you're an owner or admin and still don't see them, contact support.",
    },
    {
      question: "I paid, but the screen still shows my old plan. What should I do?",
      answer: "The plan changes once the payment provider confirms the payment, which usually takes a few moments. Wait a minute and reload the page. A payment that settles later, such as a bank debit, can take longer. If the plan still hasn't changed, check **Transaction history** and contact support.",
    },
    {
      question: "An upgrade fails with Unable to change your plan or Unable to open checkout. What can I do?",
      answer: "Wait a minute and try again. If the message says your subscription can't change right now, check it in the billing portal from **Manage subscription**. If it says the plan can't be bought right now, or that plan changes aren't set up here yet, contact support.",
    },
    {
      question: "It says my saved payment method couldn't be charged for the new plan.",
      answer: "Select **Manage subscription**, update your payment method in the billing portal, then try the upgrade again.",
    },
    {
      question: "It says my subscription is set to end, so its plan can't change.",
      answer: "A plan that's canceled can't be changed. Select **Resume**, or resume it in the billing portal from **Manage subscription**, then try again.",
    },
    {
      question: "Cancel plan, Resume or Keep my plan says That didn't go through.",
      answer: "The change wasn't made. Wait a minute and try again. If it keeps failing, use the billing portal from **Manage subscription** where it allows it, or contact support.",
    },
    {
      question: "How do I switch between monthly and yearly billing?",
      answer: "In the **Upgrade plan** dialog, the plan you're on reads **Current plan** on both tabs, so its billing period can't change there. You choose the billing period when you move up to another plan. To change it on the plan you're on, use the billing portal from **Manage subscription** where it allows it, or contact support.",
    },
    {
      question: "Why does my promo code say it isn't valid?",
      answer: "The code may be mistyped, expired, revoked or used up, it may be meant for another business, this business may have used it already, or its plan may no longer be on sale. Check the code with whoever gave it to you. If the offer says you're already on this plan, the business already pays for the plan the code unlocks. If it says the plan isn't sold with that billing period, choose the other period. **Unable to check this code** means it couldn't be checked just then, so try again.",
    },
    {
      question: "It says there were too many tries, or too many codes tried. What now?",
      answer: "To protect payments, each business can start 10 purchases or plan changes, open the billing portal 20 times and try 10 promo codes an hour, and each person 20 purchases or plan changes, 40 portal visits and 20 codes an hour across businesses. The counts start again every hour, so wait up to an hour and try again.",
    },
    {
      question: "Why is a pack's button greyed out?",
      answer: "The note under it says why: the business is on a yearly plan, a payment for your plan is past due, or your bank still needs you to confirm a payment. Do what it says, then try again. **Packs can't be bought here right now** shows when you aren't an owner or admin, or when packs can't be bought for the business at the moment. Ask an owner or admin, or contact support if it stays.",
    },
    {
      question: "It says another purchase is still in progress, or an earlier change is still being applied.",
      answer: "Someone started a purchase or a plan change for the business a moment ago, and it has to finish first. Wait a minute and try again.",
    },
    {
      question: "The spending cap won't save. What's wrong?",
      answer: "If it asks for an amount with no more than two decimal places, check the number: no thousands separators, at most two decimals, and the decimal mark of the dashboard's language, such as `1000.50` in English. If it says it's unable to save the cap, try again in a minute. Only owners and admins can change the cap, and everyone else sees a note saying so.",
    },
    {
      question: "The spending cap says it's reached. What stops?",
      answer: "Calls, transfers and texts that would cost more are paused until the next month, while anything still within its allowance keeps working. Raise or remove the cap to let them run again.",
    },
    {
      question: "A Billing email field appeared when I tried to pay. Why?",
      answer: "The payment provider couldn't use your email for this business, often because it already handles another business's billing. Enter another email for this business's receipts and select **Continue**.",
    },
    {
      question: "Why does Manage subscription say it's unable to open the portal?",
      answer: "Try again in a minute. If it keeps failing, contact support.",
    },
    {
      question: "A Payment unsuccessful banner shows at the top of the dashboard. What should I do?",
      answer: "A payment for your plan is past due. The service stays active during a grace period, so select **Update payment method** and update it in the billing portal. The banner goes away once the payment goes through.",
    },
    {
      question: "It says a plan started before this payment arrived, so no pack was added.",
      answer: "A plan started for the business while the pack's payment page was open, so the pack gave way to the plan. The payment will be refunded. When the message says instead that the pack's checkout closed because a plan started, the business has that plan now and no pack was bought.",
    },
    {
      question: "It says my payment didn't go through, or was refunded or charged back, so no pack was added.",
      answer: "The business didn't get the pack. If the payment didn't go through, select the pack's button again and pay on the new payment page. If it was refunded or charged back before it arrived, buy the pack again if you still want it, or contact support.",
    },
    {
      question: "The pack's payment page expired or didn't open. What can I do?",
      answer: "Select the pack's button again to open a new payment page. If a message says the pack isn't on sale right now, it can't be bought at the moment, so choose another pack or try again later.",
    },
    {
      question: "The screen says Usage data is unavailable. What can I do?",
      answer: "The plan couldn't be loaded. Select **Try again**, and reload the page if the message stays.",
    },
    {
      question: "The plan says no usage limits or billing apply. Why?",
      answer: "Billing doesn't apply to your workspace, so there are no plans to buy, allowances to track or payments to manage on this screen.",
    },
  ],
  related: ["usage", "onboarding-plan", "team", "ai-agents", "phone-number", "knowledge"],
  keywords: ["billing", "subscription", "upgrade", "change plan", "downgrade", "cancel subscription", "annual billing", "prepaid pack", "promo code", "coupon", "discount", "invoice", "receipt", "refund", "payment method", "payment failed", "past due", "spending cap", "overage", "pay-as-you-go", "billing portal"],
};

export default article;
