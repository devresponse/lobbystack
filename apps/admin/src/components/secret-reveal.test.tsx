// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SecretReveal } from "./secret-reveal";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(cleanup);

it("keeps the secret out of session replay", () => {
  render(<SecretReveal value="lsk_fixture_secret" warning="Copy it now." />);
  expect(screen.getByTestId("secret-value").classList.contains("ph-no-capture")).toBe(true);
});
