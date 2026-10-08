// @ts-check

// Only the current review/fix child, with reciprocal ownership on the same repo.
// This is deliberately not a recursive descendant or all-session lookup.
export function workerReviewChild(worker, getJob) {
  const loop = worker.reviewLoop;
  const role = loop?.fixing ? 'fix' : loop?.reviewing ? 'review' : null;
  const id = role === 'fix' ? loop.fixSessionId : role === 'review' ? loop.reviewSessionId : null;
  const child = id ? getJob(id) : null;
  if (
    !child ||
    child.kind !== 'devchat' ||
    child.repo !== worker.repo ||
    child[role === 'fix' ? 'loopFixParentId' : 'loopParentId'] !== worker.id ||
    child.status === 'closed'
  )
    return null;
  return { child, role };
}

export function workerQuestion(worker, getJob) {
  const current = workerReviewChild(worker, getJob);
  if (!current || !current.child.awaitingAnswer) return null;
  const { child, role } = current;
  return {
    childId: child.id,
    role,
    status: child.status,
    questionSeq: child.questionSeq,
    answerable: child.status === 'idle' && Number.isInteger(child.questionSeq),
  };
}
