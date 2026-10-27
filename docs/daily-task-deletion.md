# Permanent Daily Task deletion

Open an existing Daily Task (including an archived task) and choose **Delete permanently**. Confirm the task ID and title. Cancel keeps the task and unsaved draft. Archive remains the recoverable alternative.

API contract: `DELETE /api/daily-planner/tasks/{id}?revision={currentRevision}` returns HTTP 200 and the new planner Snapshot. It atomically removes the task, its events and all incoming/outgoing related-task links. Derived reports and missed-day counts no longer include the deleted task. Other tasks, sprint labels, settings and the monotonic next task number remain unchanged. Missing task: 404. Missing/invalid revision: 400. Stale revision: 409 with no mutation; refresh before retrying. Existing exported reports and backups are not rewritten or erased.
