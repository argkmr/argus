import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = name => fs.readFile(new URL(name, root), 'utf8');

test('removed Personal features have no frontend or backend implementation directories', async () => {
  for (const name of ['backend/src/main/java/com/argus/integrations', 'backend/src/main/java/com/argus/orchestration',
    'backend/src/main/java/com/argus/knowledge', 'backend/src/main/java/com/argus/activity',
    'backend/src/main/java/com/argus/agents/service/AgentProfileService.java',
    'backend/src/main/java/com/argus/agents/repository/AgentProfileRepository.java',
    'frontend/features/agents', 'public/local-ai-panel.mjs', 'public/token-usage.mjs',
    'public/execution-prompt-summary.mjs', 'public/prompt-usage-recovery.mjs'])
    await assert.rejects(fs.access(new URL(name, root)), { code: 'ENOENT' }, name);
});

test('Personal ships only Codex and Claude CLI adapters, without removed MCP integration arguments', async () => {
  const adapters = JSON.parse(await read('backend/src/main/resources/default-cli-provider-adapters.json'));
  assert.deepEqual(adapters.map(item => item.id).sort(), ['claude', 'codex']);
  assert.doesNotMatch(JSON.stringify(adapters), /bitbucket|coordination|ollama/i);
});

test('Personal shell has no removed navigation, execution trace, or connection handlers', async () => {
  const app = await read('public/app.js'), html = await read('public/index.html');
  assert.doesNotMatch(app, /\/api\/(?:integrations|orchestration|knowledge|activity)\b|executionTrace|openAgentProfile|openDiagnostics|localAiPanel/);
  assert.doesNotMatch(app, /connection-provider-tabs|data-connection-provider|switchConnectionProvider/);
  assert.doesNotMatch(html, /id="(?:agents-toggle|connections-toggle|connections-dialog|diagnostics-toggle|knowledge-dialog|execution-trace-dialog|local-ai-panel)"/);
  assert.doesNotMatch(html, /data-connection-provider|Specialized Slack bots/);
  assert.match(app, /openSourceReference/);
  assert.match(app, /installChatHistoryPanels/);
});

test('Personal identity, storage and credential namespaces cannot alias Full', async () => {
  const metadata = JSON.parse(await read('package.json'));
  assert.equal(metadata.build.appId, 'com.argus.personal');
  assert.equal(metadata.build.productName, 'Argus Personal');
  const main = await read('desktop/main.mjs');
  assert.match(main, /app\.setName\("Argus Personal"\)/);
  assert.match(main, /ARGUS_PROFILE_DIR/);
  assert.doesNotMatch(main, /ARGUS_SEMANTIC|Documents.*argus/);
  const secrets = await read('backend/src/main/java/com/argus/common/security/KeychainSecretStore.java');
  assert.match(secrets, /com\.argus\.personal/);
  assert.match(secrets, /argus-personal:/);
});

test('AI-kit creation is explicit and a failed run cannot automatically retry', async () => {
  const onboarding = await read('backend/src/main/java/com/argus/onboarding/service/RepositoryOnboardingService.java');
  assert.doesNotMatch(onboarding, /kits\.request\(/);
  const service = await read('backend/src/main/java/com/argus/onboarding/service/AiKitGenerationService.java');
  assert.match(service, /if \(automatic\) return null/);
  assert.match(service, /queue\.finish\(jobId, List\.of\(\)\)/);
  assert.match(service, /case "pause", "resume"/);
  assert.match(service, /case "start", "restart"/);
});
