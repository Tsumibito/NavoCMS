import { z } from 'zod';
export const PILOT_TASKS = ['text', 'photo', 'page', 'metadata', 'relation', 'design', 'conflict', 'comment', 'resume', 'rollback'] as const;
const task = z.object({ task: z.enum(PILOT_TASKS), startedAt: z.iso.datetime(), finishedAt: z.iso.datetime(), outcome: z.enum(['success', 'failed', 'blocked']), authorShellOrSql: z.boolean(), humanInterventions: z.number().int().nonnegative(), toolCalls: z.number().int().positive(), transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/), inputTokens: z.number().int().nonnegative().nullable(), outputTokens: z.number().int().nonnegative().nullable(), costUsd: z.number().nonnegative().nullable() }).strict();
export const pilotEvidenceSchema = z.object({ schema: z.literal('io.navocms.pilot-evaluation.v1'), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), pilotSiteId: z.string().uuid(), clientNames: z.array(z.string().min(1).max(80)).length(2), runs: z.array(z.object({ client: z.string(), runId: z.string().min(1), execution: z.literal('real-model-mcp'), model: z.string().min(1), cleanSession: z.literal(true), tasks: z.array(task).length(10) }).strict()), usageDays: z.array(z.iso.date()), lostEdits: z.number().int().nonnegative(), crossSiteAccess: z.number().int().nonnegative(), unannouncedPublications: z.number().int().nonnegative(), blockingIssues: z.number().int().nonnegative(), ownerReview: z.enum(['pending', 'accepted', 'rejected']) }).strict();
/** Summarizes declared evidence; an independent reviewer must verify original transcripts. */
export function evaluatePilot(value: unknown, now = Date.now()) {
    const evidence = pilotEvidenceSchema.parse(value);
    const failures: string[] = [];
    if (new Set(evidence.clientNames).size !== 2)
        failures.push('TWO_DISTINCT_CLIENTS_REQUIRED');
    const runIds = new Set<string>();
    const transcriptHashes = new Set<string>();
    const clientResults = [];
    for (const client of evidence.clientNames) {
        const runs = evidence.runs.filter(run => run.client === client);
        if (runs.length < 2)
            failures.push('TWO_CLEAN_RUNS_REQUIRED:' + client);
        let succeeded = 0, total = 0;
        const times: number[] = [];
        for (const run of runs) {
            if (runIds.has(run.runId))
                failures.push('DUPLICATE_RUN');
            runIds.add(run.runId);
            if (new Set(run.tasks.map(t => t.task)).size !== 10)
                failures.push('TASK_COVERAGE_INCOMPLETE');
            for (const task of run.tasks) {
                const elapsed = Date.parse(task.finishedAt) - Date.parse(task.startedAt);
                if (elapsed < 0 || Date.parse(task.finishedAt) > now)
                    failures.push('TASK_TIME_INVALID');
                if (transcriptHashes.has(task.transcriptSha256))
                    failures.push('TRANSCRIPT_REUSED');
                transcriptHashes.add(task.transcriptSha256);
                total++;
                if (task.outcome === 'success' && !task.authorShellOrSql)
                    succeeded++;
                if (task.task === 'text')
                    times.push(elapsed);
            }
        }
        const successRate = total ? succeeded / total : 0;
        times.sort((a, b) => a - b);
        const n = times.length;
        const median = n ? (times[Math.floor((n - 1) / 2)]! + times[Math.floor(n / 2)]!) / 2 : null;
        if (successRate < .9)
            failures.push('SUCCESS_BELOW_90_PERCENT:' + client);
        if (median === null || median > 180000)
            failures.push('TEXT_TO_PREVIEW_OVER_3_MINUTES:' + client);
        clientResults.push({ client, runs: runs.length, total, successRate, textToPreviewMedianMs: median });
    }
    if (evidence.runs.some(run => !evidence.clientNames.includes(run.client)))
        failures.push('UNDECLARED_CLIENT');
    const days = [...new Set(evidence.usageDays)].sort();
    if (days.length < 7 || Date.parse(days.at(-1) ?? '') - Date.parse(days[0] ?? '') < 6 * 86400000 || days.some(day => Date.parse(day) > now))
        failures.push('SEVEN_USAGE_DAYS_REQUIRED');
    if (evidence.lostEdits || evidence.crossSiteAccess || evidence.unannouncedPublications || evidence.blockingIssues)
        failures.push('PILOT_SAFETY_FAILURE');
    if (evidence.ownerReview !== 'accepted')
        failures.push('INDEPENDENT_OWNER_REVIEW_REQUIRED');
    return { status: failures.length ? 'pending-or-failed' : 'evidence-ready-for-independent-verification', clients: clientResults, failures, publicationAuthorized: false };
}
