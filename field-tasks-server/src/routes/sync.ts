import { Router, Request, Response } from "express";
import { Task } from "../models/Task";
import { OperationLog } from "../models/OperationLog";

export const syncRouter = Router();

// ---- Wire format types ---------------------------------------------------
// These types describe what the API accepts and returns. They are NOT the
// same as either the client's WatermelonDB schema or the server's Mongo
// schema. Wire format is its own contract.

type IncomingOperation =
  | {
      operationId: string;
      type: "CREATE_TASK";
      payload: {
        id: string;
        title: string;
        completed: boolean;
        clientUpdatedAt: number;
      };
    }
  | {
      operationId: string;
      type: "UPDATE_TASK";
      payload: {
        id: string;
        title: string;
        completed: boolean;
        clientUpdatedAt: number;
        baseVersion: number; // NEW
      };
    }
  | {
      operationId: string;
      type: "DELETE_TASK";
      payload: {
        id: string;
        baseVersion: number; // NEW
      };
    };

type OperationResult = {
  operationId: string;
  status: "applied" | "duplicate" | "rejected" | "conflict";
  error?: string;
  task?: {
    id: string;
    title: string;
    completed: boolean;
    serverUpdatedAt: number;
    deleted: boolean;
    version: number;
  };
};

// ---- Helper to format a server task for the wire ------------------------
function taskToWire(t: any) {
  return {
    id: t._id,
    title: t.title,
    completed: t.completed,
    serverUpdatedAt: t.updatedAt.getTime(),
    deleted: !!t.deletedAt,
    version: t.version,
  };
}

// ---- The endpoint --------------------------------------------------------
syncRouter.post("/sync", async (req: Request, res: Response) => {
  // For now we read userId from a header. In Phase 6+ this becomes JWT auth.
  const userId = req.header("x-user-id");
  if (!userId) {
    return res.status(401).json({ error: "x-user-id header required" });
  }

  const operations: IncomingOperation[] = req.body?.operations ?? [];
  if (!Array.isArray(operations)) {
    return res.status(400).json({ error: "operations must be an array" });
  }

  const results: OperationResult[] = [];

  // Process operations IN ORDER. Order matters: a CREATE followed by a
  // DELETE on the same entity must run create-then-delete, not the reverse.
  for (const op of operations) {
    try {
      // 1. Idempotency check: have we processed this operationId before?
      const existing = await OperationLog.findById(op.operationId);
      if (existing) {
        results.push({
          operationId: op.operationId,
          status: "duplicate",
          task: existing.result as any,
        });
        continue;
      }

      // 2. Apply the operation based on type.
      let resultTask: ReturnType<typeof taskToWire> | undefined;

      if (op.type === "CREATE_TASK") {
        // upsert handles the edge case where the same task ID already exists
        // (shouldn't happen with nanoids, but defense in depth).
        const doc = await Task.findOneAndUpdate(
          { _id: op.payload.id, userId },
          {
            $setOnInsert: {
              _id: op.payload.id,
              userId,
              title: op.payload.title,
              completed: op.payload.completed,
              version: 1,
              lastOperationId: op.operationId,
            },
          },
          { upsert: true, new: true },
        );
        resultTask = taskToWire(doc);
      } else if (op.type === "UPDATE_TASK") {
        // Optimistic concurrency check: version in DB must match what the
        // client thought it was editing. Mongo does this atomically as part
        // of findOneAndUpdate's filter.
        const doc = await Task.findOneAndUpdate(
          {
            _id: op.payload.id,
            userId,
            version: op.payload.baseVersion, // ← the compare-and-swap
            deletedAt: null,
          },
          {
            $set: {
              title: op.payload.title,
              completed: op.payload.completed,
              lastOperationId: op.operationId,
            },
            $inc: { version: 1 },
          },
          { new: true },
        );

        if (!doc) {
          // Either the task doesn't exist, was deleted, or version mismatch.
          // Look it up to figure out which, and return appropriate result.
          const current = await Task.findOne({ _id: op.payload.id, userId });
          if (!current) {
            results.push({
              operationId: op.operationId,
              status: "rejected",
              error: "Task not found",
            });
            // Log so retries return the same result.
            await OperationLog.create({
              _id: op.operationId,
              userId,
              type: op.type,
              entityId: op.payload.id,
              result: null,
            });
            continue;
          }

          // Version mismatch or already deleted. Return the current server state
          // so the client can resolve the conflict.
          const conflictTask = taskToWire(current);
          results.push({
            operationId: op.operationId,
            status: "conflict",
            task: conflictTask,
          });
          await OperationLog.create({
            _id: op.operationId,
            userId,
            type: op.type,
            entityId: op.payload.id,
            result: conflictTask,
          });
          continue;
        }

        resultTask = taskToWire(doc);
      }  else if (op.type === 'DELETE_TASK') {
  // Conditional delete: only if version matches.
  const doc = await Task.findOneAndUpdate(
    {
      _id: op.payload.id,
      userId,
      version: op.payload.baseVersion,
      deletedAt: null,
    },
    {
      $set: {
        deletedAt: new Date(),
        lastOperationId: op.operationId,
      },
      $inc: { version: 1 },
    },
    { new: true }
  );

  if (!doc) {
    const current = await Task.findOne({ _id: op.payload.id, userId });
    if (!current || current.deletedAt) {
      // Already deleted (or never existed). Idempotent success.
      results.push({ operationId: op.operationId, status: 'applied' });
      await OperationLog.create({
        _id: op.operationId,
        userId,
        type: op.type,
        entityId: op.payload.id,
        result: null,
      });
      continue;
    }
    // Version mismatch — conflict.
    const conflictTask = taskToWire(current);
    results.push({
      operationId: op.operationId,
      status: 'conflict',
      task: conflictTask,
    });
    await OperationLog.create({
      _id: op.operationId,
      userId,
      type: op.type,
      entityId: op.payload.id,
      result: conflictTask,
    });
    continue;
  }

  resultTask = taskToWire(doc);
}

      // 3. Log the operation so retries return the same result.
      await OperationLog.create({
        _id: op.operationId,
        userId,
        type: op.type,
        entityId: (op as any).payload.id,
        result: resultTask,
      });

      results.push({
        operationId: op.operationId,
        status: "applied",
        task: resultTask,
      });
    } catch (err: any) {
      console.error("Operation failed:", op.operationId, err);
      results.push({
        operationId: op.operationId,
        status: "rejected",
        error: err?.message ?? "unknown error",
      });
    }
  }

  res.json({ results });
});

// ---- GET /sync ----------------------------------------------------------
// Returns all tasks for this user that have changed since `since` (a unix
// millisecond timestamp). The client passes its last-known sync timestamp
// and gets back the delta. Fresh devices pass since=0 and get everything.
syncRouter.get("/sync", async (req: Request, res: Response) => {
  const userId = req.header("x-user-id");
  if (!userId) {
    return res.status(401).json({ error: "x-user-id header required" });
  }

  const since = Number(req.query.since ?? 0);
  if (Number.isNaN(since)) {
    return res.status(400).json({ error: "since must be a number" });
  }

  // Find anything updated after `since` for this user, including deletions.
  // Note: `updatedAt > since`, not `>=`. Using strict greater-than avoids
  // re-fetching the same boundary record on every poll.
  const tasks = await Task.find({
    userId,
    updatedAt: { $gt: new Date(since) },
  })
    .sort({ updatedAt: 1 }) // chronological so client applies in order
    .lean();

  // Use the server's clock as the new sync cursor, NOT the client's.
  // Clients have unreliable clocks (timezone, drift, manual changes).
  // Always trust the server.
  const syncedAt = Date.now();

  res.json({
    syncedAt,
    changes: tasks.map((t) => ({
      id: t._id,
      title: t.title,
      completed: t.completed,
      deleted: !!t.deletedAt,
      serverUpdatedAt: (t.updatedAt as Date).getTime(),
      version: t.version,
    })),
  });
});
