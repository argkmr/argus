# Build 400 — Argus Personal

Independent source edition based on Full build 399's fixes. Claude prompts use standard input with an explicit option boundary, avoiding directory-argument ambiguity and large prompt arguments. Manual AI-kit lifecycle controls, chat-header task history, repository editor citations, and provider-independent Git remotes are included.

The Connections/Slack/Bitbucket integration implementation, specialist-agent orchestration, Argus global activity-log feature, execution/context-transparency UI and prompt snapshots, Argus Knowledge, SQLite chat-memory retrieval and managed Ollama runtime are removed from frontend and backend source. They are not disabled feature flags. Codex/Claude CLI execution, repository AI kits, native editor/Git, service run logs, terminal, diagrams and daily tools remain.

Identity is `com.argus.personal`, product `Argus Personal`. Its data, maintenance/backup directories and Keychain namespaces are separate from Full. No application data, credentials, user repositories, chats or generated kits are distributed with the source.

See `storage-locations.md` for portable runtime paths. Install and authenticate a supported CLI separately; Argus does not include a subscription or credentials. A successful local fixture test cannot establish the limits or availability of another Mac's Claude account.
