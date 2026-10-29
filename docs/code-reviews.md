# Code reviews

`code_reviews` stores one execution against a PR's base and head commits.
`code_review_findings` belongs to a review through `review_id`; repeated reviews
create new records. Deleting an execution session does not delete the review.

Clients read `GET /api/v1/code-reviews?repo=owner/repo&prNumber=42` (100 rows per
page) and `GET /api/v1/code-reviews/:id` for the original output and findings.
The same project and owner restrictions as sessions apply. This is a core API;
client applications may add a reviews table using these endpoints.

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
