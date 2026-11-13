import type { ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/lib/api-helpers", () => ({ getWorkerDatabase: () => ({ db: {} }) }));
vi.mock("@/components/live-widget-settings-surface", () => ({ LiveWidgetSettingsSurface: () => null }));

import SettingsWidgetPage, { dynamic } from "./page";

afterEach(() => { vi.unstubAllEnvs(); });

it("starts a new key's allowed origins at the deployment's own address, read for each request", () => {
  const defaultOrigin = () => (SettingsWidgetPage() as ReactElement<{ defaultOrigin: string }>).props.defaultOrigin;
  vi.stubEnv("APP_BASE_URL", "https://dev2.realinfobot.example/");
  expect(defaultOrigin()).toBe("https://dev2.realinfobot.example");
  vi.stubEnv("APP_BASE_URL", "");
  expect(defaultOrigin()).toBe("");
  // Rendered when asked for, so a deployment's address is never the one the image was built with.
  expect(dynamic).toBe("force-dynamic");
});
