import { LiveWidgetSettingsSurface } from "@/components/live-widget-settings-surface";
import { defaultWidgetKeyOrigin } from "@/lib/widget-keys";

// APP_BASE_URL is read when the page is asked for, never when the image is built.
export const dynamic = "force-dynamic";

export default function SettingsWidgetPage() {
  // A new key's allowed origins start with the deployment's own address, which the owner can change.
  return <LiveWidgetSettingsSurface defaultOrigin={defaultWidgetKeyOrigin()} />;
}
