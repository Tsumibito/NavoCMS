import { randomBytes } from "node:crypto";

import { PostgresDatabase } from "@navocms/persistence-postgres";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresBrowserSessionRevocations } from "./postgres-browser-session-revocations.js";

const url = process.env.NAVOCMS_INTEGRATION_DATABASE_URL;
const database = url ? new PostgresDatabase({ connectionString: url, applicationName: "navocms-browser-session-test" }) : undefined;
afterAll(async () => { await database?.close(); });

describe.skipIf(!url)("persistent browser session revocation", () => {
  it("survives a new store instance and stays within its site", async () => {
    const session = {
      id: randomBytes(32).toString("base64url"),
      tenantId: "a2af348f-58b8-4efe-b873-8bd032ecbc5c",
      siteId: "2e0bcd4f-6780-470c-844b-d72abb6737ca",
      principalId: "016ef382-bf28-406b-9321-1fc580b6ea00",
      expiresAt: Date.now() + 60_000
    };
    const first = new PostgresBrowserSessionRevocations(database!);
    expect(await first.isRevoked(session)).toBe(false);
    await first.revoke(session);
    const restarted = new PostgresBrowserSessionRevocations(database!);
    expect(await restarted.isRevoked(session)).toBe(true);
    expect(await restarted.isRevoked({ ...session, siteId: "11111111-1111-4111-8111-111111111111" })).toBe(false);
  });
});
