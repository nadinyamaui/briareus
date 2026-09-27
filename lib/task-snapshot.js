// @ts-check
// Deliberately excludes prompts, transcripts, workspace paths and credentials.
// These small audit records survive deletion just as the usage ledger does.
export function taskSnapshot(job) {
  return {
    id: job.id,
    repo: job.repo,
    title: job.title,
    activity: job.activity || 'chat',
    parentId: job.loopParentId || job.qaParentId || job.loopFixParentId || job.parentId || null,
    status: job.status,
    branch: job.branch || job.startBranch || null,
    createdAt: job.createdAt,
    endedAt: job.endedAt || null,
    prNumber: job.prStatus?.number || job.prNumber || job.startedOnPr || null,
    prState: job.prStatus?.state || job.prState || null,
    reviewRounds: job.reviewLoop?.rounds || job.reviewRounds || 0,
    reviewDone: job.reviewLoop?.done === true || job.reviewDone === true,
    qaDone: job.qaLoop?.done === true || job.qaDone === true,
    qaFailed: job.qaLoop?.failedScenarios || job.qaFailed || 0,
    qaFailure: !!job.qaLoop?.failure || job.qaFailure === true,
  };
}
