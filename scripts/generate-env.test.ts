import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { generateEnv } from "./generate-env.mjs";

describe("generateEnv", () => {
  it("replaces placeholder secrets and keeps other lines", () => {
    let counter = 0;
    const { output, generated } = generateEnv(
      ["# comment", "POSTGRES_PASSWORD=replace-with-a-long-local-password", "POSTGRES_PORT=15433", "OPENAI_API_KEY="].join("\n"),
      () => `secret-${++counter}`,
    );

    expect(output).toBe(["# comment", "POSTGRES_PASSWORD=secret-1", "POSTGRES_PORT=15433", "OPENAI_API_KEY="].join("\n"));
    expect(generated).toEqual(["POSTGRES_PASSWORD"]);
  });

  it("clears provider credentials instead of generating them", () => {
    const { output, generated } = generateEnv("TWILIO_AUTH_TOKEN=replace-with-twilio-auth-token\nPOLAR_WEBHOOK_SECRET=replace-with-polar-webhook-secret");

    expect(output).toBe("TWILIO_AUTH_TOKEN=\nPOLAR_WEBHOOK_SECRET=");
    expect(generated).toEqual([]);
  });

  it("clears Stripe's credentials too, and leaves the provider choice as it is", () => {
    const { output, generated } = generateEnv("BILLING_PROVIDER=\nSTRIPE_API_KEY=replace-with-stripe-key\nSTRIPE_WEBHOOK_SECRET=replace-with-stripe-webhook-secret\nSTRIPE_METER_WEBHOOK_SECRET=replace-with-stripe-meter-secret");

    expect(output).toBe("BILLING_PROVIDER=\nSTRIPE_API_KEY=\nSTRIPE_WEBHOOK_SECRET=\nSTRIPE_METER_WEBHOOK_SECRET=");
    expect(generated).toEqual([]);
  });

  it("clears every provider credential of the real .env.example", () => {
    const { output } = generateEnv(readFileSync(new URL("../.env.example", import.meta.url), "utf8"), () => "generated");

    for (const key of ["TWILIO_AUTH_TOKEN", "POLAR_WEBHOOK_SECRET", "STRIPE_API_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_METER_WEBHOOK_SECRET"]) {
      expect(output).toMatch(new RegExp(`^${key}=$`, "m"));
    }
  });

  it("generates production-length secrets by default", () => {
    const { output } = generateEnv("BETTER_AUTH_SECRET=replace-with-at-least-32-random-characters");

    expect(output).toMatch(/^BETTER_AUTH_SECRET=[0-9a-f]{64}$/);
  });

  it("reads Windows line endings and writes LF", () => {
    const { output, generated } = generateEnv("# comment\r\nPOSTGRES_PASSWORD=replace-with-a-long-local-password\r\nPOSTGRES_PORT=15433\r\n", () => "pw");

    expect(output).toBe("# comment\nPOSTGRES_PASSWORD=pw\nPOSTGRES_PORT=15433\n");
    expect(generated).toEqual(["POSTGRES_PASSWORD"]);
  });

  it("fills a generated password into DATABASE_URL", () => {
    const { output, generated } = generateEnv(
      "POSTGRES_PASSWORD=replace-with-a-long-local-password\nDATABASE_URL=postgres://postgres:replace-with-a-long-local-password@127.0.0.1:15433/lobbystack",
      () => "pw",
    );

    expect(output).toBe("POSTGRES_PASSWORD=pw\nDATABASE_URL=postgres://postgres:pw@127.0.0.1:15433/lobbystack");
    expect(generated).toEqual(["POSTGRES_PASSWORD"]);
  });
});
