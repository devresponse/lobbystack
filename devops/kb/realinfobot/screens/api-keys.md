# The API keys screen in the RealInfoBot app

Create keys that let tools such as Zapier, Make or your own scripts work with this business through the app's API, choose what each key may do, and revoke keys you no longer need.

- Where to find it: Sidebar > Manage > Settings > API keys
- Who can use it: Only owners and admins can see, create and revoke API keys. Everyone else sees a message asking an owner or admin to create a key for them.
- Address: https://ca.realinfobot.com/settings/api-keys

Also known as: API, API key, access token, Zapier, Make, automation, integration, business ID, revoke key, developer, script, command line.

## What the API keys screen is for

An API key lets another tool work with your business without signing in as a person: an automation tool such as Zapier or Make, or a script someone on your team wrote. The tool sends the key with each request, and the app lets it do only what the key allows.

Each key works for this business only. You choose its access when you create it, from reading calls and contacts to booking appointments or managing the team, so give each key only what its tool needs.

The whole key is shown once, when you create it. After that the list shows only its first characters, so store the key somewhere safe, such as a password manager or the tool's own settings.

## What you see on the API keys screen

- **Create API key**: Opens **Create an API key**, where you name the key and choose its access.
- **Business ID**: Shows this business's ID with a **Copy** button. Tools that work through the API, such as the command-line tool, use it to know which business you mean.
- **API keys list**: One row for each key, newest first. **Name** is the name you gave it, **Key** shows its first characters, **Access** shows what it may do as short codes, **Created** shows the date and who made it, and **Last used** shows when a tool last used it, or **Never**.
- **Revoke**: The button at the end of a row. It asks you to confirm, then turns the key off for good. A revoked key stays in the list, marked **Revoked** with the date.
- **Empty list**: "No API keys yet." shows until someone creates a key.

## Create an API key, on the API keys screen

The dialog that opens from **Create API key**. **Cancel** closes it without creating a key.

- **Name** (Required): A name you'll recognize, such as the tool that will use the key. Up to 120 characters. It can't be changed after the key is created.
- **Access** (Required): Tick each kind of access the key needs. Each choice shows a short code and what it allows. The first time you open the dialog, read access to calls, contacts, appointments, messages and the business is ticked. At least one choice must stay ticked.
- **Set up for Zapier**: Ticks exactly what Zapier needs for your Zaps and clears the rest. It also names the key Zapier, unless you already typed a name.
- **Set up for Make**: Ticks exactly what Make needs for your scenarios and clears the rest. It also names the key Make, unless you already typed a name.

## Access choices, on the API keys screen

The choices under **Access**, with the code each one shows. The same codes show as badges in the list.

- **Business details**: `business:read` reads business details, hours, services, and receptionist settings and rules. `business:write` updates them, including where calls are transferred.
- **Calls**: `calls:read` reads calls, with their summaries and transcripts.
- **Contacts**: `contacts:read` reads contacts. `contacts:write` creates and updates contacts.
- **Appointments**: `appointments:read` reads appointments and open times. `appointments:write` books, cancels and reschedules appointments.
- **Messages**: `messages:read` reads the messages the receptionist took.
- **Knowledge**: `knowledge:read` reads knowledge entries, FAQs, websites and files. `knowledge:write` adds, edits and deletes them.
- **Webhooks**: `webhooks:manage` creates and deletes webhook endpoints. Zapier and Make need it to start an automation when something happens, such as a call ending.
- **Billing**: `billing:manage` sees the plan, sets the spending cap and starts checkouts.
- **Phone numbers**: `phone_numbers:manage` finds, buys, replaces and releases phone numbers.
- **Team**: `team:manage` invites and removes team members, changes roles and hands the business over to a new owner.

## Key is ready, on the API keys screen

What the dialog shows once the key is created. Its title is the key's name followed by "is ready".

- **Key**: The whole key, with a **Copy** button. Copy it and store it in a password manager or your tool's settings before you select **Done** or close the dialog, because you won't see it again.

## How to create an API key, on the API keys screen

1. Open **Settings** in the sidebar and select the **API keys** tab.
2. Select **Create API key**.
3. Enter a **Name** you'll recognize.
4. Under **Access**, tick only what the tool needs and clear the rest.
5. Select **Create key**.
6. Select **Copy** and paste the key into your tool or a password manager.
7. Select **Done**. The key won't be shown again.

## How to create a key for Zapier or Make, on the API keys screen

1. Select **Create API key**.
2. Select **Set up for Zapier** or **Set up for Make**.
3. Select **Create key**, then **Copy**.
4. Paste the key where Zapier or Make asks for it, then select **Done**.

## How to revoke an API key, on the API keys screen

1. Select **Revoke** on the key's row.
2. Confirm with **Revoke key**. Anything that uses the key stops working right away, and this can't be undone.
3. A message confirms **API key revoked**, and the row shows **Revoked** with the date.

## How to replace a lost key or change a key's access, on the API keys screen

1. Create a new key with the access the tool needs.
2. Put the new key into the tool in place of the old one.
3. Revoke the old key.

## How to copy the business ID, on the API keys screen

1. Select **Copy** next to **Business ID**. The button shows **Copied** once the ID is on your clipboard.

## Good to know about the API keys screen

- The whole key is shown only once, right after you create it. If you lose it, revoke it and create a new one.
- A key's name and access can't be changed after it's created. To change them, create a new key and revoke the old one.
- Each key works for this business only, even if you belong to several businesses.
- The keys someone created are revoked automatically when that person leaves the team or stops being an owner or admin.
- Give `team:manage`, `billing:manage` and `phone_numbers:manage` only to tools you trust. They can change who has access, start plan purchases and set the spending cap, and buy or release the business's phone numbers.
- If the account is canceled from the **Team** tab, its API keys stop working. If the business is deleted, its keys are deleted with it.
- If your **Integrations** screen has a **Zapier** or **Make** card, its **Connect** steps include **Create a key for Zapier** or **Create a key for Make**. For an owner or admin, that opens this tab with **Create an API key** already set up for the tool.
- AI assistants connect another way: someone signs in from the assistant and approves its access, and it shows on the **Connected apps** tab.

## I see "Only owners and admins can manage API keys". What can I do? (API keys screen)

Your role on this business doesn't include API keys. Ask an owner or admin of the business to create a key for you.

## Why is Create key greyed out? (API keys screen)

The key needs a **Name** and at least one choice ticked under **Access**. A name of only spaces doesn't count. The button is also greyed out while the key is being created.

## I lost a key. Can I see it again? (API keys screen)

No. The whole key is shown only once. Create a new key, put it into your tool, and revoke the old one.

## A tool says the key isn't allowed to do something. Why? (API keys screen)

The key doesn't have the access that action needs, which you can see in its **Access** badges. Create a new key with the right access, or with **Set up for Zapier** or **Set up for Make**, then revoke the old one.

## A key stopped working. Why? (API keys screen)

Look at its row. **Revoked** with a date means the key was turned off, either by someone on this tab or automatically when the person who created it left the team or stopped being an owner or admin. Create a new key and put it into the tool.

## It says "We couldn't revoke the key. Try again." What do I do? (API keys screen)

The key still works. Check your connection and select **Revoke** again.
