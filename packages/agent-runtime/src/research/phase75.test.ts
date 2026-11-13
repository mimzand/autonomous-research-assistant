/**
 * Phase 7.5: report metadata, single-source semantics and goal completeness.
 * Scripted model and web only (test-fixtures.ts); no Ollama, no network.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { type TaskModelConfig } from './schemas.js';
import {
  correctionCandidates,
  correctionParagraphs,
  MAX_GOAL_CORRECTIONS,
  resolveGoalCheck,
  type Requirement,
} from './goal.js';
import { renderReport, type EvidenceItem } from './grounding.js';
import { ANALYSIS, cleanupDirs, fakeModel, hang, harness, waitFor } from './test-fixtures.js';

afterEach(cleanupDirs);

const reportOf = (h: ReturnType<typeof harness>, id: string) =>
  h.storage.reports.listByTask(id)[0]?.content ?? '';

/** Task isolation as main does it: the endpoint is captured when the task starts. */
function capturing(url: string, model = 'qwen3.5:9b-mlx') {
  return (provider: ReturnType<typeof fakeModel>['provider']) => ({
    capture: (): TaskModelConfig => ({ provider: 'ollama', name: model, url, config: { url } }),
    providerFor: () => provider,
  });
}

describe('report metadata: model location from the captured endpoint', () => {
  it.each([
    ['http://127.0.0.1:11434', 'Local Ollama'],
    ['https://example-tunnel.ngrok-free.dev', 'Remote Ollama'],
    ['http://192.168.1.20:11434', 'Remote Ollama'],
    ['not a url', 'Ollama'],
  ])('%s → "%s"', async (url, label) => {
    const model = fakeModel();
    const h = harness({ model, runtime: { taskModels: capturing(url)(model.provider) } });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    const report = reportOf(h, id);
    expect(report).toContain(`via ${label} from`);
    expect(report).not.toMatch(/local model/i);
  });

  it('a task without captured configuration (older task) gets the neutral label', async () => {
    const h = harness();
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(reportOf(h, id)).toContain('via Ollama from');
  });

  it('uses the captured endpoint even when the server reports another (current) URL', async () => {
    const model = fakeModel();
    // The provider currently points at local Ollama; the task captured the remote endpoint.
    const h = harness({
      model,
      runtime: { taskModels: capturing('https://example-tunnel.ngrok-free.dev')(model.provider) },
    });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(model.state.health.baseUrl).toBe('http://127.0.0.1:11434');
    expect(reportOf(h, id)).toContain('via Remote Ollama');
    // Saved reports are never re-rendered: one version, unchanged.
    expect(h.storage.reports.listByTask(id)).toHaveLength(1);
  });

  it('model names are escaped in the Markdown metadata', () => {
    const report = renderReport({
      goal: 'g',
      title: 't',
      paragraphs: [],
      verdicts: new Map(),
      analysis: { findings: [], contradictions: [], gaps: [] },
      evidence: [],
      sources: [],
      questions: [],
      generatedAt: '2026-11-13T10:00:00.000Z',
      model: 'evil`model\n# heading',
      modelLocation: 'Remote [Ollama](x)',
    });
    expect(report.markdown).toContain('`evilmodel # heading`');
    expect(report.markdown).toContain('via Remote \\[Ollama\\]\\(x\\)');
  });
});

describe('contradictions: based on usable, evidence-bearing sources', () => {
  const ev = (id: string, sourceId: string): EvidenceItem => ({
    id,
    sourceId,
    claim: 'c',
    quote: 'q',
    questions: ['q1'],
    confidence: 'high',
  });
  const src = (sourceId: string) => ({
    sourceId,
    url: `https://${sourceId}.example/`,
    title: sourceId,
    retrievedAt: null,
  });
  const render = (evidence: EvidenceItem[], sources: string[], contradictions = 0) =>
    renderReport({
      goal: 'g',
      title: 't',
      paragraphs: evidence.length
        ? [{ id: 'P1', section: null, text: 'A statement.', evidence: ['E1'], certainty: 'high' }]
        : [],
      verdicts: new Map([['P1', { verdict: 'supported', note: '' }]]),
      analysis: {
        findings: [],
        contradictions: contradictions
          ? [{ description: 'They disagree.', evidence: ['E1', 'E2'] }]
          : [],
        gaps: [],
      },
      evidence,
      sources: sources.map(src),
      questions: [],
      generatedAt: '2026-11-13T10:00:00.000Z',
      model: 'm',
      modelLocation: 'Local Ollama',
    });

  it('zero usable sources: insufficient evidence, no comparison claimed', () => {
    const r = render([], ['a', 'b']); // selected but without evidence
    expect(r.markdown).toContain('- Not applicable — no usable source evidence.');
    expect(r.markdown).not.toMatch(/No contradictions/);
    expect(r.stats.usableSources).toBe(0);
  });

  it('one usable source (even with more selected): "not applicable", never "no contradictions"', () => {
    const r = render([ev('E1', 'a'), ev('E2', 'a')], ['a', 'b', 'c']);
    expect(r.markdown).toContain(
      '- Not applicable — only one usable source, so sources could not be compared.',
    );
    expect(r.markdown).not.toMatch(/No contradictions/);
    expect(r.markdown).toContain('from 1 usable source(s)');
    expect(r.stats.usableSources).toBe(1);
  });

  it('one usable source with a contradiction inside it: labelled as within the source', () => {
    const r = render([ev('E1', 'a'), ev('E2', 'a')], ['a'], 1);
    expect(r.markdown).toContain('They disagree. [1] *(within the single source)*');
  });

  it('two or more usable sources: the existing contradiction analysis', () => {
    expect(render([ev('E1', 'a'), ev('E2', 'b')], ['a', 'b']).markdown).toContain(
      '- No contradictions were found between the 2 usable sources.',
    );
    expect(render([ev('E1', 'a'), ev('E2', 'b')], ['a', 'b'], 1).markdown).toContain(
      '- They disagree. [1][2]',
    );
  });

  it('end to end: a task whose other sources fail reports one usable source honestly', async () => {
    const model = fakeModel({
      // Only source a yields evidence.
      'extract-evidence': (prompt) =>
        prompt.includes('url="https://a.example/heat"')
          ? {
              relevant: true,
              summary: 's',
              claims: [
                {
                  claim: 'Seasonal COP is 3 to 4 in mild climates.',
                  quote: 'reach a seasonal COP of 3 to 4 in mild climates',
                  questions: ['q1'],
                  confidence: 'high',
                },
              ],
            }
          : { relevant: false, summary: '', claims: [] },
      'compare-findings': () => ({
        findings: [
          { question: 'q1', statement: 'COP 3-4.', evidence: ['E1'], agreement: 'single-source' },
        ],
        contradictions: [],
        gaps: [],
      }),
      'write-report': () => ({
        title: 'Heat pumps',
        summary: [
          { text: 'Seasonal COP is 3 to 4 in mild climates.', evidence: ['E1'], certainty: 'high' },
        ],
        sections: [],
      }),
      'review-report': () => ({ verdicts: [{ id: 'P1', verdict: 'supported', note: 'ok' }] }),
    });
    const h = harness({ model });
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    const report = reportOf(h, id);
    expect(report).toContain('only one usable source');
    expect(report).not.toMatch(/No contradictions/);
    // The report writer was told not to claim agreement.
    const writer = model.prompts.find((p) => p.task === 'write-report')?.prompt ?? '';
    expect(writer).toContain('Only one source is usable');
  });
});

// --- Goal completeness ------------------------------------------------------------------

const REQ = (over: Partial<Requirement> = {}): Requirement => ({
  requirement: 'List two advantages of heat pumps',
  evidence: ['E1'],
  coverage: 'full',
  ...over,
});

describe('goal completeness: decisions (goal.ts)', () => {
  const kept = new Set(['P1', 'P2']);
  it('satisfied only when a kept paragraph backs it', () => {
    expect(
      resolveGoalCheck(
        [REQ()],
        { requirements: [{ id: 'R1', status: 'satisfied', paragraphs: ['P2'], note: '' }] },
        kept,
      )[0]?.status,
    ).toBe('satisfied');
    expect(
      resolveGoalCheck(
        [REQ()],
        { requirements: [{ id: 'R1', status: 'satisfied', paragraphs: ['P9'], note: '' }] },
        kept,
      )[0],
    ).toMatchObject({ status: 'not-satisfied', note: 'No verified paragraph addresses it.' });
  });

  it('partial, not satisfied, and insufficient evidence', () => {
    const check = {
      requirements: [
        { id: 'R1', status: 'partial' as const, paragraphs: ['P1'], note: 'Only one listed.' },
        { id: 'R2', status: 'not-satisfied' as const, paragraphs: [], note: 'Missing.' },
        { id: 'R3', status: 'not-satisfied' as const, paragraphs: [], note: '' },
      ],
    };
    expect(
      resolveGoalCheck(
        [REQ(), REQ({ requirement: 'Give a cost' }), REQ({ evidence: [], coverage: 'none' })],
        check,
        kept,
      ).map((r) => r.status),
    ).toEqual(['partial', 'not-satisfied', 'insufficient-evidence']);
  });

  it('no verdict from the model is not a success', () => {
    expect(resolveGoalCheck([REQ()], null, kept)[0]?.status).toBe('not-satisfied');
  });

  it('corrections: only unmet requirements with evidence, at most MAX_GOAL_CORRECTIONS', () => {
    const reqs = Array.from({ length: 5 }, (_, i) => REQ({ requirement: `Requirement ${i}` }));
    const results = resolveGoalCheck(reqs, null, kept);
    expect(correctionCandidates(reqs, results)).toHaveLength(MAX_GOAL_CORRECTIONS);
    const none = resolveGoalCheck([REQ({ evidence: [], coverage: 'none' })], null, kept);
    expect(correctionCandidates([REQ({ evidence: [], coverage: 'none' })], none)).toEqual([]);
  });

  it('correction paragraphs may cite only their requirement’s evidence', () => {
    const out = correctionParagraphs(
      [{ id: 'R1', evidence: ['E1', 'E2'] }],
      {
        paragraphs: [
          { requirement: 'R1', text: 'Two advantages: A and B.', evidence: ['e1', 'E9'] },
          { requirement: 'R7', text: 'Not a candidate at all.', evidence: ['E1'] },
        ],
      },
      5,
      (t) => t,
    );
    expect(out).toEqual([
      expect.objectContaining({ id: 'P5', evidence: ['E1'], section: 'Requested details' }),
    ]);
    expect(
      correctionParagraphs(
        [{ id: 'R1', evidence: ['E1'] }],
        { paragraphs: [{ requirement: 'R1', text: 'Unsupported text.', evidence: ['E9'] }] },
        5,
        (t) => t,
      ),
    ).toEqual([]);
  });
});

/** The default fixture flow plus explicit requirements in the analysis. */
function goalModel(requirements: unknown[], handlers: Parameters<typeof fakeModel>[0] = {}) {
  return fakeModel({
    'compare-findings': () => ({ ...ANALYSIS, requirements }),
    ...handlers,
  });
}
const usagePurposes = (h: ReturnType<typeof harness>, id: string) =>
  h.storage.modelUsage.listByTask(id).map((u) => u.purpose);

describe('goal completeness: end to end inside the review step', () => {
  const GOAL = 'Explain heat pump efficiency and list two advantages, using at most two sources.';

  it('a satisfied requirement: one check, no correction, shown in Goal coverage', async () => {
    const model = goalModel([REQ({ evidence: ['E1', 'E4'] })], {
      'check-goal': () => ({
        requirements: [{ id: 'R1', status: 'satisfied', paragraphs: ['P1', 'P2'], note: '' }],
      }),
    });
    const h = harness({ model });
    const id = await h.start(GOAL);
    await h.runtime.tasks.whenIdle();
    expect(model.calls('check-goal')).toBe(1);
    expect(model.calls('complete-report')).toBe(0);
    const report = reportOf(h, id);
    expect(report).toContain('## Goal coverage');
    expect(report).toContain('- **Satisfied:** List two advantages of heat pumps');
    // The analysis was asked for requirements; the writer was told to address them.
    expect(model.prompts.find((p) => p.task === 'compare-findings')?.prompt).toMatch(
      /List requirements/,
    );
    expect(model.prompts.find((p) => p.task === 'write-report')?.prompt).toMatch(
      /R1 \(full coverage; E1, E4\): List two advantages/,
    );
    // Usage stays separable: one plain review row, plus the goal check.
    expect(usagePurposes(h, id).filter((p) => p === 'research:review')).toHaveLength(1);
    expect(usagePurposes(h, id)).toContain('research:review:goal-check');
  });

  it('missing requirement with evidence: one bounded correction, reviewed, cited, then satisfied', async () => {
    const model = goalModel([REQ({ evidence: ['E1', 'E4'] })], {
      'check-goal': () => ({
        requirements: [{ id: 'R1', status: 'not-satisfied', paragraphs: [], note: 'Not listed.' }],
      }),
      'complete-report': () => ({
        paragraphs: [
          {
            requirement: 'R1',
            text: 'Two advantages: high efficiency in mild climates, and usable heat in cold climates.',
            evidence: ['E1', 'E4', 'E99'],
          },
        ],
      }),
      'review-report': (prompt) =>
        prompt.includes('Two advantages')
          ? { verdicts: [{ id: 'P5', verdict: 'supported', note: 'ok' }] }
          : {
              verdicts: [
                { id: 'P1', verdict: 'supported', note: 'ok' },
                { id: 'P2', verdict: 'supported', note: 'ok' },
                { id: 'P4', verdict: 'partially-supported', note: 'x' },
              ],
            },
    });
    const h = harness({ model });
    const id = await h.start(GOAL);
    await h.runtime.tasks.whenIdle();
    expect(model.calls('complete-report')).toBe(1);
    const report = reportOf(h, id);
    expect(report).toContain('## Requested details');
    // Citations preserved (E1 → source 1, E4 → its source); the invented id is dropped.
    expect(report).toMatch(/Two advantages: .*cold climates\. \[1\]\[\d\]/);
    expect(report).toContain(
      '- **Satisfied:** List two advantages of heat pumps — Completed from the sources.',
    );
    // The correction only saw the requirement's own evidence.
    const prompt = model.prompts.find((p) => p.task === 'complete-report')?.prompt ?? '';
    expect(prompt).toContain('- E1 ');
    expect(prompt).not.toContain('- E2 ');
    expect(h.storage.tasks.require(id).status).toBe('completed');
  });

  it('an unsupported correction is rejected: the gap stays explicit and the text is listed as removed', async () => {
    const model = goalModel([REQ()], {
      'check-goal': () => ({
        requirements: [{ id: 'R1', status: 'partial', paragraphs: ['P1'], note: 'Only one.' }],
      }),
      'complete-report': () => ({
        paragraphs: [
          { requirement: 'R1', text: 'Heat pumps also cure all diseases.', evidence: ['E1'] },
        ],
      }),
      'review-report': (prompt) =>
        prompt.includes('cure all diseases')
          ? { verdicts: [{ id: 'P5', verdict: 'unsupported', note: 'Not in the quote.' }] }
          : {
              verdicts: [
                { id: 'P1', verdict: 'supported', note: 'ok' },
                { id: 'P2', verdict: 'supported', note: 'ok' },
              ],
            },
    });
    const h = harness({ model });
    const id = await h.start(GOAL);
    await h.runtime.tasks.whenIdle();
    const report = reportOf(h, id);
    expect(report).toContain(
      '- **Partly satisfied:** List two advantages of heat pumps — Only one.',
    );
    expect(report).not.toMatch(/cure all diseases\. \[/);
    expect(report).toContain(
      'Removed (not supported by the sources): “Heat pumps also cure all diseases.”',
    );
  });

  it('missing requirement without evidence: no correction call, reported as insufficient evidence', async () => {
    const model = goalModel(
      [REQ({ requirement: 'Give the noise level', evidence: ['E77'], coverage: 'full' })],
      {
        'check-goal': () => ({
          requirements: [{ id: 'R1', status: 'not-satisfied', paragraphs: [], note: '' }],
        }),
      },
    );
    const h = harness({ model });
    const id = await h.start(GOAL);
    await h.runtime.tasks.whenIdle();
    expect(model.calls('complete-report')).toBe(0);
    expect(reportOf(h, id)).toContain(
      '- **Insufficient evidence:** Give the noise level — The sources do not cover this.',
    );
  });

  it('bounded: many unmet requirements still mean one check and one correction call', async () => {
    const reqs = Array.from({ length: 5 }, (_, i) =>
      REQ({ requirement: `Requirement number ${i + 1}` }),
    );
    const model = goalModel(reqs, {
      'check-goal': () => ({ requirements: [] }),
      'complete-report': () => ({ paragraphs: [] }),
    });
    const h = harness({ model });
    const id = await h.start(GOAL);
    await h.runtime.tasks.whenIdle();
    expect(model.calls('check-goal')).toBe(1);
    expect(model.calls('complete-report')).toBe(1);
    const prompt = model.prompts.find((p) => p.task === 'complete-report')?.prompt ?? '';
    expect(prompt).toContain('R3: Requirement number 3');
    expect(prompt).not.toContain('R4: Requirement number 4');
    expect(h.storage.tasks.require(id).status).toBe('completed');
  });

  it('older analyses (no requirements) behave exactly as before: no extra calls, no section', async () => {
    const h = harness();
    const id = await h.start();
    await h.runtime.tasks.whenIdle();
    expect(h.model.calls('check-goal')).toBe(0);
    expect(reportOf(h, id)).not.toContain('## Goal coverage');
  });

  it('cancel during the goal check: cancelled, no report; nothing half-saved', async () => {
    const model = goalModel([REQ()], { 'check-goal': hang });
    const h = harness({ model });
    const id = await h.start(GOAL);
    await waitFor(() => model.calls('check-goal') > 0);
    expect(h.runtime.tasks.cancel(id)).toMatchObject({ ok: true });
    await h.runtime.tasks.whenIdle();
    expect(h.storage.tasks.require(id).status).toBe('cancelled');
    expect(h.storage.reports.listByTask(id)).toEqual([]);
    const review = h.storage.steps.listByTask(id).find((s) => s.kind === 'review');
    expect(review?.status).not.toBe('completed');
  });

  it('a failing goal check fails the review step; Retry repeats it once and completes', async () => {
    let failing = true;
    const model = goalModel([REQ()], {
      'check-goal': () =>
        failing
          ? 'not json'
          : { requirements: [{ id: 'R1', status: 'satisfied', paragraphs: ['P1'], note: '' }] },
    });
    const h = harness({ model });
    const id = await h.start(GOAL, { modelRetries: 0 });
    await h.runtime.tasks.whenIdle();
    expect(h.storage.tasks.require(id).status).toBe('failed');
    expect(h.storage.steps.listByTask(id).find((s) => s.kind === 'review')?.status).toBe('failed');
    failing = false;
    expect(h.runtime.tasks.retry(id)).toMatchObject({ ok: true });
    await h.runtime.tasks.whenIdle();
    expect(h.storage.tasks.require(id).status).toBe('completed');
    expect(h.storage.reports.listByTask(id)).toHaveLength(1);
    expect(reportOf(h, id)).toContain('- **Satisfied:**');
    // Earlier steps were not repeated.
    expect(model.calls('write-report')).toBe(1);
  });
});
