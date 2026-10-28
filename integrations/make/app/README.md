# __APP_NAME__ for Make

This app connects Make scenarios to a business's __APP_NAME__ dashboard. It only calls the dashboard's API, with the business's API key.

## Connect

1. In __APP_NAME__, go to **Settings > API keys**, select **Create API key**, then **Set up for Make**, which allows every module here. Copy the key, which starts with `lsk_`.
2. In Make, add any __APP_NAME__ module and select **Create a connection**. Paste the key into **API key**, and check that **__APP_NAME__ URL** is your dashboard's address. It starts as __DASHBOARD_URL__.

The dashboard's [Connect Make](__HELP_URL__) dialog has the same steps.

## Modules

- **Triggers:** Watch completed calls, Watch new appointments, Watch rescheduled appointments, Watch cancelled appointments, Watch new messages and Watch new contacts. Each one adds a webhook in the dashboard under **Integrations > Webhooks**, named "Make: " and the module's name, and deleting the webhook in Make removes it.
- **Calls:** Get a call, with its transcript.
- **Appointments:** Search appointments, Get an appointment, List open appointment times, Book an appointment, Reschedule an appointment and Cancel an appointment. Booking and moving appointments need **Agent > Booking** set to **Books appointments**.
- **Contacts:** Search contacts, Get a contact, Create a contact and Update a contact.
- **Knowledge:** Add a knowledge entry.
- **Other:** Make an API call, for any path of the API. The API reference is at `/api/v1/openapi.json` on the dashboard, such as `__DASHBOARD_URL__/api/v1/openapi.json`.
