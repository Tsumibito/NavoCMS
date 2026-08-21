import { describe, expect, it } from "vitest";

import { withDatabaseScope, type SqlClient } from "./context.js";

class RecordingClient implements SqlClient {
  public readonly calls: { text: string; values?: readonly unknown[] }[] = [];
  public async query(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, ...(values ? { values } : {}) });
    return { rows: [] };
  }
}

const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  siteId: "11000000-0000-4000-8000-000000000001",
  principalId: "11100000-0000-4000-8000-000000000001"
};

describe("database scope", () => {
  it("sets validated transaction-local scope before application queries", async () => {
    const client = new RecordingClient();
    await withDatabaseScope(client, scope, async (transaction) => {
      await transaction.query("SELECT * FROM navocms.sites");
    });
    expect(client.calls.map(({ text }) => text.trim().split("\n")[0])).toEqual([
      "BEGIN",
      "SELECT",
      "SELECT * FROM navocms.sites",
      "COMMIT"
    ]);
    expect(client.calls[1]?.values).toEqual([scope.tenantId, scope.siteId, scope.principalId, ""]);
  });

  it("rolls back and rejects malformed scope identifiers", async () => {
    const client = new RecordingClient();
    await expect(withDatabaseScope(client, { ...scope, siteId: "site-two" }, async () => undefined)).rejects.toThrow(
      /siteId must be a UUID/
    );
    await expect(
      withDatabaseScope(client, scope, async () => {
        throw new Error("failed");
      })
    ).rejects.toThrow("failed");
    expect(client.calls.at(-1)?.text).toBe("ROLLBACK");
  });
});
