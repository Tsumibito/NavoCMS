export interface QueryResult<TRow extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: readonly TRow[];
  readonly rowCount?: number;
}

export interface SqlClient {
  query<TRow extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<TRow>>;
}

export interface DatabaseScope {
  readonly tenantId: string;
  readonly siteId: string;
  readonly principalId: string;
  readonly environmentId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID.test(value)) throw new Error(`${field} must be a UUID`);
}

export async function withDatabaseScope<T>(
  client: SqlClient,
  scope: DatabaseScope,
  operation: (client: SqlClient) => Promise<T>
): Promise<T> {
  assertUuid(scope.tenantId, "tenantId");
  assertUuid(scope.siteId, "siteId");
  assertUuid(scope.principalId, "principalId");
  if (scope.environmentId) assertUuid(scope.environmentId, "environmentId");
  await client.query("BEGIN");
  try {
    await client.query(
      `SELECT
         set_config('navocms.tenant_id', $1, true),
         set_config('navocms.site_id', $2, true),
         set_config('navocms.principal_id', $3, true),
         set_config('navocms.environment_id', $4, true)`,
      [scope.tenantId, scope.siteId, scope.principalId, scope.environmentId ?? ""]
    );
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
