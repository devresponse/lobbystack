import { WidgetChatClient } from "@/components/widget/widget-chat-client";
import { widgetChallengeSiteKey } from "@/lib/widget-challenge";

// The root layout negotiates the request locale; widget keys are runtime data.
export const dynamic = "force-dynamic";

const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

export default async function WidgetEmbedPage({ params, searchParams }: { params: Promise<{ key: string }>; searchParams: Promise<{ color?: string | string[] }> }) {
  const { key } = await params;
  if (!key) return null;
  // The loader passes the bubble's color, so the chat is drawn in it before its settings load.
  const { color } = await searchParams;
  const initialColor = typeof color === "string" && COLOR_PATTERN.test(color) ? color : undefined;
  // The site key comes from the server as the page renders, so the chat runs the check exactly when the chat route wants it.
  return <WidgetChatClient widgetKey={decodeURIComponent(key)} initialColor={initialColor} challengeSiteKey={widgetChallengeSiteKey()} />;
}
