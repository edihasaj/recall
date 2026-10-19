---
summary: Validation evidence for explicit UMP temporal queries and agent discovery.
read_when:
  - Reviewing the UMP 1.0.4 integration or Recall 2.0.9 release
  - Interpreting the temporal agent smoke and its limits
---

# Explicit temporal query verification

The SDK and Recall integration preserve dated UMP records and expose their
query fields to MCP agents. This does not enable automatic conversational
capture or establish a change in the earlier 434-question accuracy result.

## Code and backend checks

- UMP SDK: 86 tests, typecheck, build, independent review and CI passed.
- Recall's development workspace: 1,273 tests passed, three skipped, using an
  isolated Node 22 installation with its matching SQLite binding.
- The clean release worktree based on current `origin/main`: 1,072 tests passed,
  three skipped; typecheck, documentation check and build passed.
- Real MCP calls exercised historical/current/future validity, revision links,
  scope, forgetting, persistent identity and database close/reopen.
- Cloud payload tests confirmed source records remain local and cannot replace
  ordinary instructions through sync. No production data was used.

Node 24's local SQLite test-runner teardown crashed before tests could finish.
No shared native module was rebuilt; the Node 22 release runtime was used.

## Actual agent smoke

Qwen `qwen3.8-flash-next`, medium reasoning, answered eight authored questions
through the actual built Recall MCP server. Only capabilities, recall and get
were enabled. The agent received natural questions and an exact project
identifier, with no answer values or tool-call arguments.

The strict independent audit scored **7/8**:

| Check | Result |
| --- | --- |
| February hosting: Azure | Correct |
| April hosting: Cloudflare | Correct |
| Current hosting: Cloudflare | Correct |
| AWS future migration remains an unconfirmed plan | Correct |
| April discount: 15 percent | Correct |
| Current discount unsupported by stored evidence | Correct |
| Missing database-engine fact: abstain | Correct |
| Past server knowledge from observation dates | Failed |

There were 17 successful read calls: one capabilities call, 14 recalls and two
gets. Every recall supplied the configured owner and exact project. Five
recalls used explicit validity instants. No writes, scope errors or returned
records outside the requested validity window were observed.

The failed answer recognized that `valid_at` is not an observation-cutoff
query, then incorrectly treated caller-supplied `observed` timestamps as proof
of what the server knew earlier. These timestamps do not authenticate server
ingestion or knowledge. No score reroll was performed.

## Preserved limitations and attempts

Initial setup attempts failed on CLI configuration and provider selection.
A subsequent agent run was blocked by host tool approval. Once the isolated
read tools were authorized, UMP 1.0.3 still failed owner discovery because
Codex did not forward initialization instructions to the model.
UMP 1.0.4 exposes the owner hint through tool schemas and capability results.

The synthetic fixture was accidentally seeded twice during setup by the lead
and a worker. It therefore contained 12 rows, including duplicate matching
source chains and other-owner/project decoys. The agent identified those
duplicates. The full successful-version smoke and earlier failed attempts are
retained; duplicate rows are not independent examples.

The local trace directory is recorded in the task's development report. This
small authored smoke is capability evidence, not a production accuracy
estimate. Candidate enumeration remains O(total rows), and automatic temporal
capture and Recall Cloud integration remain outside this release.
