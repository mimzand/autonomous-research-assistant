import { z } from 'zod';

/*
 * Everything the model returns is validated with these schemas. They are
 * also sent to Ollama as JSON Schema to constrain the output. Kept small and
 * flat on purpose: an 8B local model follows simple shapes much more reliably.
 */

export const RESEARCH_TASK_KIND = 'research';

// --- Limits ----------------------------------------------------------------------

export const ResearchLimitsSchema = z.strictObject({
  /** Sub-questions in the plan. */
  maxQuestions: z.int().min(1).max(6).default(3),
  /** Search queries run per question. */
  maxQueriesPerQuestion: z.int().min(1).max(3).default(2),
  /** Results requested per search query. */
  resultsPerQuery: z.int().min(1).max(10).default(5),
  /** Sources fetched and read in total. */
  maxSources: z.int().min(1).max(12).default(6),
  /** Characters of one source's text sent to the model. */
  maxSourceChars: z.int().min(1000).max(20_000).default(5000),
  /** Evidence items kept per source. */
  maxClaimsPerSource: z.int().min(1).max(8).default(4),
  /** Hard cap on steps for one task (plan + searches + select + 2 per source + 4). */
  maxSteps: z.int().min(10).max(60).default(40),
  /** Deadline for one model call. */
  modelTimeoutMs: z.int().min(1000).max(900_000).default(300_000),
  /** Extra attempts after a failed model call (invalid output, timeout, server error). */
  modelRetries: z.int().min(0).max(3).default(1),
  /** Extra attempts after a transient tool failure (timeout, network). */
  toolRetries: z.int().min(0).max(3).default(1),
  retryBackoffMs: z.int().min(0).max(60_000).default(1000),
});
export type ResearchLimits = z.output<typeof ResearchLimitsSchema>;

/** What the user asks for. Stored as the task input. */
export const ResearchRequestSchema = z.strictObject({
  goal: z
    .string()
    .trim()
    .min(10, 'Describe the research goal in at least 10 characters.')
    .max(2000),
  limits: ResearchLimitsSchema.partial().optional(),
});
export type ResearchRequest = z.input<typeof ResearchRequestSchema>;

export const ResearchTaskInputSchema = z.object({
  kind: z.literal(RESEARCH_TASK_KIND),
  goal: z.string(),
  limits: ResearchLimitsSchema,
});
export type ResearchTaskInput = z.infer<typeof ResearchTaskInputSchema>;

// --- Model outputs -----------------------------------------------------------------

export const ResearchPlanSchema = z.object({
  title: z.string().trim().min(3).max(150).describe('Short title for the research task.'),
  objective: z.string().trim().min(10).max(800).describe('What the research must find out.'),
  questions: z
    .array(
      z.object({
        question: z.string().trim().min(5).max(300),
        searchQueries: z.array(z.string().trim().min(2).max(150)).min(1).max(4),
      }),
    )
    .min(1)
    .max(8),
});
export type ResearchPlan = z.infer<typeof ResearchPlanSchema>;

export const Confidence = z.enum(['high', 'medium', 'low']);

export const SourceEvidenceSchema = z.object({
  relevant: z.boolean().describe('Does the source help answer any question?'),
  summary: z.string().max(1000).describe('Two or three sentences on what the source says.'),
  claims: z
    .array(
      z.object({
        claim: z.string().trim().min(5).max(400).describe('One factual claim made by the source.'),
        quote: z
          .string()
          .trim()
          .min(8)
          .max(400)
          .describe('Exact words copied from the source that support the claim.'),
        questions: z.array(z.string()).max(6).describe('Ids of the questions it helps answer.'),
        confidence: Confidence,
      }),
    )
    .max(12),
});
export type SourceEvidence = z.infer<typeof SourceEvidenceSchema>;

export const AnalysisSchema = z.object({
  findings: z
    .array(
      z.object({
        question: z.string().describe('Question id, e.g. q1.'),
        statement: z.string().trim().min(5).max(600),
        evidence: z.array(z.string()).min(1).max(8).describe('Evidence ids, e.g. E1.'),
        agreement: z.enum(['consistent', 'mixed', 'single-source']),
      }),
    )
    .max(24),
  contradictions: z
    .array(
      z.object({
        description: z.string().trim().min(5).max(600),
        evidence: z.array(z.string()).min(2).max(8),
      }),
    )
    .max(10),
  gaps: z
    .array(
      z.object({
        question: z.string().nullable(),
        description: z.string().trim().min(5).max(400),
      }),
    )
    .max(10),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

const ParagraphSchema = z.object({
  text: z.string().trim().min(10).max(1500),
  evidence: z.array(z.string()).max(8).describe('Evidence ids that support this paragraph.'),
  certainty: Confidence,
});

export const ReportDraftSchema = z.object({
  title: z.string().trim().min(3).max(150),
  summary: z.array(ParagraphSchema).min(1).max(4),
  sections: z
    .array(
      z.object({
        heading: z.string().trim().min(2).max(120),
        paragraphs: z.array(ParagraphSchema).min(1).max(6),
      }),
    )
    .max(6),
});
export type ReportDraft = z.infer<typeof ReportDraftSchema>;

export const ReviewSchema = z.object({
  verdicts: z
    .array(
      z.object({
        id: z.string().describe('Paragraph id, e.g. P1.'),
        verdict: z.enum(['supported', 'partially-supported', 'unsupported']),
        note: z.string().max(300),
      }),
    )
    .max(60),
});
export type Review = z.infer<typeof ReviewSchema>;
