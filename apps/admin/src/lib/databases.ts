import {
  createDatabaseClient,
  type AdminDatabaseRole,
  type DatabaseClient,
} from "@lobbystack/db";

const databases = new Map<AdminDatabaseRole, DatabaseClient>();

/**
 * Keep exactly one pg Pool per database role in the admin process. It takes only
 * the roles SERVICE_DATABASE_ROLES.admin lists, so connectionBudget("admin")
 * counts every pool an admin copy can open.
 */
export function getDatabase(role: AdminDatabaseRole): DatabaseClient {
  const existing = databases.get(role);
  if (existing) return existing;

  const database = createDatabaseClient(role);
  databases.set(role, database);
  return database;
}

/**
 * Ends every pool this copy of the module made and forgets them, so the next
 * getDatabase makes a new one. The start-up hook calls it after its role
 * check. Next.js builds that hook apart from the routes, each with its own
 * copy of this module, so the check's pools are never the ones the routes
 * use: left open, each would hold a connection for its 30 idle seconds on top
 * of the copy's connection budget, and count twice in the pools' gauges.
 */
export async function closeDatabases(): Promise<void> {
  const made = [...databases.values()];
  databases.clear();
  await Promise.all(made.map((database) => database.pool.end()));
}
