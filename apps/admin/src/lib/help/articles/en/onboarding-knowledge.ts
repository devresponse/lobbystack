import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-knowledge",
  title: "Add training documents",
  section: "getting-started",
  summary: "Upload files or paste text about your business so your AI receptionist can answer questions from them, or skip the step and add them later.",
  screenPaths: ["/onboarding/knowledge"],
  location: ["Sign up", "Onboarding", "Step 4 of 8"],
  access: "Only owners and admins of the business can upload files, add text or go on from this step.",
  purpose: [
    "This step gives your AI receptionist its first information about your business. Upload documents you already have, such as a price list, a menu, answers to frequently asked questions or your policies, or paste the same kind of information as text. The receptionist uses it to answer questions from callers and website visitors.",
    "Everything you add here appears on the **Knowledge** screen. There you can later check it, edit text entries, turn items off or delete them, and add more, including your website.",
    "The app also reads what you add to fill in your **Business summary** and **Opening hours**, unless you've set them yourself. You can check both on the **AI settings** screen.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's own logo and name, as on the sign-in page." },
    { name: "Website reading progress", description: "Appears at the top only when a website is already part of your business's knowledge, being read or already read. While the app reads it, the panel shows **Reading** with the site's address, a progress bar and counts of the pages read so far and the pages ready for questions, and it updates by itself. When it's done, it says how many pages are ready for questions. If reading failed, it says so and suggests adding your details by hand or trying the import again from the dashboard. It doesn't appear for the address saved on the website step, because that step doesn't read the site." },
    { name: "Upload files and Paste text", description: "Two tabs for the two ways to add information. **Upload files** is open when the step starts." },
    { name: "Upload box", description: "On the **Upload files** tab, the box that says **Drag & drop or click to upload**, with the file types it takes listed under it. Drop files onto it, or select it to choose files from your device." },
    { name: "File list", description: "Under the upload box, the files already uploaded for the business and the ones uploading now. A spinner means a file is still uploading, a check mark means it's uploaded, and a message in red explains why a file couldn't be uploaded or used. A file that is uploading, or that failed to upload, has an X button that clears it from the list." },
    { name: "Continue", description: "Saves any text on the **Paste text** tab and opens the next step, where you set the greeting. You can select it without adding anything. It says **Saving...** while it works, and while a file uploads. A problem with continuing or skipping shows just above it." },
    { name: "Skip for now", description: "The link under **Continue**. It opens the next step without saving the text on the **Paste text** tab, and says **Skipping...** while it works. Files you've already uploaded stay." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step is the fourth. From the second dot on, the dot of a step your business has already reached opens that step." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at the step your business is on." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "Upload files",
      description: "The tab that's open when the step starts.",
      fields: [
        { name: "Drag & drop or click to upload", requirement: "optional", description: "Drop files onto the box, or select it to choose files from your device. PDF, DOCX, TXT and Markdown files of up to 25 MB each are supported, and you can choose several at once. Files start uploading as soon as you choose them, one at a time." },
      ],
    },
    {
      title: "Paste text",
      fields: [
        { name: "Paste any business info: services, FAQ, hours, policies...", requirement: "optional", description: "Type or paste anything the receptionist should know, such as your services, answers to common questions, your hours or your policies. When you select **Continue**, the text is saved as one text entry named **Onboarding notes**." },
      ],
    },
  ],
  tasks: [
    {
      title: "Upload documents",
      steps: [
        "On the **Upload files** tab, drag your files onto the box, or select the box and choose them.",
        "Wait until each file shows a check mark, which means it's uploaded. If a file shows a message in red, fix the file and choose it again.",
        "Select **Continue** to go on to the greeting step.",
      ],
    },
    {
      title: "Add information as text",
      steps: [
        "Select the **Paste text** tab.",
        "Paste or type your business information in the box.",
        "Select **Continue**. The text is saved as **Onboarding notes** and the greeting step opens.",
      ],
    },
    {
      title: "Skip this step",
      steps: [
        "Select **Skip for now**. The greeting step opens.",
        "After setup, add documents and text on the **Knowledge** screen with **Add Knowledge**.",
      ],
    },
  ],
  notes: [
    "Files are saved as soon as they finish uploading, even if you then select **Skip for now**. Text on the **Paste text** tab is saved only when you select **Continue**, even though the line under the box says it's added immediately.",
    "Each file can be up to 25 MB. The upload box lists the types it takes: PDF, DOCX, TXT and Markdown.",
    "After a file uploads, the app reads it in the background. You don't have to wait for that: go on with setup and check the file's status on the **Knowledge** screen later.",
    "A problem the app finds while reading a file shows under the file the next time this list loads, for example when you come back to this step, and on the **Knowledge** screen.",
    "**Continue** and **Skip for now** are turned off while a file is uploading.",
    "The X beside a file that is still uploading only hides it from the list: the upload goes on, and the file shows in the list again once it's uploaded.",
    "The text box is empty each time you open this step. Text you saved before is on the **Knowledge** screen, and continuing with new text adds another **Onboarding notes** entry.",
    "Everything you add here is for every receptionist the business has. If you add more AI agents later, **Available to** on the **Knowledge** screen chooses which of them use each item.",
    "How much document and website text a business can keep depends on its plan. Text you paste here doesn't count.",
  ],
  troubleshooting: [
    {
      question: "My file won't upload. What can I check?",
      answer: "Check its size: a file over 25 MB shows \"Documents must be 25 MB or smaller.\" Save a smaller copy or split the document, then choose it again. A file of a type the step doesn't take, such as an older Word document or a spreadsheet, shows \"We couldn't upload that document. Please try again.\" Save it as a PDF or DOCX file first. Some browsers don't say what kind of file a Markdown file is, and the step then refuses it the same way: paste its text on the **Paste text** tab, or upload it on the **Knowledge** screen after setup. For any other failure, check your connection and try again. If it keeps failing, the business's knowledge storage may be full: go on with setup and check **Knowledge base** on the **Usage** screen.",
    },
    {
      question: "What does \"We couldn't read the text in this document\" under a file mean?",
      answer: "The app couldn't get readable text out of that file, as with a scanned PDF of more than 25 pages. \"No readable text was extracted from the document.\" means the same. Upload another copy of it, such as a PDF saved from the original document, or paste its text on the **Paste text** tab instead.",
    },
    {
      question: "I uploaded the wrong file. How do I remove it?",
      answer: "This step can't delete a file once it's uploaded. Go on with setup, then delete the file on the **Knowledge** screen.",
    },
    {
      question: "A file says \"Knowledge storage limit reached.\" What now?",
      answer: "The file uploaded, but its text would take the business over the knowledge text its plan includes, so the receptionist can't use it. Go on with setup. Afterwards, on the **Knowledge** screen, remove items you don't need, then delete the failed file and upload it again. Or move to a plan with more room on the **Plan** screen.",
    },
    {
      question: "The step says \"We couldn't continue right now.\" or \"We couldn't skip this step right now.\" What should I do?",
      answer: "Check your connection and try again. If you had pasted text, it may already be saved, so continuing again can add a second **Onboarding notes** entry: delete the extra one on the **Knowledge** screen after setup. If you joined a business someone else owns and it isn't set up yet, only its owners and admins can finish its setup, so ask one of them.",
    },
    {
      question: "I added text here, but the box is empty when I come back. Was it lost?",
      answer: "No. The box starts empty each time. Your text was saved as **Onboarding notes** on the **Knowledge** screen, where you can edit it after setup.",
    },
  ],
  related: ["onboarding-website", "onboarding-greeting", "knowledge", "ai-settings", "setup-guide"],
  keywords: ["training documents", "upload files", "knowledge base", "documents", "FAQ", "price list", "paste text", "train the AI", "onboarding notes"],
};

export default article;
