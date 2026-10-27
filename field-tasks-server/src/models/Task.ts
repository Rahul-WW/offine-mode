import { Schema, model, InferSchemaType } from 'mongoose';

// Server-side Task. Notice what's here that wasn't on the client:
//   - userId: the server holds many users' tasks; needs labeling
//   - version: increments on every server-accepted update; conflict detection in Phase 5
//   - lastOperationId: which operation produced the current state (debugging + extra idempotency)
//   - deletedAt: soft delete on the server too, so we can sync deletions to other devices later
const TaskSchema = new Schema(
  {
    // _id is a string (the client-generated nanoid), NOT a Mongo ObjectId.
    // Forcing this matters: client and server must agree on the ID.
    _id: { type: String, required: true },

    userId: { type: String, required: true, index: true },
    title: { type: String, required: true },
    completed: { type: Boolean, default: false },

    // Used for conflict resolution in Phase 5. Increments on every server write.
    version: { type: Number, default: 1 },

    // Soft delete. Phase 4 will use this to inform other devices.
    deletedAt: { type: Date, default: null, index: true },

    lastOperationId: { type: String, default: null },
  },
  {
    // Mongo's automatic createdAt/updatedAt. We rely on updatedAt for sync.
    timestamps: true,

    // Prevent Mongoose from auto-generating _id.
    _id: false,
  }
);

// Compound index: most queries are "tasks for this user, updated since X."
TaskSchema.index({ userId: 1, updatedAt: 1 });

export type TaskDoc = InferSchemaType<typeof TaskSchema> & { _id: string };
export const Task = model('Task', TaskSchema);