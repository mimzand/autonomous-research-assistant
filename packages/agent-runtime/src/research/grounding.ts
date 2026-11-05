import { type Analysis, type ReportDraft, type SourceEvidence } from './schemas.js';

/*
 * Grounding rules (deterministic, no model involved):
 * - A claim is kept only if its quote appears verbatim (modulo case,
 *   whitespace, quote style) in the stored source text.
 * - Evidence ids (E1, E2, ...) are assigned here; any id the model invents
 *   is dropped. Citations in the report are derived from evidence ids, so a
 *   report can only cite sources that were actually fetched and stored.
 * - The Markdown is rendered here, never written freely by the model.
 */

export type Confidence = 'high' | 'medium' | 'low';

/** Normalised form used to look for quotes inside source text. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface GroundedClaim {
  readonly claim: string;
  readonly quote: string;
  readonly questions: readonly string[];
  readonly confidence: Confidence;
}

/** Keeps claims whose quote is really in the source; drops unknown question ids. */
export function groundClaims(
  evidence: SourceEvidence,
  sourceText: string,
  questionIds: readonly string[],
  max: number,
): { kept: GroundedClaim[]; dropped: number } {
  const haystack = normalizeForMatch(sourceText);
  const known = new Set(questionIds);
  const kept: GroundedClaim[] = [];
  let dropped = 0;
  for (const c of evidence.claims) {
    // Models often wrap the quote in quotation marks; remove them only when they wrap it.
    const wrapped = /^["'\u201c\u2018]([\s\S]*)["'\u201d\u2019]$/.exec(c.quote.trim());
    const quote = (wrapped?.[1] ?? c.quote).trim();
    const needle = normalizeForMatch(quote);
    if (needle.length < 8 || !haystack.includes(needle) || kept.length >= max) {
      dropped++;
      continue;
    }
    kept.push({
      claim: oneLine(c.claim),
      quote: oneLine(quote),
      questions: c.questions.filter((q) => known.has(q)),
      confidence: c.confidence,
    });
  }
  return { kept, dropped };
}

export interface SourceRef {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string | null;
  readonly retrievedAt: string | null;
}

export interface EvidenceItem extends GroundedClaim {
  /** E1, E2, ... */
  readonly id: string;
  readonly sourceId: string;
}

/** Assigns stable evidence ids in source order. */
export function indexEvidence(
  perSource: readonly { sourceId: string; claims: readonly GroundedClaim[] }[],
  max: number,
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const s of perSource) {
    for (const c of s.claims) {
      if (items.length >= max) return items;
      items.push({ ...c, id: `E${items.length + 1}`, sourceId: s.sourceId });
    }
  }
  return items;
}

/** Keeps only known ids, in order, without duplicates. */
export function knownIds(ids: readonly string[], known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw
      .trim()
      .toUpperCase()
      .replace(/^\[|\]$/g, '');
    if (known.has(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Removes invented evidence ids; drops findings/contradictions left without support. */
export function cleanAnalysis(
  analysis: Analysis,
  evidenceIds: ReadonlySet<string>,
  questionIds: ReadonlySet<string>,
): { analysis: Analysis; droppedFindings: number } {
  let droppedFindings = 0;
  const findings = analysis.findings.flatMap((f) => {
    const evidence = knownIds(f.evidence, evidenceIds);
    if (!evidence.length) {
      droppedFindings++;
      return [];
    }
    return [{ ...f, statement: oneLine(f.statement), evidence }];
  });
  const contradictions = analysis.contradictions.flatMap((c) => {
    const evidence = knownIds(c.evidence, evidenceIds);
    return evidence.length >= 2 ? [{ description: oneLine(c.description), evidence }] : [];
  });
  const gaps = analysis.gaps.map((g) => ({
    question: g.question && questionIds.has(g.question) ? g.question : null,
    description: oneLine(g.description),
  }));
  return { analysis: { findings, contradictions, gaps }, droppedFindings };
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Text from the model is placed into Markdown as plain prose: links, raw
 * HTML, inline citation markers and block syntax are removed so the model
 * cannot add its own (possibly invented) references or formatting.
 */
export function sanitizeProse(text: string): string {
  return oneLine(
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // markdown links/images → text
      .replace(/<[^>]{1,200}>/g, '') // html tags / autolinks
      .replace(/\[(?:E|S|P|Q)?\d+(?:\s*[,;-]\s*(?:E|S|P|Q)?\d+)*\]/gi, '') // [1] [E3] [S1, S2]
      .replace(/\bhttps?:\/\/\S+/gi, '') // bare URLs
      .replace(/^[#>*+\-\s]+/, '') // leading block markers
      .replace(/([*_`|])/g, '\\$1'),
  );
}

/** Percent-encodes characters that would end a Markdown link destination early. */
export function markdownUrl(url: string): string {
  return url.replace(
    /[()<>\s]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** Escapes text for use inside a Markdown link label or list item. */
export function escapeInline(text: string): string {
  return oneLine(text).replace(/([\\`*_{}[\]()#+\-!|<>])/g, '\\$1');
}

export type Verdict = 'supported' | 'partially-supported' | 'unsupported' | 'unverified';

export interface DraftParagraph {
  /** P1, P2, ... */
  readonly id: string;
  readonly section: string | null;
  readonly text: string;
  readonly evidence: readonly string[];
  readonly certainty: Confidence;
}

/** Flattens the draft into numbered paragraphs with only known evidence ids. */
export function draftParagraphs(
  draft: ReportDraft,
  evidenceIds: ReadonlySet<string>,
): DraftParagraph[] {
  const out: DraftParagraph[] = [];
  const add = (section: string | null, p: ReportDraft['summary'][number]) =>
    out.push({
      id: `P${out.length + 1}`,
      section,
      text: sanitizeProse(p.text),
      evidence: knownIds(p.evidence, evidenceIds),
      certainty: p.certainty,
    });
  draft.summary.forEach((p) => add(null, p));
  draft.sections.forEach((s) => s.paragraphs.forEach((p) => add(oneLine(s.heading), p)));
  return out.filter((p) => p.text.length > 0);
}

export interface RenderInput {
  readonly goal: string;
  readonly title: string;
  readonly paragraphs: readonly DraftParagraph[];
  readonly verdicts: ReadonlyMap<string, { verdict: Verdict; note: string }>;
  readonly analysis: Analysis;
  readonly evidence: readonly EvidenceItem[];
  readonly sources: readonly SourceRef[];
  readonly questions: readonly { id: string; question: string }[];
  readonly generatedAt: string;
  readonly model: string;
}

export interface RenderedReport {
  readonly title: string;
  readonly markdown: string;
  /** Sources actually cited, in citation order. */
  readonly citedSourceIds: string[];
  readonly stats: {
    readonly paragraphs: number;
    readonly supported: number;
    readonly partiallySupported: number;
    readonly unverified: number;
    readonly removedUnsupported: number;
    readonly uncertain: number;
    readonly contradictions: number;
    readonly gaps: number;
    readonly citedSources: number;
  };
}

/** Builds the final Markdown report from verified pieces. */
export function renderReport(input: RenderInput): RenderedReport {
  const evidenceById = new Map(input.evidence.map((e) => [e.id, e]));
  const sourceById = new Map(input.sources.map((s) => [s.sourceId, s]));
  const order: string[] = []; // cited source ids in citation order
  const cite = (evidenceIds: readonly string[]): string => {
    const numbers: number[] = [];
    for (const id of evidenceIds) {
      const sourceId = evidenceById.get(id)?.sourceId;
      if (!sourceId || !sourceById.has(sourceId)) continue;
      if (!order.includes(sourceId)) order.push(sourceId);
      const n = order.indexOf(sourceId) + 1;
      if (!numbers.includes(n)) numbers.push(n);
    }
    return numbers
      .sort((a, b) => a - b)
      .map((n) => `[${n}]`)
      .join('');
  };

  let supported = 0;
  let partial = 0;
  let unverified = 0;
  let uncertain = 0;
  const removed: DraftParagraph[] = [];
  const renderParagraph = (p: DraftParagraph): string | null => {
    const verdict =
      input.verdicts.get(p.id)?.verdict ?? (p.evidence.length ? 'unverified' : 'unsupported');
    if (verdict === 'unsupported' || !p.evidence.length) {
      removed.push(p);
      return null;
    }
    const citations = cite(p.evidence);
    if (!citations) {
      removed.push(p);
      return null;
    }
    const notes: string[] = [];
    if (verdict === 'partially-supported') {
      partial++;
      notes.push('*(only partly supported by the cited sources)*');
    } else if (verdict === 'unverified') {
      unverified++;
      notes.push('*(not verified by the review step)*');
    } else {
      supported++;
    }
    const prefix = p.certainty === 'low' ? '**Uncertain:** ' : '';
    if (p.certainty === 'low') uncertain++;
    return `${prefix}${p.text} ${citations}${notes.length ? ` ${notes.join(' ')}` : ''}`;
  };

  const lines: string[] = [];
  const title = sanitizeProse(input.title) || 'Research report';
  lines.push(`# ${title}`, '');
  lines.push(`> **Research goal:** ${escapeInline(input.goal)}`, '>');
  lines.push(
    `> Generated ${input.generatedAt.slice(0, 16).replace('T', ' ')} UTC by the local model \`${input.model.replace(/`/g, '')}\` from ${input.sources.length} source(s). ` +
      'Every statement cites the sources it is based on; statements the review could not support were removed. Verify important facts before relying on them.',
    '',
  );

  const summary = input.paragraphs
    .filter((p) => p.section === null)
    .map(renderParagraph)
    .filter(Boolean);
  lines.push('## Summary', '');
  if (summary.length) summary.forEach((p) => lines.push(p as string, ''));
  else lines.push('*No summary statement could be supported by the sources.*', '');

  const sections = [...new Set(input.paragraphs.flatMap((p) => (p.section ? [p.section] : [])))];
  for (const heading of sections) {
    const body = input.paragraphs
      .filter((p) => p.section === heading)
      .map(renderParagraph)
      .filter(Boolean);
    if (!body.length) continue;
    lines.push(`## ${sanitizeProse(heading)}`, '');
    body.forEach((p) => lines.push(p as string, ''));
  }

  const { contradictions, gaps } = input.analysis;
  lines.push('## Contradictions', '');
  const contradictionLines = contradictions
    .map((c) => {
      const citations = cite(c.evidence);
      return citations ? `- ${sanitizeProse(c.description)} ${citations}` : null;
    })
    .filter(Boolean);
  if (contradictionLines.length) contradictionLines.forEach((l) => lines.push(l as string));
  else lines.push('- No contradictions between the sources were found.');
  lines.push('');

  lines.push('## Gaps and open questions', '');
  const questionText = new Map(input.questions.map((q) => [q.id, q.question]));
  if (gaps.length) {
    for (const g of gaps) {
      const q = g.question ? questionText.get(g.question) : undefined;
      lines.push(
        `- ${sanitizeProse(g.description)}${q ? ` *(question: ${escapeInline(q)})*` : ''}`,
      );
    }
  } else {
    lines.push('- None identified, but the number of sources was limited.');
  }
  const unanswered = input.questions.filter(
    (q) => !input.evidence.some((e) => e.questions.includes(q.id)),
  );
  for (const q of unanswered) {
    lines.push(`- No source evidence was found for: *${escapeInline(q.question)}*`);
  }
  lines.push('');

  lines.push('## Review notes', '');
  lines.push(
    `- ${supported} statement(s) supported, ${partial} partly supported, ${unverified} not verified, ${removed.length} removed as unsupported.`,
  );
  for (const p of removed) {
    lines.push(`- Removed (not supported by the sources): “${escapeInline(p.text)}”`);
  }
  lines.push('');

  lines.push('## Sources', '');
  if (!order.length) lines.push('*No sources were cited.*');
  order.forEach((id, i) => {
    const s = sourceById.get(id);
    if (!s) return;
    const label = escapeInline(s.title || s.url);
    const date = s.retrievedAt ? ` — retrieved ${s.retrievedAt.slice(0, 10)}` : '';
    lines.push(`${i + 1}. [${label}](${markdownUrl(s.url)})${date}`);
  });
  lines.push('');

  return {
    title,
    markdown: lines.join('\n'),
    citedSourceIds: [...order],
    stats: {
      paragraphs: input.paragraphs.length,
      supported,
      partiallySupported: partial,
      unverified,
      removedUnsupported: removed.length,
      uncertain,
      contradictions: contradictionLines.length,
      gaps: gaps.length + unanswered.length,
      citedSources: order.length,
    },
  };
}
