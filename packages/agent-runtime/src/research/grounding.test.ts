import { describe, expect, it } from 'vitest';
import {
  cleanAnalysis,
  escapeInline,
  groundClaims,
  indexEvidence,
  knownIds,
  normalizeForMatch,
  renderReport,
  sanitizeProse,
} from './grounding.js';

describe('quote grounding', () => {
  const source = 'The “seasonal COP” is 3–4 in mild\n climates…  Costs: 8000 EUR.';

  it('normalises case, whitespace, quote marks and dashes', () => {
    expect(normalizeForMatch(source)).toBe(
      'the "seasonal cop" is 3-4 in mild climates... costs: 8000 eur.',
    );
  });

  it('keeps only claims whose quote is in the source, up to the limit', () => {
    const { kept, dropped } = groundClaims(
      {
        relevant: true,
        summary: '',
        claims: [
          {
            claim: 'COP 3-4',
            quote: '"seasonal COP" is 3-4 in MILD climates',
            questions: ['q1', 'q7'],
            confidence: 'high',
          },
          {
            claim: 'made up',
            quote: 'COP is 12 everywhere',
            questions: ['q1'],
            confidence: 'high',
          },
          { claim: 'too short', quote: 'COP', questions: [], confidence: 'low' },
          { claim: 'cost', quote: 'Costs: 8000 EUR.', questions: ['q2'], confidence: 'medium' },
        ],
      },
      source,
      ['q1', 'q2'],
      1,
    );
    expect(kept).toEqual([
      {
        claim: 'COP 3-4',
        quote: '"seasonal COP" is 3-4 in MILD climates',
        questions: ['q1'],
        confidence: 'high',
      },
    ]);
    expect(dropped).toBe(3); // made up, too short, over the limit
  });
});

describe('evidence ids', () => {
  it('assigns ids in order with a cap and filters unknown ids', () => {
    const claim = { claim: 'c', quote: 'q', questions: [], confidence: 'high' as const };
    const items = indexEvidence(
      [
        { sourceId: 's1', claims: [claim, claim] },
        { sourceId: 's2', claims: [claim] },
      ],
      2,
    );
    expect(items.map((e) => [e.id, e.sourceId])).toEqual([
      ['E1', 's1'],
      ['E2', 's1'],
    ]);
    expect(knownIds(['e2', '[E1]', 'E9', 'E2'], new Set(['E1', 'E2']))).toEqual(['E2', 'E1']);
  });

  it('drops unsupported findings and one-sided contradictions', () => {
    const { analysis, droppedFindings } = cleanAnalysis(
      {
        findings: [
          { question: 'q1', statement: 'ok', evidence: ['E1'], agreement: 'single-source' },
          { question: 'q1', statement: 'invented', evidence: ['E9'], agreement: 'consistent' },
        ],
        contradictions: [{ description: 'needs two', evidence: ['E1', 'E9'] }],
        gaps: [{ question: 'q5', description: 'unknown question id' }],
      },
      new Set(['E1', 'E2']),
      new Set(['q1']),
    );
    expect(droppedFindings).toBe(1);
    expect(analysis.findings).toHaveLength(1);
    expect(analysis.contradictions).toEqual([]);
    expect(analysis.gaps).toEqual([{ question: null, description: 'unknown question id' }]);
  });
});

describe('safe Markdown', () => {
  it('strips links, html, citation markers, URLs and block syntax from model prose', () => {
    expect(
      sanitizeProse(
        '## Big claim [see](https://x.example) <b>bold</b> [1][E2] [S1, S2] https://y.example/z *ok*',
      ),
    ).toBe('Big claim see bold \\*ok\\*');
  });

  it('escapes titles and goals', () => {
    expect(escapeInline('[click](javascript:alert(1)) # x')).toBe(
      '\\[click\\]\\(javascript:alert\\(1\\)\\) \\# x',
    );
  });

  it('renders only citations that resolve to sources and reports what was removed', () => {
    const report = renderReport({
      goal: 'Goal',
      title: 'Title',
      paragraphs: [
        { id: 'P1', section: null, text: 'Supported.', evidence: ['E1'], certainty: 'high' },
        {
          id: 'P2',
          section: 'S',
          text: 'Evidence of a deleted source.',
          evidence: ['E2'],
          certainty: 'high',
        },
      ],
      verdicts: new Map([['P1', { verdict: 'supported', note: '' }]]),
      analysis: { findings: [], contradictions: [], gaps: [] },
      evidence: [
        { id: 'E1', sourceId: 's1', claim: 'c', quote: 'q', questions: ['q1'], confidence: 'high' },
        {
          id: 'E2',
          sourceId: 'gone',
          claim: 'c',
          quote: 'q',
          questions: ['q1'],
          confidence: 'high',
        },
      ],
      sources: [
        { sourceId: 's1', url: 'https://a.example/(x)', title: 'A [title]', retrievedAt: null },
      ],
      questions: [
        { id: 'q1', question: 'Q1?' },
        { id: 'q2', question: 'Q2?' },
      ],
      generatedAt: '2026-11-05T10:00:00.000Z',
      model: 'qwen3:8b',
    });
    expect(report.citedSourceIds).toEqual(['s1']);
    expect(report.markdown).toContain('Supported. [1]');
    expect(report.markdown).not.toContain('## S\n');
    expect(report.markdown).toContain(
      'Removed (not supported by the sources): “Evidence of a deleted source.”',
    );
    expect(report.markdown).toContain('No source evidence was found for: *Q2?*');
    expect(report.markdown).toContain('1. [A \\[title\\]](https://a.example/%28x%29)');
    expect(report.stats).toMatchObject({ supported: 1, removedUnsupported: 1, citedSources: 1 });
  });
});
