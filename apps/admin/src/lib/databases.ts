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
