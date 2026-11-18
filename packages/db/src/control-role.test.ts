import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CONTROL_READABLE_COLUMNS, CONTROL_ROLE, CONTROL_ROLE_SETTINGS } from "./control-role";

const migration = readFileSync(fileURLToPath(new URL("../migrations/0153_control_panel_role.sql", import.meta.url)), "utf8");
const statements = migration.replace(/--[^\n]*/g, "").split(";").map((statement) => statement.replace(/\s+/g, " ").trim());

describe("the control panel's database role", () => {
  it("is granted exactly the columns verify-rls expects, table by table", () => {
    const granted: Record<string, string[]> = {};
    for (const statement of statements) {
      const grant = /^GRANT SELECT \(([^)]+)\) ON public\.(\w+) TO (\w+)$/.exec(statement);
      if (!grant) continue;
      expect(grant[3]).toBe(CONTROL_ROLE);
      granted[grant[2]!] = grant[1]!.split(",").map((column) => column.trim());
    }
    expect(granted).toEqual(CONTROL_READABLE_COLUMNS);
  });

  it("gives every table it reads its own policy", () => {
    const list = /FOREACH table_name IN ARRAY ARRAY\[([^\]]+)\]/.exec(migration.replace(/\s+/g, " "));
    const tables = list?.[1]?.split(",").map((table) => table.trim().replace(/^'|'$/g, ""));
    expect(tables?.sort()).toEqual(Object.keys(CONTROL_READABLE_COLUMNS).sort());
  });

  it("grants nothing but SELECT on columns and USAGE on schema public", () => {
    const grants = statements.filter((statement) => /^GRANT\b/i.test(statement));
    expect(grants.filter((statement) => !/^GRANT SELECT \(/.test(statement))).toEqual([`GRANT USAGE ON SCHEMA public TO ${CONTROL_ROLE}`]);
    expect(statements.join(";")).not.toMatch(/\bschema app\b/i);
  });

  it("starts its sessions read-only, with the time limits verify-rls expects", () => {
    for (const setting of CONTROL_ROLE_SETTINGS) {
      const [name, value] = setting.split("=");
      expect(statements).toContain(`ALTER ROLE ${CONTROL_ROLE} SET ${name} = ${name === "default_transaction_read_only" ? value : `'${value}'`}`);
    }
  });

  it("never reads a password, a token, an address or what a caller said", () => {
    const columns = Object.entries(CONTROL_READABLE_COLUMNS).flatMap(([table, names]) => names.map((name) => `${table}.${name}`));
    for (const secret of ["users.password_hash", "accounts.password", "accounts.access_token", "accounts.refresh_token", "accounts.id_token",
      "sessions.token", "sessions.ip_address", "sessions.user_agent", "messages.body", "messages.media", "calls.recording_object_id",
      "calls.origin_url", "calls.user_agent", "billing_accounts.billing_key", "business_invitations.token_hash"]) {
      expect(columns).not.toContain(secret);
    }
    for (const table of ["transcripts", "contacts", "verifications", "api_keys", "oauth_access_tokens", "oauth_refresh_tokens", "webhook_endpoints",
      "widget_keys", "calendar_connections", "contact_passcodes", "knowledge_documents", "audit_logs"]) {
      expect(CONTROL_READABLE_COLUMNS).not.toHaveProperty(table);
    }
  });
});
