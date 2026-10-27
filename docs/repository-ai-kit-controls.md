# Repository AI kit controls

Connecting a repository and launching Argus create no AI-kit request. Generation is an explicit user action in the repository code view. Failed generation has no automatic retry.

The local API exposes `GET /api/repositories/{id}/ai-kit`, returning `{repositoryId, automatic:false, ready:boolean, job:object|null}`. It reads local status without starting a CLI. Unknown repository IDs return 404.

`POST /api/repositories/{id}/ai-kit/{action}` supports `start`, `pause`, `resume`, `restart` and returns the same status envelope. Invalid actions or missing active jobs return 400. Start is idempotent while work is active. Pause/resume use the existing background-operation process controls. Interrupted work after application exit requires Start. Restart drains the old CLI before deleting this repository's private generated kit/staging directories and creating one replacement request. It never removes source code, chats, exported files or other repositories' data. The UI confirms restart's artifact reset.

All calls use Argus's existing loopback origin/host and native request protections. No separate cloud API or account is required. The underlying CLI subscription and availability are checked when used.
