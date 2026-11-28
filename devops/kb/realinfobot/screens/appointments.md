# The Appointments screen in the RealInfoBot app

See the appointments that haven't ended yet, soonest first, check that each one reached your connected calendar, and cancel one when needed.

- Where to find it: No link in the app > Open /appointments in the address bar
- Who can use it: Everyone on the team can see the appointments. Owners, admins and schedulers can cancel them. Viewers don't see the **Cancel** button.
- Address: https://ca.realinfobot.com/appointments

Also known as: bookings, schedule, upcoming appointments, appointment list, calendar, cancel a booking, reservations, calendar sync, agenda.

## What the Appointments screen is for

Appointments lists the bookings that haven't ended yet, soonest first: the ones your AI receptionist booked on calls and in website chats, and the ones apps connected to your business booked. Cancelled appointments are left out.

Use it to see who is coming and when, to check that each booking reached your connected calendar, and to cancel a booking the customer can't keep.

No menu links to this screen. To open it, replace everything after the dashboard's address in the browser's address bar with `/appointments`, then bookmark the page. The **Upcoming** list on **Home** shows the next few appointments too.

## What you see on the Appointments screen

- **Summary**: Under the title: the business's name and how many upcoming appointments the list holds.
- **Refresh**: Reloads the list. The list also updates by itself when an appointment is booked, moved or cancelled, or when its calendar status changes.
- **Appointments table**: One row per appointment, soonest first. The columns are described below. While the list loads it reads **Loading appointments**, and with nothing to show it reads **No upcoming appointments**.
- **Cancel**: The button at the end of each row, for owners, admins and schedulers. It opens **Cancel this appointment?**, which names the service, the customer and the time, and nothing is cancelled until you confirm.

## Appointments table, on the Appointments screen

The columns of the list. They show what is booked and can't be edited here.

- **Time**: The day and start time, in the time zone the business had when the appointment was booked.
- **Customer**: The contact's name or, when no name is known, their phone number, their email, or a label such as **Phone caller**.
- **Service**: The service that was booked.
- **Staff**: The staff member the appointment is with.
- **Status**: The booking's status, normally **Confirmed**.
- **Calendar**: Whether the appointment reached your connected calendar. **Pending** means it is on its way, **Synced** means it is there, and **Failed** means it couldn't be written. **Not required** means no connected calendar covers it, for example because none is connected.

## How to open the Appointments screen, on the Appointments screen

1. Open any screen of the dashboard in your browser.
2. In the address bar, replace everything after the dashboard's address with `/appointments` and press Enter.
3. Bookmark the page so you can come back in one click.

## How to cancel an appointment, on the Appointments screen

1. Find the appointment in the list and select **Cancel** at the end of its row.
2. In the **Cancel this appointment?** dialog, check the service, customer and time.
3. Select **Cancel appointment** to cancel it, or **Keep appointment** to leave it as it is.
4. **Appointment cancelled** shows, and the appointment leaves the list.

## How to check that a booking reached your calendar, on the Appointments screen

1. Find the appointment and read its **Calendar** column.
2. If it reads **Failed**, open the **Integrations** screen and check the calendar connection.
3. If it reads **Not required**, connect a calendar on the **Integrations** screen and pick one. Bookings that haven't ended yet are then added to it.

## Good to know about the Appointments screen

- The list shows up to 100 appointments that haven't ended and aren't cancelled. An appointment in progress stays until its end time.
- Cancelling removes the appointment from your connected calendar, skips its reminder and closes any request the customer made to cancel it. If it hasn't started yet, and the customer agreed to texts and isn't blocked, they get a text saying it was cancelled.
- If someone else cancelled the appointment a moment before you, cancelling still shows **Appointment cancelled**.
- This screen can't book or move appointments. The receptionist books them when **Appointments** under **Booking** in **AI settings** is set to **Books appointments**. With several AI agents, each receptionist has its own **Appointments** setting instead, under **Each receptionist's own**. Callers can ask it to cancel or move theirs when **Allow AI cancellations** or **Allow AI rescheduling** is turned on under **Appointment changes** in **AI settings**.
- When **Appointments** is set to **Takes requests**, the receptionist passes appointment requests to your team instead of booking them, so they don't appear here. They show under **Action required** on **Home**, and a request taken on a call also shows in **Messages**.
- Past and cancelled appointments don't show here. Open the customer from the **Contacts** screen and look at their **Appointments** tab.

## Good to know about the Appointments screen (continued)

- When an appointment can't be written to your calendar, your team can get a **Calendar sync issue** alert, chosen on the **Notifications** screen.
- **Home** shows the next five appointments under **Upcoming**, with the same **Cancel** button.
- With several AI agents, the list shows every receptionist's appointments together. It has no receptionist filter.

## I can't find Appointments in the menu. (Appointments screen)

No menu links to this screen. In the browser's address bar, replace everything after the dashboard's address with `/appointments`, then bookmark the page. **Upcoming** on **Home** also shows the next five appointments.

## The list says Appointments are unavailable. (Appointments screen)

The list couldn't load. Select **Refresh** or reload the page. If it keeps happening, try again in a few minutes.

## The list says No upcoming appointments, but I expected some. (Appointments screen)

Only appointments that haven't ended and aren't cancelled show here, so look for past or cancelled ones on the customer's page under **Contacts**. If the receptionist takes messages instead of booking, check the booking setting in **AI settings** and that the business has at least one active service on the **Services** screen. With a connected calendar, also check on the **Integrations** screen that it works, because the receptionist can't confirm times while it can't read the calendar.

## Why don't I see the Cancel button? (Appointments screen)

Viewers can't cancel appointments. Ask an owner, admin or scheduler to cancel it, or ask an owner or admin to change your role on the **Team** screen.

## Cancelling shows We couldn't cancel the appointment. Try again. (Appointments screen)

The cancellation didn't go through, and the appointment is still booked. Wait a moment and select **Cancel** again.

## An appointment shows Failed in the Calendar column. (Appointments screen)

It couldn't be written to your connected calendar. Check the connection on the **Integrations** screen.

## The time in my calendar app is a few hours off. (Appointments screen)

This screen shows each appointment in the time zone the business had when it was booked. When your calendar app shows another time, check the time zone set in the calendar app's own settings.

## The page says Choose a workspace to view appointments. (Appointments screen)

No business is selected. Pick one at the top of the sidebar, then come back to this page.
