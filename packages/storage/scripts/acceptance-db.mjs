#!/usr/bin/env node
/*
 * Read-only acceptance report for the app database (ADK migration, phase 7.1).
 *
 *   pnpm acceptance:db "C:\Users\<you>\AppData\Roaming\Autonomous Research Assistant\data\research.db"
 *
 * Opens the database READ-ONLY (it never writes, migrates or repairs) and
 * prints, as JSON:
 * - PRAGMA quick_check and the applied migrations;
 * - per research task: status, pinned engine (legacy / adk / unknown), model
 *   name, step counts by status, sources, reports, accepted model-usage rows,
 *   and any completed model step with more than one accepted usage row;
 * - unfinished tasks pinned to ADK (finish or cancel them before downgrading
 *   to a version older than Phase 7, which would resume them on legacy);
 * - row counts of the ADK session tables (Chat and Research must not use them).
 * It prints no goals, prompts, page text or report content.
 */
import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';

const path = process.argv[2];
if (!path || !existsSync(path)) {
  console.error('Usage: pnpm acceptance:db <path to research.db>');
  process.exit(2);
}

const db = new Database(path, { readonly: true, fileMustExist: true });
const all = (sql, ...params) => db.prepare(sql).all(...params);
const one = (sql, ...params) => db.prepare(sql).get(...params);
const tableExists = (name) =>
  Boolean(one("select 1 as x from sqlite_master where type = 'table' and name = ?", name));

const MODEL_STEPS = ['plan', 'evidence', 'analyze', 'report', 'review'];

function engineOf(input) {
  const config = input?.model?.config;
  if (!input?.model) return 'legacy (no model capture)';
  const pin = config && typeof config === 'object' ? config.researchEngine : undefined;
  if (pin === undefined) return 'legacy';
  return pin === 'adk' ? 'adk' : `unknown (${String(pin).slice(0, 40)})`;
}

const tasks = all('select id, status, input, created_at from tasks order by created_at').flatMap(
  (t) => {
    let input;
    try {
      input = JSON.parse(t.input);
    } catch {
      return [];
    }
    if (input?.kind !== 'research') return [];
    const steps = all('select id, kind, status, attempts from task_steps where task_id = ?', t.id);
    const byStatus = {};
    for (const s of steps) byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const usageByStep = new Map(
      all(
        'select step_id, count(*) as n from model_usage where task_id = ? group by step_id',
        t.id,
      ).map((r) => [r.step_id, r.n]),
    );
    const duplicateUsage = steps
      .filter((s) => MODEL_STEPS.includes(s.kind) && s.status === 'completed')
      .filter((s) => (usageByStep.get(s.id) ?? 0) > 1)
      .map((s) => s.kind);
    return [
      {
        id: t.id,
        createdAt: t.created_at,
        status: t.status,
        engine: engineOf(input),
        model: input?.model?.name ?? null,
        steps: byStatus,
        modelStepAttempts: steps
          .filter((s) => MODEL_STEPS.includes(s.kind))
          .reduce((n, s) => n + s.attempts, 0),
        sources: one('select count(*) as n from sources where task_id = ?', t.id).n,
        reports: one('select count(*) as n from reports where task_id = ?', t.id).n,
        acceptedUsageRows: one('select count(*) as n from model_usage where task_id = ?', t.id).n,
        completedStepsWithDuplicateUsage: duplicateUsage,
      },
    ];
  },
);

const unfinished = new Set(['pending', 'running', 'interrupted', 'awaiting-approval']);
const report = {
  database: path,
  quickCheck: all('pragma quick_check').map((r) => r.quick_check),
  migrations: tableExists('__migrations')
    ? all('select tag from __migrations order by tag').map((r) => r.tag)
    : [],
  researchTasks: tasks,
  summary: {
    researchTasks: tasks.length,
    byEngine: tasks.reduce((acc, t) => ({ ...acc, [t.engine]: (acc[t.engine] ?? 0) + 1 }), {}),
    unfinishedAdkTasks: tasks
      .filter((t) => t.engine === 'adk' && unfinished.has(t.status))
      .map((t) => t.id),
    tasksWithDuplicateUsage: tasks
      .filter((t) => t.completedStepsWithDuplicateUsage.length > 0)
      .map((t) => t.id),
  },
  adkSessionTables: Object.fromEntries(
    ['adk_sessions', 'adk_events', 'adk_app_state', 'adk_user_state'].map((name) => [
      name,
      tableExists(name) ? one(`select count(*) as n from ${name}`).n : 'absent',
    ]),
  ),
};
db.close();
console.log(JSON.stringify(report, null, 2));
