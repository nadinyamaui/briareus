# Code reviews

`code_reviews` stores one execution against a PR's base and head commits.
`code_review_findings` belongs to a review through `review_id`; repeated reviews
create new records. Deleting an execution session does not delete the review.

Clients read `GET /api/v1/code-reviews?repo=owner/repo&prNumber=42` (100 rows per
page) and `GET /api/v1/code-reviews/:id` for the original output and findings.
The same project and owner restrictions as sessions apply. This is a core API;
client applications may add a reviews table using these endpoints.

`POST /api/v1/code-reviews` with `{ repo, prNumber }` starts discovery using
`stepRuntimes.codeReview`, falling back to the project's action runtime. The
request may select `provider`, `model`, and `effort` explicitly. This workflow
requires a Claude Code provider and invokes `/code-review <effort> <PR URL>`.
It does not substitute another provider when Claude is unavailable.

The core captures Claude's native `ReportFindings` payload when present. For CLI
versions that report only text, one follow-up turn serializes the existing result
without performing another review. Malformed or failed output stays failed.

The core publishes a summary comment first, followed by inline finding comments
on the reviewed commit, using the owner's GitHub identity. A finding with a file
but no exact line becomes a file comment; a finding without a file is included in
the summary. Changed base/head commits stop publication and mark the review
stale. Comment markers let restarts resume publication without duplicates.
`POST /api/v1/code-reviews/:id/retry-publication` retries a failed publication after
checking those markers and the commits, without paying for another discovery run.

Each finding retains severity, details, a code location, proof, comments and the
reviewer's original `reviewerShouldFix` recommendation. Independent verification
has separate status, evidence, commit and session fields. Its `shouldFix` decision
is nullable: an unassessed finding is not a rejected finding, and the reviewer's
recommendation does not establish that a bug exists or is worth fixing.

Category is independent of severity: correctness, efficiency, altitude,
simplification, reuse and test coverage can all be findings. Clients can group
them by `path` and show `category` plus `shortSummary` in each row. The full
`failureScenario` retains the concrete defect or cleanup impact. An original
`reviewerVerdict` from Claude remains separate from independent verification, and
severity stays `unknown` when the command did not assign one.

Output ingestion is atomic. Malformed output fails instead of becoming a clean
review; an explicit empty findings array represents a completed discovery with no
findings. No feedback implementation or automatic code changes are included.
