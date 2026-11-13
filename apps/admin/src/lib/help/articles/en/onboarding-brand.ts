import type { HelpArticle } from "../../types";

const article: HelpArticle = {
  slug: "onboarding-brand",
  title: "Make this app your own",
  section: "getting-started",
  summary: "Choose the name and logo everyone sees across the app, in a one-time step that appears only while the app is new, before anyone has created a business.",
  screenPaths: ["/onboarding/brand"],
  location: ["Sign up", "Onboarding", "Step 2 of 8, before the business"],
  access: "This step appears only while the app is new: before anyone has created a business or chosen the app's name and logo, and only when the app doesn't already come with a name and logo of its own. The first person to save or skip it makes the choice, and nobody sees the step again.",
  purpose: [
    "This step names the app itself, before you set up your business. The name and logo you choose replace the app's current ones for everyone who uses it: on the sign-in and sign-up pages, at the top of every setup step, in the browser tab, at the foot of each business's public page and wherever the dashboard mentions the app by name. Emails and text messages the app sends use the new name too.",
    "The choice covers the whole app, not just your business. Every person and every business that signs up later sees the same name and logo.",
    "You make the choice once. After you select **Continue** or skip the step, it doesn't come back, and the dashboard has no screen to change the name or logo later. If you'd rather not choose, skip the step to keep the name and logo the app has now.",
  ],
  areas: [
    { name: "Logo and name at the top", description: "The app's current logo and name. They change to your choice as soon as you save." },
    { name: "App name", description: "The box for the new name. Until you type, it shows the app's current name as a hint. The line under it gives the limit of 40 characters and says the new name replaces the current one on every page and in the browser tab." },
    { name: "Logo", description: "The box for your logo. Select **Choose a logo** or drag an image onto it. Once you've chosen one, the box shows the image and **Choose another**, with a **Remove** button, an X, beside it. The line under it lists the image types the step takes and the size limit." },
    { name: "Preview", description: "Shows the name and logo as they will look at the top of the sign-in and setup pages, and updates as you type or choose a logo. Until you do, it shows the app's current name and logo." },
    { name: "Continue", description: "Saves the name and logo and opens the next step, where you name your business. It stays off until you type a name or choose a logo, and says **Saving...** while it works. A problem with the name, the logo or the saving shows just above it." },
    { name: "Skip and keep", description: "The link under **Continue**, followed by the app's current name. It keeps the current name and logo, ends the choice for good and opens the next step." },
    { name: "Progress dots", description: "Eight dots at the bottom show where you are in setup: the first is sign-up, and this step shares the second with the business name step that follows it. None of them opens a step yet, because your business doesn't exist yet." },
    { name: "Sign out", description: "At the top right, signs you out. When you sign in again, setup opens at this step until someone makes the choice." },
    { name: "Terms and Privacy", description: "At the bottom, open the terms of service and the privacy policy in a new tab." },
  ],
  fields: [
    {
      title: "Make this app your own",
      description: "Both fields are optional, but **Continue** needs at least one of them. To change neither, skip the step.",
      fields: [
        { name: "App name", requirement: "optional", description: "The name that replaces the app's current name on every page and in the browser tab. Up to 40 characters. Spaces at the start and end are dropped, and several spaces in a row become one. Leave it empty to keep the current name." },
        { name: "Logo", requirement: "optional", description: "A PNG, JPEG, WebP or SVG image of up to 256 KB, ideally square. It appears beside the name at the top of the sign-in and setup pages and as the icon in the browser tab. Leave it empty to go without a logo of your own, and check the **Preview** to see how the name looks then." },
      ],
    },
  ],
  tasks: [
    {
      title: "Give the app its own name and logo",
      steps: [
        "Type the new name in **App name**.",
        "Select **Choose a logo** and pick an image file, or drag the file onto the box.",
        "Check the **Preview**.",
        "Select **Continue**. The new name and logo appear right away, and the step for your business's name opens.",
      ],
    },
    {
      title: "Replace or remove the logo before you save",
      steps: [
        "To use a different image, select **Choose another** and pick the file.",
        "To go without a logo, select **Remove**, the X beside the logo.",
      ],
    },
    {
      title: "Keep the current name and logo",
      steps: [
        "Select the **Skip and keep** link under **Continue**. It ends with the app's current name.",
        "The app keeps its name and logo, and the step for your business's name opens. This step won't appear again.",
      ],
    },
  ],
  notes: [
    "The choice is made once for the whole app. Saving or skipping ends it for everyone, and the dashboard has no screen to change the name or logo afterwards, so check the **Preview** before you continue.",
    "You can set just one of the two. With a logo and no name, the app keeps its current name beside your logo. With a name and no logo, the **Preview** shows how the name will look.",
    "The logo is checked by what the file contains, not by its name, so a file renamed to end in `.png` that isn't really a PNG image is refused. An SVG image that contains scripts is refused too.",
    "A square logo works best, because the same image is the icon in the browser tab.",
    "This step names the app, not your business. You enter your business's name in the next step.",
  ],
  troubleshooting: [
    {
      question: "The step says the name and logo can no longer be chosen here. Why?",
      answer: "Someone made the choice first, for example in another browser tab or another person setting up the app at the same time, or someone else has already created a business on the app. The form gives way to that message and a **Continue** button, and the page shows the name and logo the app now has. Select **Continue** to go on and name your business.",
    },
    {
      question: "The step says \"Choose a PNG, JPEG, WebP or SVG image.\" or \"Choose a logo of 256 KB or less.\" Why is my logo refused?",
      answer: "The step takes PNG, JPEG, WebP and SVG images of 256 KB or less. It checks what the file really contains, so an image in another format that was only renamed is refused, and so is an SVG with scripts or other active content in it. Save the image as a PNG, make it smaller if needed, and choose it again.",
    },
    {
      question: "The step says \"Choose a name of 40 characters or fewer.\" but my name is shorter. Why?",
      answer: "The name probably contains hidden characters, such as ones copied along with text from another app, or parts of some emoji. Clear the box and type the name instead of pasting it.",
    },
    {
      question: "Why is the Continue button turned off?",
      answer: "Type a name or choose a logo first. To keep the current name and logo, select the **Skip and keep** link instead.",
    },
    {
      question: "The step says \"We couldn't save the name and logo. Please try again.\" What should I do?",
      answer: "Something went wrong while saving. Check your connection, then select **Continue**, or the **Skip and keep** link, again.",
    },
    {
      question: "How do I change the app's name or logo later?",
      answer: "The dashboard has no screen for it, because the choice is made once, on this step. If it has to change, contact support.",
    },
  ],
  related: ["sign-up", "onboarding-business", "log-in"],
  keywords: ["app name", "app logo", "logo", "branding", "rename the app", "white label", "custom logo", "browser tab icon", "favicon", "skip branding", "first setup"],
};

export default article;
