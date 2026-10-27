# Argus Personal

An independent desktop workspace for repository code, Git, local services, API requests, diagrams, and Codex/Claude Code CLI chats. Build 20261027-400.

## First launch

Copy **Argus Personal.app** from the Apple Silicon DMG to Applications. The app contains its Java 17 runtime and native process helper. Its identifier is `com.argus.personal`; it uses loopback port 4175 and an independent profile. Argus Full uses port 4173.

Install and sign in to `claude` or `codex` using that provider's CLI. Argus discovers executable locations, authentication and models. A Claude-only machine is supported. Provider subscription access and usage limits remain controlled by the selected CLI.

Open a local Git repository. Code, Git and diagrams work independently of AI. Use **AI kit** in the repository header to Start, Pause, Resume, or Restart generation. Onboarding starts no AI-kit requests. Restart resets only that repository's private generated kit. Open history using the history icon inside chat.

## Storage

On macOS private data is stored in `~/Library/Application Support/Argus Personal`. API collections use its `api-collections` child. The backup checkout uses the sibling `Argus Personal Backup Repository`, and recovery work uses `Argus Personal Maintenance`. See [storage locations](docs/storage-locations.md).

Parent directories are created before writes. Packaged source is read-only inside the app bundle. Source archives omit user data, credentials, caches and generated artifacts. CLI authentication stays in the CLI's own standard storage.

## Build

Use Node 22.22.2+ and JDK 17+. Run `npm ci`, `npm run build:platform`, `npm run build:runtime`, `npm run build:source` and `npm run build:icon`. Package locally with `npx electron-builder --mac --arm64 -c.mac.identity=- -c.mac.notarize=false`.

The resulting DMG is locally signed. Public distribution requires the distributor's own Apple signing/notarization setup. Java editor language tooling separately needs a local JDK 21+ for Java projects; JavaScript/TypeScript tooling needs Node.

## Verification

`mvn -f backend/pom.xml clean verify` checks Java behavior and formatting. `npm test` runs retained frontend and desktop checks. Smoke-check packaged artifacts with a fresh isolated profile before distribution. The [AI-kit API contract](docs/repository-ai-kit-controls.md) documents lifecycle controls.

The backend binds to loopback and validates hosts/origins. CLI argument arrays are passed directly without a shell. Repository commands and edit-mode CLIs can modify selected repositories; choose Plan for investigation.
