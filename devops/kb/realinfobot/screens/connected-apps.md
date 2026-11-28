# The Connected apps screen in the RealInfoBot app

Review the AI assistants that someone connected to this business, see what each one may do and when it last worked, and disconnect the ones you no longer use or trust.

- Where to find it: Sidebar > Manage > Settings > Connected apps
- Who can use it: Only owners and admins can see the list and disconnect apps. Everyone else sees a message asking them to contact an owner or admin.
- Address: https://ca.realinfobot.com/settings/connected-apps

Also known as: AI assistant, connected apps, connect assistant, connector, MCP, app access, permissions, authorize app, revoke access, disconnect app, third party access.

## What the Connected apps screen is for

An AI assistant can work with your business for you, for example to read calls and contacts, book appointments or add knowledge for the receptionist. To allow it, an owner or admin connects the assistant to the app, signs in and approves what the assistant may do.

Each approval shows on this tab as a connected app. It works for this business only, with the access that was approved, until someone disconnects it.

Check this tab from time to time to see which assistants can reach the business, and disconnect any you no longer use.

## What you see on the Connected apps screen

- **Connected apps list**: One row for each assistant connected to this business. **App** shows its name, or **Unnamed app**, with its identifier underneath. **Access** shows what it may do. **Connected** shows the date and who connected it. **Last used** shows when it last worked with the business, or **Never**.
- **Access badges**: Each badge in the **Access** column is one kind of access, written as a short code such as `calls:read`. Point at a badge with the mouse to see what it allows in plain words.
- **Disconnect**: The button at the end of each row. It asks you to confirm, then cuts the app off from this business.
- **Empty list**: "No connected apps yet" shows when no assistant is connected. To connect one, add the app in the assistant's settings and sign in.

## Access, on the Connected apps screen

What each badge allows. An app only has the badges that were approved when it was connected.

- **Business details**: `business:read` reads business details, hours, services and staff. `business:write` updates business details and hours.
- **Calls**: `calls:read` reads calls, with their summaries and transcripts.
- **Contacts**: `contacts:read` reads contacts. `contacts:write` creates and updates contacts.
- **Appointments**: `appointments:read` reads appointments and open times. `appointments:write` books, cancels and reschedules appointments.
- **Messages**: `messages:read` reads the messages the receptionist took.
- **Knowledge**: `knowledge:read` reads the questions the receptionist couldn't answer. `knowledge:write` adds knowledge entries and FAQs.

## Connect the assistant to the app, on the Connected apps screen

The page that opens in your browser when you connect an assistant, after you sign in. Its title names the assistant. Only owners and admins can approve it, and **Cancel** turns the request down.

- **Business**: The business the assistant may work with. The list shows only the businesses where you are an owner or admin, starts on the one you have open, and is greyed out when there is only one. To use the assistant with another business, connect it again and choose that one.
- **What the assistant can do** (Required): The label names the assistant. It lists the kinds of access the assistant asked for, all ticked to start with. Clear any you don't want to give. With none ticked, selecting **Allow access** only shows "Choose at least one permission.", so at least one must stay ticked.

## How to connect an AI assistant, on the Connected apps screen

1. In the assistant's settings, add the app as a connection.
2. When the assistant asks, sign in with your dashboard account.
3. On the page that asks you to connect the assistant, choose the **Business** it may work with.
4. Clear any access you don't want to give.
5. Select **Allow access**. The assistant now shows on the **Connected apps** tab of that business.

## How to disconnect an app, on the Connected apps screen

1. Open **Settings** in the sidebar and select the **Connected apps** tab.
2. Select **Disconnect** on the app's row.
3. Confirm with **Disconnect**. A message confirms **App disconnected**, and the app loses access to this business right away.

## How to change what an app may do, on the Connected apps screen

1. Disconnect the app on this tab.
2. Connect it again from the assistant, and tick only the access it should have before you select **Allow access**.

## Good to know about the Connected apps screen

- Only owners and admins can connect an assistant, and only to businesses where they are an owner or admin.
- A connected app stops working when the person who connected it leaves the team or is no longer an owner or admin. Its row stays on this tab until someone disconnects it. Someone who is still an owner or admin can connect it again.
- After you disconnect an app, it needs to be connected and approved again before it can work with the business.
- As the page that asks you to connect warns, continue only if you started the connection from the assistant yourself.
- The same page names the account you're signed in as and, when it can, the website that asked for access and the one you go to after **Allow access**. Check them before you allow access.
- If the account is canceled from the **Team** tab, connected apps stop working. If the business is deleted, they are removed with it.
- API keys are the other way for tools to reach the business. They are made and revoked on the **API keys** tab.

## I see "Only owners and admins can manage connected apps". What can I do? (Connected apps screen)

Your role on this business doesn't include connected apps. Ask an owner or admin of the business to review them for you.

## The list says "No connected apps yet". How do I connect one? (Connected apps screen)

Connecting starts in the assistant, not here. Add the app as a connection in the assistant's settings, sign in, choose the business and select **Allow access**.

## An assistant that used to work has stopped. Why? (Connected apps screen)

Someone may have disconnected it, or the person who connected it is no longer an owner or admin of the business. Check this tab, then connect the assistant again as an owner or admin.

## When I connect an assistant, the page says "You can't connect apps yet". Why? (Connected apps screen)

Only owners and admins of a business can connect apps to it, and you aren't an owner or admin of any business. Ask an owner or admin to connect the app or to make you an admin.

## When I connect an assistant, the page says "This link doesn't work". What do I do? (Connected apps screen)

The connection request is missing or has expired. Start again from the assistant you're connecting.

## After I select Allow access, it says "We couldn't finish connecting." What do I do? (Connected apps screen)

The assistant wasn't connected. The message names the assistant to start again from: go back to it and connect again.

## It says "We couldn't disconnect the app. Try again." What do I do? (Connected apps screen)

The app is still connected. Check your connection and select **Disconnect** again.
