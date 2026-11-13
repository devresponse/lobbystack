import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "team",
  title: "Team",
  section: "settings",
  summary: "See who can use this business's dashboard, invite people as admins or viewers, rename the business and, for owners, delete the business or cancel the account.",
  screenPaths: ["/settings/team"],
  location: ["Sidebar", "Manage", "Settings", "Team"],
  access: "Everyone on the team can see the business name and the list of members. Owners and admins can rename the business, invite people, remove members other than owners and cancel invitations. Only owners see **Delete business** or **Cancel account**.",
  purpose: [
    "The **Team** tab lists everyone who can open this business's dashboard, and the invitations that haven't been accepted yet. Each person signs in with their own account, so nobody has to share a login.",
    "Owners and admins invite people by email and choose their role. An **Admin** can invite and manage team members and change the business's settings and billing. A **Viewer** can look at calls, contacts and dashboard activity without changing anything.",
    "The same tab holds the business's name and, for owners, the way to close a business: **Delete business** erases a business and everything in it for good, and **Cancel account** closes the first business on your account without deleting anything.",
  ],
  areas: [
    { name: "Business name", description: "Shows the business's name, which appears across the dashboard and in the business details your customers see. Owners and admins see **Change** to rename it." },
    { name: "Members", description: "Lists each person on the team and each invitation still waiting, with its **Email** and **Role**. Under each address you see **Joined on** or **Invited on** and the date. **No email on file** shows for a member without an address." },
    { name: "Invite", description: "Opens **Invite a team member**, where you send an invitation by email. Only owners and admins see this button." },
    { name: "Pending and Hands over the business", description: "**Pending** marks an invitation that hasn't been accepted yet. **Hands over the business** marks an invitation that passes the business on: the person who accepts it becomes an owner, and the owner who sent it leaves the team. This kind of invitation is never sent from this screen, but you can cancel it here like any other." },
    { name: "More options", description: "The menu at the end of a row, for owners and admins. On a member it has **Remove**, and on an invitation it has **Cancel invite**. Rows for owners have no menu." },
    { name: "Delete business", description: "At the bottom of the tab, for owners only. It either has the **Delete business** button or says why this business can't be deleted." },
    { name: "Cancel account", description: "Shows to an owner in place of **Delete business**, on the first business of their account, once it's the only business they own." },
  ],
  fields: [
    {
      title: "Business name",
      description: "The dialog that opens from **Change**.",
      fields: [
        { name: "Business name", description: "The name of the business as your team and your customers should see it. Select **Save** to keep the change." },
      ],
    },
    {
      title: "Invite a team member",
      description: "The dialog that opens from **Invite**.",
      fields: [
        { name: "Email address", requirement: "required", description: "The address of the person you're inviting, one address only. **Send invitation** stays off until you type one. The person must sign in, or create an account, with this same address to join." },
        { name: "Select role", description: "**Admin** can invite and manage team members and update the business's settings and billing. **Viewer** can view calls, contacts and dashboard activity without making changes. When the dialog first opens, **Viewer** is selected." },
      ],
    },
    {
      title: "Delete business",
      description: "The dialog that opens from **Delete business**, for owners. **Cancel** closes it without deleting anything.",
      fields: [
        { name: "Type the business name to confirm", requirement: "required", description: "The label shows the business's name. Type it exactly as shown, capitals included. **Delete permanently** stays off until it matches." },
        { name: "Your password", requirement: "required", description: "The password you sign in with. **Delete permanently** stays off until you enter it. If it's wrong, the field clears so you can type it again." },
      ],
    },
    {
      title: "Cancel account",
      description: "The dialog that opens from **Cancel account**, for owners. **Keep my account** closes it without changing anything.",
      fields: [
        { name: "Type the business name to confirm", requirement: "required", description: "The label shows the business's name. Type it exactly as shown, capitals included. **Request cancellation** stays off until it matches." },
      ],
    },
  ],
  tasks: [
    {
      title: "Invite someone to the team",
      steps: [
        "Open **Settings** in the sidebar and select the **Team** tab.",
        "Select **Invite**.",
        "Enter the person's **Email address**.",
        "Under **Select role**, choose **Admin** or **Viewer**.",
        "Select **Send invitation**. A message confirms the address it went to, and the invitation shows in the list as **Pending** until the person accepts it.",
      ],
    },
    {
      title: "Rename the business",
      steps: [
        "Select **Change** next to **Business name**.",
        "Enter the new name.",
        "Select **Save**. The dialog closes once the name is saved.",
      ],
    },
    {
      title: "Remove someone from the team",
      steps: [
        "Open **More options** at the end of the person's row.",
        "Select **Remove**. There is no confirmation step: the person loses access to this business at once.",
      ],
    },
    {
      title: "Cancel an invitation",
      steps: [
        "Open **More options** at the end of the invitation's row.",
        "Select **Cancel invite**. The link in the invitation email stops working.",
      ],
    },
    {
      title: "Change someone's role",
      steps: [
        "Open **More options** on the person's row and select **Remove**. This also revokes the API keys they created for this business.",
        "Select **Invite** and invite the same email address with the new role, **Admin** or **Viewer**.",
        "Once the person accepts the new invitation, they have the new role.",
      ],
    },
    {
      title: "Delete a business",
      steps: [
        "Open the business you want to delete from the business menu at the top of the sidebar.",
        "Open **Settings** and select the **Team** tab.",
        "Select **Delete business** and read what will be erased.",
        "Type the business's name exactly as shown, and enter **Your password**.",
        "Select **Delete permanently**. A message confirms the business was deleted, and the dashboard opens on another of your businesses.",
      ],
    },
    {
      title: "Cancel your account",
      steps: [
        "On the **Team** tab of the first business on your account, select **Cancel account**.",
        "Type the business's name exactly as shown and select **Request cancellation**.",
        "The dialog shows **Check your email** with the address the link went to. Select **Done**.",
        "Open the email you receive and follow its link within 24 hours.",
        "Sign in as the owner who asked, if you aren't signed in already.",
        "Enter your password and select **Cancel account**. The page shows **Your account is canceled**.",
        "To use the app again with a new business, select **Start a new business**.",
      ],
    },
  ],
  notes: [
    "Owners and admins both show as **Admin** in the **Role** column. Only owners can delete the business or cancel the account.",
    "The **Invite** dialog offers admins and viewers only. A member given another role outside this screen, such as a scheduler, shows that role's name in the **Role** column.",
    "This screen has no way to change someone's role directly. Remove the person and invite them again with the new role. Inviting someone who is still on the team doesn't change their role.",
    "Tools that use an API key with `team:manage` access can also change a member's role, invite schedulers and hand the business over to a new owner. Their changes show in this list.",
    "An invitation link works for 7 days. An invitation that has run out still shows as **Pending**, so cancel it and send a new one.",
    "The invitation email is written in your dashboard language, which you choose on the **Preferences** tab.",
    "The receptionist uses the business name to say which business it answers for, on calls and in website chats, from moments after you rename it. A greeting that names the business doesn't change by itself, so edit it on the **AI settings** screen, for each receptionist when the business has several AI agents.",
    "Owners can't be removed from this screen. A business always keeps at least one owner.",
    "An admin can remove themselves too. They lose access to the business at once, and only an owner or admin can invite them back.",
    "Removing a member also cancels the pending invitations they sent or that were sent to their address, revokes the API keys they created for this business and stops the apps they connected from working.",
    "Everyone who joins gets alert emails until they change them. Each person chooses their own alerts on the **Notifications** tab.",
    "The first business on your account is the one you've owned longest. It can't be deleted. To close it, first delete the other businesses you own, then use **Cancel account** on it.",
    "A business that is the first business of another owner's account can't be deleted, by you or by them.",
    "Deleting a business erases its calls and recordings, chats, contacts, appointments, knowledge, settings, billing history and the team's access. Its phone numbers are released, every receptionist stops answering and a paid plan is canceled right away. Nothing can be restored, by you or by support.",
    "A deleted business's public page and website chat stop working, so take down any signs or QR codes that point to them.",
    "Canceling deletes nothing. Once you confirm, nobody on the team can open the business, its phone numbers stop answering calls and texts, its website chat, public page, API keys, connected apps and pending invitations stop working, and a paid plan is canceled. Its phone numbers are released after 30 days.",
    "A canceled business sends its customers nothing more, not even appointment reminders that were already scheduled.",
    "Asking to cancel changes nothing until you confirm from the email. The link works for 24 hours, and asking again sends a new link that replaces the old one.",
    "People keep their own accounts when a business is deleted or canceled: only their access to that business ends. After canceling, you can start again with a new business.",
  ],
  troubleshooting: [
    {
      question: "Why can't I see the Invite button or the menu on each row?",
      answer: "Only owners and admins can invite and remove people. Ask an owner or admin of the business to do it for you.",
    },
    {
      question: "The person I invited didn't get the email. What can I do?",
      answer: "Ask them to check their spam folder, and check the address in the list. If the address is wrong or the email is lost, open **More options** on the invitation, select **Cancel invite** and invite them again.",
    },
    {
      question: "Why does it say \"We couldn't send that invitation. Please try again.\"?",
      answer: "Check that you entered one valid email address. Each person can send 20 invitations an hour, so after many invitations, wait a while and try again.",
    },
    {
      question: "The person says the invitation link doesn't work. Why?",
      answer: "The link works for 7 days and stops working when the invitation is canceled. The person must also sign in, or create an account, with the address the invitation went to, and confirm that address. If the invitation has run out, cancel it and send a new one.",
    },
    {
      question: "How do I make someone else an owner of the business?",
      answer: "Not from this screen: its invitations make people admins or viewers. A business is handed over through the app's API, with a key that an owner created with `team:manage` access on the **API keys** tab. The new owner gets an invitation by email, which shows here as **Hands over the business**. Once they accept it, they become an owner and the owner who sent it leaves the team.",
    },
    {
      question: "Why doesn't Delete business have a button?",
      answer: "The section says why: this is the first business on your account, the first business on another owner's account, or the only business you own. Your first business can be closed with **Cancel account** once it's the only business you own.",
    },
    {
      question: "Delete permanently says to try again later. What does that mean?",
      answer: "Something is still going on with the business: a call is in progress, a phone number is being set up, or a plan purchase started less than an hour ago. Wait and try again. If it says the paid plan is being canceled, select **Delete permanently** again in a moment. If it says the plan couldn't be canceled, or that it's billed outside the app, contact support.",
    },
    {
      question: "It says \"Too many tries. Try again later.\" How long do I wait?",
      answer: "Each person can try to delete a business 10 times an hour, ask to cancel the account 5 times an hour and confirm a cancellation from the email 10 times an hour. Wait a while, up to an hour, then try again.",
    },
    {
      question: "The link in the email to confirm canceling doesn't work. Why?",
      answer: "The link works for 24 hours, only the newest link works, and you must sign in as the owner who asked. If it has run out or a newer one replaced it, select **Cancel account** on the **Team** tab again. If the page says a call is in progress, a phone number is being set up or a plan purchase started less than an hour ago, wait and open the link again while it still works.",
    },
    {
      question: "I didn't get the email to confirm canceling. What can I do?",
      answer: "The dialog names the address the link went to. Check your spam folder, or select **Cancel account** again to get a new link, which replaces the old one. Nothing changes until you confirm.",
    },
    {
      question: "It says \"Something went wrong. Please try again.\" and the Business name dialog stays open. Why?",
      answer: "The name wasn't saved. Check your connection and select **Save** again. The dialog closes once the name is saved.",
    },
    {
      question: "It says \"We couldn't remove that member.\" What do I do?",
      answer: "The same message shows when **Remove** or **Cancel invite** doesn't work. The person may already be off the team, or the invitation already accepted or canceled. Reload the page to see the list as it is now.",
    },
  ],
  related: ["accept-invitation", "cancel-account", "notifications", "preferences", "api-keys", "connected-apps", "account", "plan", "ai-settings"],
  keywords: ["team members", "users", "add user", "staff access", "invite", "invitation", "roles", "permissions", "admin", "viewer", "owner", "transfer ownership", "remove user", "business name", "rename business", "delete business", "cancel account", "close account"],
};

export default article;
