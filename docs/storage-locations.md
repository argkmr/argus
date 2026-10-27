# Argus Personal storage

For isolated verification, `ARGUS_PROFILE_DIR` selects an absolute private profile and `ARGUS_PORT` selects a free local port. Defaults are 4173 for Full and 4175 for Personal. These overrides do not migrate or modify another profile.

Electron resolves `app.getPath('appData')/Argus Personal` at runtime. On macOS this is `~/Library/Application Support/Argus Personal`. Each installation resolves its own home directory. Startup does not require a source checkout or Documents access. Java receives the absolute root through `ARGUS_DATA_DIR`.

| Path below application data | Purpose |
| --- | --- |
| `workspace.json` | Repositories, preferences, run configurations |
| `ai-tasks/` | Saved chats and queues |
| `context-attachments/` | User attachments |
| `repository-artifacts/` | Private generated AI kits and staging |
| `repository-contexts/` | Repository routing context |
| `production-snapshots/` | Temporary production source worktrees |
| `diagrams/` | Boards |
| `api-collections/` | API request collections, also passed as `ARGUS_API_COLLECTIONS_DIR` |
| `environments/`, `environments.json` | Environment metadata |
| `git-recovery/` | Recovery files for Git revert |
| `canvas-sharing/` | Invitations and board-sharing configuration |
| `ide/` | Regenerable editor indexes |

Directories are created before use and files written atomically. Startup checks read/write access to the root and collections directory. Errors identify the failing location. Bundled source is read-only and selected through `ARGUS_SOURCE_ROOT`.

Backup and recovery use sibling directories named `Argus Personal Backup Repository` and `Argus Personal Maintenance`. Credentials use the separate `argus-personal:` namespace. CLI credentials remain owned by their CLIs.

Personal listens on loopback port 4175; its optional Canvas-sharing listener defaults to 4187. Full uses 4173/4186. `ARGUS_CANVAS_PORT` can isolate the sharing listener during verification. The bundled Personal Chrome extension pairs with 4175 and is separate from Full's extension. Save Argus Changes retains the signed local-owner backup entitlement; unsupported installations show it as unavailable rather than enrolling themselves or copying another machine's credentials.

Reset operates on this edition's own storage and explicitly configured backup destination. It does not erase Argus Full's profile. Application data, credentials and generated kits are excluded from source distributions.
