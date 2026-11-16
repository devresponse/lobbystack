import { describe, expect, it } from "vitest";
import { z } from "zod";

import { parseBody, parseQuery } from "./request-input";

describe("parseBody and parseQuery", () => {
  const schema = z.object({
    name: z.string("Give it a name.").trim().min(1, "Give it a name."),
    minutes: z.coerce.number("Give a number of minutes.").int("Minutes are whole numbers.").optional(),
  });
  const body = (value: unknown) => new Request("http://localhost:3000/api/thing", { method: "POST", body: typeof value === "string" ? value : JSON.stringify(value) });
  const caught = async (request: Request) => await parseBody(request, schema).then(() => undefined, (error: unknown) => error as Response);

  it("returns the body it was given, trimmed and converted", async () => {
    await expect(parseBody(body({ name: " Haircut ", minutes: "30" }), schema)).resolves.toEqual({ name: "Haircut", minutes: 30 });
  });

  // AUDIT-007: a caller's mistake is a 400 that names the field, not a 500 with an error ID.
  it("answers a wrong field with 400, its name and every problem", async () => {
    const response = await caught(body({ name: "", minutes: 1.5 }));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({
      error: "name: Give it a name.",
      code: "invalid_request",
      details: [{ path: "name", message: "Give it a name." }, { path: "minutes", message: "Minutes are whole numbers." }],
    });
  });

  it("names the body itself when the body is not an object", async () => {
    const response = await caught(body(null));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toMatchObject({ error: expect.stringContaining("expected object") as string, details: [{ path: "(body)" }] });
  });

  it("answers text that isn't JSON with 400", async () => {
    const response = await caught(body("not json"));

    expect(response?.status).toBe(400);
    await expect(response?.json()).resolves.toEqual({ error: "Invalid JSON body.", code: "invalid_json" });
  });

  it("reads the query string, where an empty parameter means absent", () => {
    const query = (search: string) => parseQuery(new Request(`http://localhost:3000/api/thing${search}`), schema.partial());

    expect(query("?name=Haircut&minutes=30&other=ignored")).toEqual({ name: "Haircut", minutes: 30 });
    expect(query("?name=Haircut&minutes=")).toEqual({ name: "Haircut" });
    expect(() => query("?minutes=soon")).toThrow();
  });
});
