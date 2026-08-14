import { logger } from "../logger.js";
import { migrations } from "./registry.js";

export function runMigrations(): string[] {
  const applied: string[] = [];
  for (const migration of migrations) {
    try {
      if (migration.isApplied()) {
        continue;
      }
      migration.apply();
      applied.push(migration.id);
    } catch (error) {
      logger.error(
        { error, migration: migration.id },
        "data migration failed; it will be retried on the next start",
      );
    }
  }
  return applied;
}
