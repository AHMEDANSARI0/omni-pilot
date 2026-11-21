/**
 * Phase 10 - reading a record's slot without caring whether it has one.
 *
 * `Topic.slotIndex` and `Post.slotIndex` are optional so that code written before multiple slots existed
 * keeps compiling: a planner, an import, a test fixture, a fixture in a file this phase does not touch.
 * Every read goes through here instead of the field, which puts the meaning in one place - a record with
 * no slot is the **first slot of its day**, exactly like a single-slot day.
 *
 * This lives in its own module on purpose. The rest of Phase 10 replaces whole files (they change shape,
 * not just lines), and a whole-file replacement is skipped when an owner has edited that file. A helper
 * that other modules import must not ride on a replacement that can be skipped, or the import fails and
 * the type-check dies on a line nobody edited. A one-function module cannot be skipped: it either does not
 * exist yet and is created, or it is already there.
 */

/** A record as it may arrive from the database, a form, or an older caller: the slot may be absent. */
export interface Slotted {
  slotIndex?: number | null;
}

/**
 * The slot a record belongs to, with "missing" read as slot 0.
 *
 * Anything that is not a non-negative finite number - absent, `null`, `NaN`, a negative from a bad
 * import - becomes 0 rather than propagating a nonsense slot into a claim.
 */
export function slotOf(record: Slotted | null | undefined): number {
  const value = record?.slotIndex;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.floor(value);
}

/** The slot of a topic; see `slotOf`. */
export function slotOfTopic(topic: Slotted | null | undefined): number {
  return slotOf(topic);
}

/** The slot of a post; see `slotOf`. */
export function slotOfPost(post: Slotted | null | undefined): number {
  return slotOf(post);
}

/** True when this record is the first post of its day (the only kind a single-slot day ever has). */
export function isFirstSlot(record: Slotted | null | undefined): boolean {
  return slotOf(record) === 0;
}
