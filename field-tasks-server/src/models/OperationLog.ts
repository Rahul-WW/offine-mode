import { Schema, model } from 'mongoose';

// One row per operationId we've ever processed. Before applying any operation,
// we check this collection. If we find a row for the same operationId, we skip
// the work and return the cached result. This is what makes retries safe.
//
// Why a separate collection (vs storing operationId on the Task)?
// Because CREATE_TASK retries don't have a task to check yet. The operation log
// is the single source of "have I seen this operation before?" regardless of what
// kind of operation it is.
const OperationLogSchema = new Schema(
  {
    _id: { type: String, required: true }, // operationId itself is the primary key
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true }, // CREATE_TASK | UPDATE_TASK | DELETE_TASK
    entityId: { type: String, required: true },
    // Cached result so retries return the same response as the original.
    result: { type: Schema.Types.Mixed, required: true },
  },
  {
    timestamps: true,
    _id: false,
  }
);

// TTL: auto-delete log entries older than 30 days.
// We only need them long enough to handle realistic retry windows.
OperationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

export const OperationLog = model('OperationLog', OperationLogSchema);