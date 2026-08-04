import { and, eq, isNull, lt, ne } from "drizzle-orm";

import { db } from "../db/index.js";
import { memoryAssessments } from "../db/schema.js";
import { newId } from "../utils/id.js";

export type StoredMemoryAssessment<T = unknown> = {
  id: string;
  instanceId: string | null;
  receipt: T;
  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function fromRow<T>(
  row: typeof memoryAssessments.$inferSelect,
): StoredMemoryAssessment<T> {
  let receipt: unknown = null;
  try {
    receipt = JSON.parse(row.receiptJson) as unknown;
  } catch {
    // Let the assessment service surface an obsolete/invalid receipt without
    // taking down the complete instance health summary.
  }
  return {
    id: row.id,
    instanceId: row.instanceId,
    receipt: receipt as T,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createMemoryAssessmentDraft<T>(
  receipt: T,
): StoredMemoryAssessment<T> {
  const timestamp = nowIso();
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
  db.delete(memoryAssessments)
    .where(
      and(
        isNull(memoryAssessments.instanceId),
        lt(memoryAssessments.createdAt, cutoff),
      ),
    )
    .run();
  const row: typeof memoryAssessments.$inferInsert = {
    id: newId(),
    instanceId: null,
    receiptJson: JSON.stringify(receipt),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  db.insert(memoryAssessments).values(row).run();
  return fromRow<T>({ ...row, instanceId: null });
}

export function getMemoryAssessmentById<T>(
  id: string,
): StoredMemoryAssessment<T> | null {
  const row = db
    .select()
    .from(memoryAssessments)
    .where(eq(memoryAssessments.id, id))
    .get();
  return row ? fromRow<T>(row) : null;
}

export function getMemoryAssessmentForInstance<T>(
  instanceId: string,
): StoredMemoryAssessment<T> | null {
  const row = db
    .select()
    .from(memoryAssessments)
    .where(eq(memoryAssessments.instanceId, instanceId))
    .get();
  return row ? fromRow<T>(row) : null;
}

export function bindMemoryAssessment<T>(
  id: string,
  instanceId: string,
  receipt: T,
): void {
  db.delete(memoryAssessments)
    .where(
      and(
        eq(memoryAssessments.instanceId, instanceId),
        ne(memoryAssessments.id, id),
      ),
    )
    .run();
  db.update(memoryAssessments)
    .set({
      instanceId,
      receiptJson: JSON.stringify(receipt),
      updatedAt: nowIso(),
    })
    .where(eq(memoryAssessments.id, id))
    .run();
}

export function updateMemoryAssessmentReceipt<T>(id: string, receipt: T): void {
  db.update(memoryAssessments)
    .set({ receiptJson: JSON.stringify(receipt), updatedAt: nowIso() })
    .where(eq(memoryAssessments.id, id))
    .run();
}

export function renameMemoryAssessmentInstance(from: string, to: string): void {
  if (from === to) return;
  db.delete(memoryAssessments)
    .where(eq(memoryAssessments.instanceId, to))
    .run();
  db.update(memoryAssessments)
    .set({ instanceId: to, updatedAt: nowIso() })
    .where(eq(memoryAssessments.instanceId, from))
    .run();
}

export function deleteMemoryAssessmentForInstance(instanceId: string): void {
  db.delete(memoryAssessments)
    .where(eq(memoryAssessments.instanceId, instanceId))
    .run();
}
