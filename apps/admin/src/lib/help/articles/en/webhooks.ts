import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "webhooks",
  title: "Webhooks",
  section: "manage",
  summary: "Send finished calls, bookings, messages taken and new contacts to your own systems as they happen, and check each delivery in a log.",
  screenPaths: ["/integrations/webhooks"],
  location: ["Sidebar", "Manage", "Integrations", "Manage on the Webhooks card"],
  access: "Only owners and admins can see and manage webhooks. Everyone else sees a message saying so, and for them the **Manage** button on the **Webhooks** card is greyed out.",
  purpose: [
    "A webhook tells another system about something that just happened in your business. When a call ends, an appointment is booked, moved or cancelled, your AI receptionist takes a message or a new contact is added, the app sends the details to an address you choose, such as your CRM, an automation tool or your own server.",
    "Each address that receives events is an endpoint. You choose which events each endpoint gets, and every request is signed with the endpoint's own secret, so the receiving system can check that it really came from the app.",
    "Setting up the receiving side usually needs a developer, or a tool that gives you a webhook address to paste here. Once it runs, the delivery log shows the events sent and whether they arrived, and lets you send an event again.",
    "When the business has several AI agents, each endpoint receives the events of all of them. The details of a call or of a message taken say which receptionist it was.",
  ],
  areas: [
    { name: "Integrations", description: "The link above the title goes back to the **Integrations** screen." },
    { name: "Add endpoint", description: "Opens the form for a new endpoint." },
    { name: "Endpoints", description: "Each endpoint shows its address, its description and the events it receives, newest first. The switch beside **On** or **Off** turns sending to it on or off. Before you add one, the list reads **No webhook endpoints yet**." },
    { name: "We turned this endpoint off", description: "A red warning on an endpoint the app turned off because every delivery failed for about a day. Fix the receiving system, then turn the endpoint back on with its switch. To send the events that failed, use **Resend** on their rows in the delivery log." },
    { name: "Endpoint buttons", description: "**Delivery log** shows the endpoint's recent deliveries, and **Hide delivery log** closes them again. **Send test event** sends it a test. **Edit** changes its address, description or events. **Rotate secret** replaces its signing secret. **Delete** removes it." },
    { name: "Delivery log", description: "A table of the latest 50 deliveries to the endpoint, newest first, which refreshes every 10 seconds. **Resend** at the end of each row sends that event again. Until there is a delivery, it reads **No deliveries yet**." },
    { name: "Endpoint added and New signing secret", description: "After you add an endpoint or rotate its secret, a dialog shows the signing secret once, with **Copy**. Store it in the receiving system before you select **Done**." },
  ],
  fields: [
    {
      title: "Add a webhook endpoint and Edit webhook endpoint",
      description: "The form that opens from **Add endpoint**, or from **Edit** on an endpoint. Its **Add endpoint** or **Save** button stays greyed out until the form has an address and at least one event.",
      fields: [
        { name: "Endpoint URL", requirement: "required", description: "The address that receives the events, such as `https://example.com/webhooks`. It must start with `https://` and be reachable by anyone on the internet. Local and private network addresses, and addresses with a user name or password in them, are refused." },
        { name: "Description", requirement: "optional", description: "A note to tell your endpoints apart, such as CRM sync. Up to 200 characters." },
        { name: "Events to send", requirement: "required", description: "The events this endpoint receives. Tick at least one. A new endpoint starts with all six ticked." },
      ],
    },
    {
      title: "Events to send",
      description: "Each event shows its name, as it appears in requests and in the delivery log, with what it means. The request carries the details of the call, appointment, message or contact as they were when it happened.",
      fields: [
        { name: "A call ended and its summary is ready", description: "Sent as `call.completed` once the call's summary is saved." },
        { name: "An appointment was booked", description: "Sent as `appointment.booked`." },
        { name: "An appointment moved to a new time", description: "Sent as `appointment.rescheduled`." },
        { name: "An appointment was cancelled", description: "Sent as `appointment.cancelled`." },
        { name: "The receptionist took a message for your team", description: "Sent as `message.taken`." },
        { name: "A new contact was added", description: "Sent as `contact.created`." },
      ],
    },
    {
      title: "Delivery log",
      description: "The columns of the table that opens with **Delivery log**.",
      fields: [
        { name: "Event", description: "The event's name, such as `call.completed`, or `webhook.test` for a test event." },
        { name: "Status", description: "**Queued** while it waits to be sent, **Retrying** after a failed try, with **Next try** and its time below it, **Delivered** when the endpoint accepted it, **Failed** when every try failed, and **Skipped** when the endpoint was turned off before it could be sent." },
        { name: "Response", description: "The status code the endpoint answered with, such as 200 or 500, and the reason when a try failed or was skipped, such as a timeout. It shows a dash when nothing has answered yet or the endpoint couldn't be reached." },
        { name: "Attempts", description: "How many times the app has tried to send it." },
        { name: "Last try", description: "When it was last sent, or when it was queued if it hasn't been sent yet." },
      ],
    },
  ],
  tasks: [
    {
      title: "Add an endpoint",
      steps: [
        "Open **Integrations** in the sidebar and select **Manage** on the **Webhooks** card.",
        "Select **Add endpoint**.",
        "Enter the receiving address in **Endpoint URL**, and a **Description** if you like.",
        "Under **Events to send**, untick the events this endpoint doesn't need.",
        "Select **Add endpoint**.",
        "In **Endpoint added**, select **Copy** and save the secret in the receiving system or a password manager, then select **Done**. You won't see the secret again.",
      ],
    },
    {
      title: "Check that an endpoint works",
      steps: [
        "Select **Send test event** on the endpoint. The message **Test event queued. Check the delivery log.** shows.",
        "The delivery log opens with the test, named `webhook.test`. Wait for its status to change to **Delivered**. The log refreshes every 10 seconds.",
        "If it shows **Retrying** or **Failed**, read the **Response** column for the reason, fix the receiving system and send another test.",
      ],
    },
    {
      title: "Send an event again",
      steps: [
        "Select **Delivery log** on the endpoint.",
        "Find the event and select **Resend** on its row.",
        "Look for the message **Event queued again** and the new row it adds at the top of the log.",
      ],
    },
    {
      title: "Turn an endpoint off or on",
      steps: [
        "Use the switch beside **On** or **Off** on the endpoint.",
        "While it is off, the app sends it no events apart from the tests you send, and events that happen in the meantime aren't sent later.",
        "Turn it back on to start sending again.",
      ],
    },
    {
      title: "Change an endpoint",
      steps: [
        "Select **Edit** on the endpoint.",
        "Change the **Endpoint URL**, the **Description** or the **Events to send**.",
        "Select **Save**. The change applies to the next event the app sends.",
      ],
    },
    {
      title: "Replace the signing secret",
      steps: [
        "Select **Rotate secret** on the endpoint, then **Rotate secret** again to confirm.",
        "In **New signing secret**, select **Copy** and put the new secret in the receiving system straight away. The old secret stops working at once.",
        "Select **Done**.",
      ],
    },
    {
      title: "Delete an endpoint",
      steps: [
        "Select **Delete** on the endpoint.",
        "Confirm with **Delete endpoint**. The app stops sending to it and deletes its delivery log, and the message **Endpoint deleted** shows. This can't be undone.",
      ],
    },
  ],
  notes: [
    "A business can have up to 20 endpoints.",
    "Each event is sent as an HTTPS POST request with its details in JSON, signed with the endpoint's secret in the `webhook-signature` header, following the open Standard Webhooks format. The receiving system uses the secret to check the signature.",
    "A delivery counts as delivered only when the endpoint answers with a success code, from 200 to 299, within 10 seconds. Redirects aren't followed.",
    "A failed delivery is tried again after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour, 3 hours, 6 hours and 12 hours: 9 tries over about 23 hours.",
    "If every try fails and nothing has reached the endpoint in that time, the app turns the endpoint off and shows **We turned this endpoint off**. Everyone on the team who has **Webhook endpoint turned off** turned on in **Notifications** gets an alert.",
    "When an endpoint is turned off, deliveries still waiting for it are marked **Skipped** when their next try comes up. A test event is sent even to an endpoint that is off.",
    "An event sent again goes out exactly as it was first recorded, with the same event ID in its `webhook-id` header, so the receiving system can tell it is a repeat.",
    "The delivery log keeps about 30 days of history.",
    "Endpoints added through the app's API, or by a Zap or a Make scenario, appear here too. A Zap's or scenario's endpoint has a description that starts with `Zapier:` or `Make:`, and deleting it stops that Zap or scenario from receiving events.",
    "When a business is handed over to a new owner, the endpoints set up by the person who handed it over, or by a partner, are turned **Off**, without the red warning. Check where each one sends events before you turn it back on.",
    "Don't rotate the secret of an endpoint whose description starts with `Zapier:`. The Zap checks each event with the secret it got when it was turned on and ignores events signed with a new one. Turn the Zap off and on again instead, which gives it a new endpoint.",
  ],
  troubleshooting: [
    {
      question: "I see \"Only owners and admins can manage webhooks\". What can I do?",
      answer: "Ask an owner or admin of the business to set up the webhook, or to change your role on the **Team** screen.",
    },
    {
      question: "Saving fails with \"url must be an absolute URL.\" What's wrong?",
      answer: "The address isn't complete. Enter the whole address, starting with `https://`, as whoever runs the receiving system gave it to you.",
    },
    {
      question: "Saving fails with \"url must use https.\" What's wrong?",
      answer: "The address must start with `https://`. Ask whoever runs the receiving system for its secure address.",
    },
    {
      question: "Saving fails with \"url must point to a public host.\" or \"url must point to a public IP address.\" Why?",
      answer: "The address points to a local or private network, which the app can't reach. Use an address that anyone on the internet can reach. The same applies when deliveries fail because the address resolves to a private or reserved address.",
    },
    {
      question: "Saving fails with \"url must not contain a username or password.\" What should I do?",
      answer: "Remove the user name and password from the address. To check that requests come from the app, use the signing secret instead.",
    },
    {
      question: "I see \"A business can have up to 20 webhook endpoints.\" What can I do?",
      answer: "Delete an endpoint you no longer use, or send several kinds of event to one endpoint.",
    },
    {
      question: "Deliveries fail with \"Timed out after 10 seconds.\" Why?",
      answer: "The receiving system took too long to answer. It should reply with a success code straight away and do any slow work afterwards.",
    },
    {
      question: "Deliveries show Retrying or Failed with a code such as 401, 404 or 500. What does it mean?",
      answer: "The endpoint answered, but not with a success code. A code in the 400s, such as 401, 403 or 404, usually means the address is wrong or the receiving system refused the request. A code of 500 or more means the receiving system ran into a problem of its own. Check the address with **Edit**, or ask whoever runs the receiving system, then check it with **Send test event**.",
    },
    {
      question: "Deliveries fail with \"Redirects are not followed\". What does it mean?",
      answer: "The address sends requests on to another address. Put the final address in **Endpoint URL**.",
    },
    {
      question: "The receiving system says the signature doesn't match. What can I check?",
      answer: "Make sure it uses the latest secret, from **Endpoint added** or **New signing secret**, and checks the request body exactly as it arrived. If the secret is lost, use **Rotate secret** to get a new one and update the receiving system straight away.",
    },
    {
      question: "The app turned an endpoint off. How do I get it working again?",
      answer: "Fix the receiving system and check it with **Send test event**. Then turn the endpoint back on with its switch, open **Delivery log** and send the events that failed again with **Resend** on their rows. Send them again only once the endpoint is on, because an event sent again to an endpoint that is off is skipped. Events that happened while it was off weren't kept for it and can't be sent.",
    },
  ],
  related: ["integrations", "api-keys", "notifications", "team"],
  keywords: ["webhook endpoint", "callbacks", "event notifications", "HTTP POST", "signing secret", "delivery log", "resend", "CRM sync", "automation", "real time events", "Standard Webhooks"],
};

export default article;
