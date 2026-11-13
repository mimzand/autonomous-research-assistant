import { type DraftParagraph } from './grounding.js';
import {
  type Analysis,
  type GoalCheck,
  type GoalCorrection,
  type RequirementStatus,
} from './schemas.js';

/*
 * Goal completeness (Phase 7.5), run inside the existing review step.
 *
 * The analysis lists the goal's explicit requirements with the evidence that
 * covers them. After the claim review, one model call checks whether the kept
 * paragraphs satisfy each requirement. For unmet requirements whose evidence
 * exists, ONE bounded correction call may add one paragraph each, written only
 * from that requirement's evidence; those paragraphs go through the same claim
 * review before they count. No loop, no new sources, no new steps: a crash or
 * retry simply repeats the review step as before.
 *
 * The model's judgement is never taken alone: a "satisfied" without a kept
 * paragraph is not satisfied, and a requirement without valid evidence can only
 * end as "insufficient-evidence" unless the verified report already satisfies it.
 */

/** At most this many requirements are corrected per task (one call, one paragraph each). */
export const MAX_GOAL_CORRECTIONS = 3;
export const CORRECTION_SECTION = 'Requested details';

export type Requirement = Analysis['requirements'][number];

export interface RequirementResult {
  readonly id: string;
  readonly requirement: string;
  readonly status: RequirementStatus;
  readonly note: string;
  /** A paragraph was added by the bounded correction and verified. */
  readonly corrected: boolean;
}

export const requirementId = (index: number) => `R${index + 1}`;

/** Combines the model's check with the evidence coverage, conservatively. */
export function resolveGoalCheck(
  requirements: readonly Requirement[],
  check: GoalCheck | null,
  keptParagraphIds: ReadonlySet<string>,
): RequirementResult[] {
  return requirements.map((r, i) => {
    const id = requirementId(i);
    const verdict = check?.requirements.find((v) => v.id.trim().toUpperCase() === id);
    const backed = (verdict?.paragraphs ?? []).some((p) =>
      keptParagraphIds.has(p.trim().toUpperCase()),
    );
    let status: RequirementStatus;
    let note = verdict?.note.trim().slice(0, 300) ?? '';
    if (verdict?.status === 'satisfied' && backed) status = 'satisfied';
    else if (r.coverage === 'none' || !r.evidence.length) {
      status = 'insufficient-evidence';
      note = 'The sources do not cover this.';
    } else if (verdict?.status === 'partial' && backed) status = 'partial';
    else {
      status = 'not-satisfied';
      if (!verdict) note = 'The goal check returned no verdict.';
      else if (verdict.status !== 'not-satisfied' && !backed)
        note = 'No verified paragraph addresses it.';
    }
    return { id, requirement: r.requirement, status, note, corrected: false };
  });
}

/** Requirements worth one correction attempt: unmet, but with evidence. */
export function correctionCandidates(
  requirements: readonly Requirement[],
  results: readonly RequirementResult[],
): { id: string; requirement: string; evidence: readonly string[] }[] {
  return results
    .flatMap((res, i) => {
      const r = requirements[i];
      if (!r || !r.evidence.length || r.coverage === 'none') return [];
      if (res.status !== 'partial' && res.status !== 'not-satisfied') return [];
      return [{ id: res.id, requirement: r.requirement, evidence: r.evidence }];
    })
    .slice(0, MAX_GOAL_CORRECTIONS);
}

/**
 * Turns the correction answer into draft paragraphs: one per candidate, citing
 * only that requirement's evidence ids. Anything else is dropped.
 */
export function correctionParagraphs(
  candidates: readonly { id: string; evidence: readonly string[] }[],
  correction: GoalCorrection,
  firstParagraphNumber: number,
  sanitize: (text: string) => string,
): (DraftParagraph & { requirement: string })[] {
  const out: (DraftParagraph & { requirement: string })[] = [];
  for (const c of candidates) {
    const p = correction.paragraphs.find((x) => x.requirement.trim().toUpperCase() === c.id);
    if (!p) continue;
    const allowed = new Set(c.evidence);
    const evidence = [
      ...new Set(p.evidence.map((e) => e.trim().toUpperCase()).filter((e) => allowed.has(e))),
    ];
    const text = sanitize(p.text);
    if (!evidence.length || text.length < 10) continue;
    out.push({
      id: `P${firstParagraphNumber + out.length}`,
      section: CORRECTION_SECTION,
      text,
      evidence,
      certainty: 'medium',
      requirement: c.id,
    });
  }
  return out;
}

/** Applies the claim review of the correction paragraphs to the requirement results. */
export function applyCorrections(
  results: readonly RequirementResult[],
  added: readonly { requirement: string; verdict: string }[],
): RequirementResult[] {
  return results.map((r) => {
    const a = added.find((x) => x.requirement === r.id);
    if (!a) return r;
    if (a.verdict === 'supported') {
      return { ...r, status: 'satisfied', corrected: true, note: 'Completed from the sources.' };
    }
    if (a.verdict === 'partially-supported') {
      return {
        ...r,
        status: 'partial',
        corrected: true,
        note: 'Completed only partly: the sources support part of it.',
      };
    }
    // Rejected by the review: the gap stays explicit.
    return r;
  });
}
