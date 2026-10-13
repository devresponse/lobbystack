import { describe, expect, it, vi } from "vitest";

const hashing = vi.hoisted(() => ({ running: 0, most: 0 }));
vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  // Echoes its input as the key, a few milliseconds later, so overlapping hashes can be counted.
  scrypt: (password: string, _salt: string, _length: number, _options: unknown, callback: (error: Error | null, key: Buffer) => void) => {
    hashing.running += 1;
    hashing.most = Math.max(hashing.most, hashing.running);
    setTimeout(() => {
      hashing.running -= 1;
      callback(null, Buffer.from(password));
    }, 5);
  },
}));

import { hashContactPasscodes } from "./contactPasscodes";

describe("hashContactPasscodes", () => {
  it("returns hashes in order, running at most two at once however many bulk changes run together", async () => {
    const entries = (prefix: string) => Array.from({ length: 5 }, (_, index) => ({ contactId: `${prefix}-${index}`, passcode: `48061${index}` }));
    const results = await Promise.all(["a", "b", "c"].map(async (prefix) => [prefix, await hashContactPasscodes(entries(prefix))] as const));
    expect(hashing.most).toBe(2);
    expect(hashing.running).toBe(0);
    for (const [prefix, hashes] of results) {
      expect(hashes).toHaveLength(5);
      hashes.forEach((hash, index) => {
        const [scheme, salt, key] = hash.split(":");
        expect(scheme).toBe("scrypt-v1");
        expect(salt).toMatch(/^[0-9a-f]{32}$/);
        expect(Buffer.from(key!, "hex").toString()).toMatch(new RegExp(`:contact-passcode:${prefix}-${index}:48061${index}$`));
      });
    }
    // The slots free up again for the next change.
    expect(await hashContactPasscodes([])).toEqual([]);
    expect(await hashContactPasscodes(entries("d").slice(0, 1))).toHaveLength(1);
  });
});
