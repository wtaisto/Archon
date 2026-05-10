/**
 * Tests for workflow-level `loop_until` semantics in `executeWorkflow`.
 *
 * Covers: termination on true, max-iteration cap, expression evaluation via
 * condition-evaluator, fresh-run isolation per iteration, pause/failure
 * short-circuit, default max_iterations.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';

// --- Mock logger ---
const mockLogFn = mock(() => {});
const mockLogger = {
  info: mockLogFn,
  warn: mockLogFn,
  error: mockLogFn,
  debug: mockLogFn,
  trace: mockLogFn,
  fatal: mockLogFn,
  child: mock(() => mockLogger),
  bindings: mock(() => ({ module: 'test' })),
  isLevelEnabled: mock(() => true),
  level: 'info',
};
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  parseOwnerRepo: mock(() => null),
  getRunArtifactsPath: mock(() => '/tmp/artifacts'),
  getProjectLogsPath: mock(() => '/tmp/logs'),
  captureWorkflowInvoked: mock(() => {}),
  BUNDLED_VERSION: 'test',
}));

// --- Mock git ---
mock.module('@archon/git', () => ({
  getDefaultBranch: mock(async () => 'main'),
  toRepoPath: mock((p: string) => p),
}));

// --- Mock dag-executor ---
const mockExecuteDagWorkflow = mock(async (): Promise<string | undefined> => undefined);
mock.module('./dag-executor', () => ({
  executeDagWorkflow: mockExecuteDagWorkflow,
}));

// --- Mock logger functions ---
mock.module('./logger', () => ({
  logWorkflowStart: mock(async () => {}),
  logWorkflowError: mock(async () => {}),
}));

// --- Mock event emitter ---
const mockEmitter = {
  registerRun: mock(() => {}),
  unregisterRun: mock(() => {}),
  emit: mock(() => {}),
};
mock.module('./event-emitter', () => ({
  getWorkflowEventEmitter: mock(() => mockEmitter),
}));

// --- Bootstrap provider registry (after path mocks) ---
import { registerBuiltinProviders, clearRegistry } from '@archon/providers';
clearRegistry();
registerBuiltinProviders();

// --- Import after mocks ---
import { executeWorkflow } from './executor';
import type { WorkflowDeps, IWorkflowPlatform, WorkflowConfig } from './deps';
import type { IWorkflowStore } from './store';
import type { WorkflowDefinition, WorkflowRun } from './schemas';

// --- Helpers ---

function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-iter-1',
    workflow_name: 'test-loop',
    conversation_id: 'conv-1',
    status: 'running',
    started_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

function makeStore(overrides: Partial<IWorkflowStore> = {}): IWorkflowStore {
  return {
    getActiveWorkflowRunByPath: mock(async () => null),
    failOrphanedRuns: mock(async () => ({ count: 0 })),
    createWorkflowRun: mock(async () => makeRun()),
    updateWorkflowRun: mock(async () => {}),
    failWorkflowRun: mock(async () => {}),
    getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'completed' as const })),
    createWorkflowEvent: mock(async () => {}),
    findResumableRun: mock(async () => null),
    getCompletedDagNodeOutputs: mock(async () => new Map()),
    resumeWorkflowRun: mock(async () => makeRun()),
    getCodebase: mock(async () => null),
    getCodebaseEnvVars: mock(async () => ({})),
    ...overrides,
  } as unknown as IWorkflowStore;
}

function makePlatform(): IWorkflowPlatform {
  return {
    sendMessage: mock(async () => {}),
    getPlatformType: mock(() => 'test' as const),
  } as unknown as IWorkflowPlatform;
}

function makeDeps(store?: IWorkflowStore): WorkflowDeps {
  return {
    store: store ?? makeStore(),
    loadConfig: mock(
      async (): Promise<WorkflowConfig> => ({
        assistant: 'claude' as const,
        assistants: { claude: {}, codex: {} },
        baseBranch: '',
        commands: { folder: '' },
      })
    ),
    getAgentProvider: mock(() => ({ run: mock(async () => {}) })),
  } as unknown as WorkflowDeps;
}

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'test-loop',
    description: 'Test',
    nodes: [{ id: 'picker', prompt: 'Pick something' }],
    ...overrides,
  } as WorkflowDefinition;
}

/**
 * Create a store where each call to `createWorkflowRun` returns a row with a
 * sequentially-numbered id, and `getCompletedDagNodeOutputs` returns the map
 * for that run id from the supplied script.
 */
function makeIteratingStore(perIterationOutputs: Array<Map<string, string>>): {
  store: IWorkflowStore;
  createSpy: ReturnType<typeof mock>;
  outputsSpy: ReturnType<typeof mock>;
} {
  let createCount = 0;
  const idForCall = (idx: number): string => `run-iter-${String(idx + 1)}`;

  const createSpy = mock(async () => {
    const id = idForCall(createCount);
    createCount++;
    return makeRun({ id });
  });

  const outputsSpy = mock(async (runId: string) => {
    const idx = parseInt(runId.replace('run-iter-', ''), 10) - 1;
    return perIterationOutputs[idx] ?? new Map<string, string>();
  });

  const store = makeStore({
    createWorkflowRun: createSpy,
    getCompletedDagNodeOutputs: outputsSpy,
  });

  return { store, createSpy, outputsSpy };
}

// ---------------------------------------------------------------------------

describe('executeWorkflow — loop_until', () => {
  beforeEach(() => {
    mockLogFn.mockClear();
    mockExecuteDagWorkflow.mockClear();
    mockEmitter.registerRun.mockClear();
    mockEmitter.unregisterRun.mockClear();
    mockEmitter.emit.mockClear();
    mockExecuteDagWorkflow.mockImplementation(async (): Promise<string | undefined> => undefined);
  });

  it('runs a single iteration when loop_until is unset (parity with prior behavior)', async () => {
    const { store, createSpy } = makeIteratingStore([new Map()]);
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow(),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('terminates on the iteration where loop_until evaluates true', async () => {
    // Iter 1: picker.output.empty == 'false' → keep going.
    // Iter 2: picker.output.empty == 'true'  → stop.
    const { store, createSpy, outputsSpy } = makeIteratingStore([
      new Map([['picker', JSON.stringify({ empty: 'false', next: '111' })]]),
      new Map([['picker', JSON.stringify({ empty: 'true' })]]),
    ]);
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ loop_until: "$picker.output.empty == 'true'" }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(outputsSpy).toHaveBeenCalledTimes(2);
    if (result.success) {
      expect(result.workflowRunId).toBe('run-iter-2');
    }
  });

  it('fails after max_iterations when loop_until is never satisfied', async () => {
    // Every iteration returns empty: 'false' → never terminates.
    const outputsPerIter = Array.from(
      { length: 10 },
      () => new Map([['picker', JSON.stringify({ empty: 'false', next: '111' })]])
    );
    const { store, createSpy } = makeIteratingStore(outputsPerIter);
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({
        loop_until: "$picker.output.empty == 'true'",
        max_iterations: 3,
      }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(3);
    if (!result.success) {
      expect(result.error).toContain('max_iterations');
      expect(result.error).toContain('3');
    }
  });

  it('defaults max_iterations to 20 when omitted', async () => {
    const outputsPerIter = Array.from(
      { length: 25 },
      () => new Map([['picker', JSON.stringify({ empty: 'false' })]])
    );
    const { store, createSpy } = makeIteratingStore(outputsPerIter);
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ loop_until: "$picker.output.empty == 'true'" }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(20);
  });

  it('creates a fresh WorkflowRun per iteration (no cross-iteration nodeOutputs leak)', async () => {
    // Iter 1's outputs say "keep going"; iter 2's say "stop".
    // The condition-evaluator must be evaluated against iter-N's map only —
    // never a union of all prior maps.
    const { store, outputsSpy } = makeIteratingStore([
      new Map([['picker', JSON.stringify({ empty: 'false' })]]),
      new Map([['picker', JSON.stringify({ empty: 'true' })]]),
    ]);
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ loop_until: "$picker.output.empty == 'true'" }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    // Each iteration loads outputs for its own run id only.
    const calls = outputsSpy.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['run-iter-1']);
    expect(calls[1]).toEqual(['run-iter-2']);
  });

  it('reuses condition-evaluator semantics (string equality, dot field access)', async () => {
    // Use a slightly different shape to prove it's not a hardcoded check.
    const { store, createSpy } = makeIteratingStore([
      new Map([['decide', JSON.stringify({ status: 'continue' })]]),
      new Map([['decide', JSON.stringify({ status: 'done' })]]),
    ]);
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({
        nodes: [{ id: 'decide', prompt: 'decide' }],
        loop_until: "$decide.output.status == 'done'",
      }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(2);
  });

  it('fails fast when loop_until expression is unparseable', async () => {
    const { store, createSpy } = makeIteratingStore([
      new Map([['picker', JSON.stringify({ empty: 'false' })]]),
    ]);
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ loop_until: 'not a valid expression at all' }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('unparseable');
    }
    // Only one iteration ran before bailing out.
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('short-circuits the loop on iteration failure', async () => {
    // Make iteration 1 fail (final status != completed).
    const store = makeStore({
      getCompletedDagNodeOutputs: mock(async () => new Map()),
      getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'failed' as const })),
    });
    const createSpy = store.createWorkflowRun as ReturnType<typeof mock>;
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ loop_until: "$picker.output.empty == 'true'", max_iterations: 5 }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(false);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('short-circuits the loop on iteration pause', async () => {
    const store = makeStore({
      getWorkflowRun: mock(async () => ({ ...makeRun(), status: 'paused' as const })),
    });
    const createSpy = store.createWorkflowRun as ReturnType<typeof mock>;
    const deps = makeDeps(store);

    const result = await executeWorkflow(
      deps,
      makePlatform(),
      'conv-1',
      '/tmp',
      makeWorkflow({ loop_until: "$picker.output.empty == 'true'", max_iterations: 5 }),
      'msg',
      'db-conv-1'
    );

    expect(result.success).toBe(true);
    if (result.success && 'paused' in result) {
      expect(result.paused).toBe(true);
    }
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
