/*
 * Source guards for the ADK integration:
 * - `@google/adk` is imported only by the facade (src/adk.ts),
 * - the facade re-exports exactly the approved symbols,
 * - no shipped source in the repository names an ADK code executor,
 *   LocalEnvironment, a Google model, the model registry, or a built-in
 *   Google / MCP / OpenAPI tool or cloud service.
 * Test files are exempt (they import prohibited classes to prove the guards).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = join(import.meta.dirname, '..', '..', '..');
const roots = ['apps/desktop/src', 'packages'];
const FACADE = 'packages/adk-runtime/src/adk.ts';

function shipped(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['node_modules', 'out', 'dist', 'release', '__fixtures__'].includes(entry.name)
        ? []
        : shipped(path);
    }
    const isSource = /\.(ts|vue)$/.test(entry.name) && !entry.name.endsWith('.d.ts');
    const isTestOnly =
      /\.test\.ts$/.test(entry.name) ||
      /^(testing|test-fixtures|vitest\.config|vitest\.live\.config|drizzle\.config)\.ts$/.test(
        entry.name,
      );
    return isSource && !isTestOnly ? [path] : [];
  });
}

const files = roots.flatMap((root) => shipped(join(repo, root)));
const rel = (file: string) => relative(repo, file).replace(/\\/g, '/');
/** Source without comments, so documentation may name what it prohibits. */
const code = (file: string) =>
  readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const PROHIBITED = [
  // Code execution and shell access.
  'UnsafeLocalCodeExecutor',
  'ContainerCodeExecutor',
  'AgentEngineSandboxCodeExecutor',
  'BuiltInCodeExecutor',
  'BaseCodeExecutor',
  'LocalEnvironment',
  'BaseEnvironment',
  // Google / cloud models and name-based model resolution.
  'Gemini',
  'ApigeeLlm',
  'LLMRegistry',
  'RoutedLlm',
  // Built-in Google, retrieval, MCP, OpenAPI and integration tools.
  'GOOGLE_SEARCH',
  'GoogleSearchTool',
  'UrlContextTool',
  'URL_CONTEXT',
  'EnterpriseWebSearchTool',
  'GoogleMapsGroundingTool',
  'VertexAiSearchTool',
  'VertexAiRagRetrievalTool',
  'LoadWebPageTool',
  'MCPToolset',
  'McpToolset',
  'OpenAPIToolset',
  'APIHubToolset',
  'ApplicationIntegrationToolset',
  'ToolboxToolset',
  // Model-driven tools are deferred (not part of this migration).
  'FunctionTool',
  'AgentTool',
  'LongRunningFunctionTool',
  // File, cloud and database services.
  'FileArtifactService',
  'GcsArtifactService',
  'DatabaseSessionService',
  'VertexAiSessionService',
  'VertexAiMemoryBankService',
  'VertexAiRagMemoryService',
] as const;

describe('ADK integration guards', () => {
  it('scans the shipped sources of every package', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.map(rel)).toContain(FACADE);
  });

  it('imports @google/adk only from the facade', () => {
    const importers = files
      .filter((file) =>
        /from\s+['"]@google\/adk(\/[^'"]*)?['"]|import\(\s*['"]@google\/adk/.test(code(file)),
      )
      .map(rel);
    expect(importers).toEqual([FACADE]);
  });

  it('never imports Google client libraries directly', () => {
    const offenders = files
      .filter((file) =>
        /['"](@google\/genai|@google-cloud\/[^'"]+|google-auth-library)['"]/.test(code(file)),
      )
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('re-exports exactly the approved ADK symbols', async () => {
    const facade = await import('./adk.js');
    expect(Object.keys(facade).sort()).toEqual(
      [
        'ADK_VERSION',
        'BaseLlm',
        'BaseSessionService',
        // Phase 4: base class of RegistryTool (the only BaseTool subclass, see below).
        'BaseTool',
        'InMemorySessionService',
        'LlmAgent',
        'Runner',
        'StreamingMode',
        // Phase 5: SqliteSessionService (event restore, state prefixes).
        'State',
        'createEvent',
        'isBaseLlm',
        'isLlmAgent',
      ].sort(),
    );
  });

  it('never names a code executor, LocalEnvironment, a Google model or a built-in cloud tool', () => {
    const offenders = files.flatMap((file) =>
      PROHIBITED.filter((name) => new RegExp(`\\b${name}\\b`).test(code(file))).map(
        (name) => `${rel(file)}: ${name}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('never lets shipped code admit tools to an agent (allowedTools is test-only)', () => {
    const offenders = files
      .filter((file) => !file.replace(/\\/g, '/').endsWith('packages/adk-runtime/src/guards.ts'))
      .filter((file) => /\ballowedTools\b/.test(code(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('defines no ADK tool other than RegistryTool, and no app code wires tools to an agent yet', () => {
    const subclasses = files.filter((file) => /extends\s+BaseTool\b/.test(code(file))).map(rel);
    expect(subclasses).toEqual(['packages/adk-runtime/src/tools/registry-tool.ts']);
    // Production Chat and Research (agent-runtime, desktop) must not create or admit bridged tools.
    const wiring = files
      .filter((file) => !rel(file).startsWith('packages/adk-runtime/'))
      .filter((file) => /createRegistryTools|registryTools|RegistryTool\b/.test(code(file)))
      .map(rel);
    expect(wiring).toEqual([]);
  });

  it('production Chat (phase 6) builds its agent with no tools of any kind', () => {
    const chat = files.filter((file) => rel(file).startsWith('packages/adk-runtime/src/chat/'));
    expect(chat.map(rel)).toEqual(['packages/adk-runtime/src/chat/adk-chat.ts']);
    for (const file of chat) {
      expect(code(file)).not.toMatch(
        /\btools\s*:|RegistryTool|createRegistryTools|registryTools|allowedTools|allowToolCalls|BaseTool/,
      );
    }
    // The desktop main process wires Chat only through the engine selector.
    const desktop = files.filter((file) => rel(file).startsWith('apps/desktop/src/'));
    for (const file of desktop) {
      expect(code(file), rel(file)).not.toMatch(/allowToolCalls\s*:\s*true/);
    }
  });

  it('Research model calls (phase 7) build their agent with no tools of any kind', () => {
    const research = files.filter((file) =>
      rel(file).startsWith('packages/adk-runtime/src/research/'),
    );
    expect(research.map(rel)).toEqual(['packages/adk-runtime/src/research/adk-research-model.ts']);
    for (const file of research) {
      expect(code(file)).not.toMatch(
        /\btools\s*:|RegistryTool|createRegistryTools|registryTools|allowedTools|allowToolCalls|BaseTool|outputSchema|outputKey|subAgents/,
      );
    }
    // The Research workflow itself never imports ADK: the step machine stays the orchestrator.
    const workflow = files.filter((file) => rel(file).startsWith('packages/agent-runtime/'));
    for (const file of workflow)
      expect(code(file), rel(file)).not.toMatch(/@rka\/adk-runtime|@google\/adk/);
  });

  it('only the authoritative boundary reads tool calls or final model text (raw text is never proof of execution)', () => {
    // Modules that may look at model function calls/responses or the raw final
    // text. Anything new must go through summarizeInvocation (tools/outcomes.ts).
    const allowed = [
      'packages/adk-runtime/src/engine.ts', // re-exports only
      'packages/adk-runtime/src/ollama/messages.ts', // wire conversion
      'packages/adk-runtime/src/structured.ts', // structured output parsing
      'packages/adk-runtime/src/tools/outcomes.ts', // the authoritative result
      'packages/adk-runtime/src/sessions/history.ts', // incomplete-invocation detection
      'packages/adk-runtime/src/chat/adk-chat.ts', // only to reject a tool call in Chat
      'packages/adk-runtime/src/research/adk-research-model.ts', // only to reject a tool call
    ];
    const readers = files
      .filter((file) => /\b(functionCall|functionResponse|finalResponseText)\b/.test(code(file)))
      .map(rel);
    expect(readers.sort()).toEqual(allowed.sort());
    // Chat rejects any tool call or response instead of reporting it.
    expect(code(join(repo, 'packages/adk-runtime/src/chat/adk-chat.ts'))).toMatch(
      /p\.functionCall \|\| p\.functionResponse\)\)\s*\{[\s\S]{0,200}throw new ModelProviderError\('invalid-response'/,
    );
  });

  it('keeps the entry point free of ADK so it is only loaded after env sanitisation', () => {
    const entry = code(join(repo, 'packages/adk-runtime/src/index.ts'));
    const runtime = code(join(repo, 'packages/adk-runtime/src/runtime.ts'));
    // Type-only re-exports are erased at build time.
    expect(entry).not.toMatch(
      /^export \{[^}]*\} from '\.\/(adk|engine|guards|local-llm|self-check)\.js'/m,
    );
    expect(runtime).not.toMatch(/^import [^t].*from '\.\/(adk|engine)\.js'/m);
    expect(runtime).toMatch(
      /sanitizeAdkEnvironment\(env\);\s*const engine = await import\('\.\/engine\.js'\)/,
    );
  });
});
