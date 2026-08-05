import { and, eq, isNull, lt, ne } from "drizzle-orm";

import { db } from "../db/index.js";
import { memoryAssessments } from "../db/schema.js";
import { newId } from "../utils/id.js";

export type StoredMemoryAssessment = {
  id: string;
  instanceId: string | null;
  receipt: unknown;
  createdAt: string;
  updatedAt: string;
};

function nowIso() {
  return new Date().toISOString();
}

function fromRow(
  row: typeof memoryAssessments.$inferSelect,
): StoredMemoryAssessment {
  let receipt: unknown = null;
  try {
    receipt = JSON.parse(row.receiptJson) as unknown;
  } catch {
    receipt = null;
  }
  return {
    id: row.id,
    instanceId: row.instanceId,
    receipt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createMemoryAssessmentDraft(
  receipt: unknown,
): StoredMemoryAssessment {
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
  const id = newId();
  db.insert(memoryAssessments)
    .values({
      id,
      instanceId: null,
      receiptJson: JSON.stringify(receipt),
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();
  return {
    id,
    instanceId: null,
    receipt,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function getMemoryAssessmentById(
  id: string,
): StoredMemoryAssessment | null {
  const row = db
    .select()
    .from(memoryAssessments)
    .where(eq(memoryAssessments.id, id))
    .get();
  return row ? fromRow(row) : null;
}

export function getMemoryAssessmentForInstance(
  instanceId: string,
): StoredMemoryAssessment | null {
  const row = db
    .select()
    .from(memoryAssessments)
    .where(eq(memoryAssessments.instanceId, instanceId))
    .get();
  return row ? fromRow(row) : null;
}

export function bindMemoryAssessment(
  id: string,
  instanceId: string,
  receipt: unknown,
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

export function updateMemoryAssessmentReceipt(
  id: string,
  receipt: unknown,
): void {
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
