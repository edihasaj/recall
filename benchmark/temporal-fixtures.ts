/** Small hand-authored temporal assertions. Query parsing and extraction are out of scope. */
export interface TemporalSourceEvent {
  readonly event_id: string;
  readonly repo: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly valid_from: string;
  readonly valid_to?: string;
  readonly observed_at: string;
  readonly evidence: string;
  readonly supersedes_event_id?: string;
  readonly confidence?: number;
}

export interface TemporalQuestion {
  readonly id: string;
  readonly category: string;
  readonly repo: string;
  readonly subject: string;
  readonly predicate: string;
  readonly as_of: string;
  readonly observed_before: string;
  readonly question: string;
  /** Gold lives only in the evaluator; never include these fields in a model prompt. */
  readonly expected_values: readonly string[];
  readonly expected_event_ids: readonly string[];
  readonly expected_conflict: boolean;
}

export const FIXTURE_VERSION = "temporal-smoke-v1";

export const TEMPORAL_SOURCE_EVENTS: readonly TemporalSourceEvent[] = [
  { event_id: "hosting-azure", repo: "acme/web", subject: "production", predicate: "hosting provider", value: "Azure", valid_from: "2026-01-01", observed_at: "2026-01-02", evidence: "On 2026-01-01 production began using Azure for hosting." },
  { event_id: "hosting-cloudflare", repo: "acme/web", subject: "production", predicate: "hosting provider", value: "Cloudflare", valid_from: "2026-03-01", observed_at: "2026-03-03", supersedes_event_id: "hosting-azure", evidence: "On 2026-03-03 we confirmed production moved from Azure to Cloudflare effective 2026-03-01, replacing hosting-azure." },
  { event_id: "cdn-plan", repo: "acme/web", subject: "marketing site", predicate: "cdn", value: "Cloudflare", valid_from: "2026-07-01", observed_at: "2026-05-15", supersedes_event_id: "cdn-fastly", evidence: "The 2026-05-15 roadmap schedules marketing site CDN to move from Fastly to Cloudflare effective 2026-07-01, replacing cdn-fastly." },
  { event_id: "cdn-fastly", repo: "acme/web", subject: "marketing site", predicate: "cdn", value: "Fastly", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "Marketing site used Fastly beginning 2026-01-01." },
  { event_id: "region-us", repo: "acme/api", subject: "api", predicate: "primary region", value: "us-east-1", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "The API primary region was us-east-1 from 2026-01-01." },
  { event_id: "region-eu-correction", repo: "acme/api", subject: "api", predicate: "primary region", value: "eu-west-1", valid_from: "2026-02-01", observed_at: "2026-04-10", supersedes_event_id: "region-us", evidence: "On 2026-04-10 we corrected the deployment record: API moved from us-east-1 to eu-west-1 effective 2026-02-01, replacing region-us." },
  { event_id: "flag-window", repo: "acme/api", subject: "billing preview", predicate: "enabled", value: "true", valid_from: "2026-02-01", valid_to: "2026-03-01", observed_at: "2026-02-01", evidence: "Billing preview was enabled from 2026-02-01 until 2026-03-01 (exclusive)." },
  { event_id: "owner-alice", repo: "acme/api", subject: "release notes", predicate: "owner", value: "Alice", valid_from: "2026-01-01", observed_at: "2026-01-03", evidence: "Release notes owner was Alice from 2026-01-01." },
  { event_id: "owner-bob", repo: "acme/api", subject: "release notes", predicate: "owner", value: "Bob", valid_from: "2026-01-01", observed_at: "2026-01-04", confidence: 0.99, evidence: "An independent 2026-01-04 release note says Bob owns release notes from 2026-01-01; it does not replace owner-alice." },
  { event_id: "retention-new", repo: "acme/api", subject: "audit logs", predicate: "retention", value: "90 days", valid_from: "2026-03-01", observed_at: "2026-03-02", evidence: "On 2026-03-02 audit log retention became 90 days effective 2026-03-01; this was recorded independently of the later historical import." },
  { event_id: "retention-old", repo: "acme/api", subject: "audit logs", predicate: "retention", value: "30 days", valid_from: "2026-01-01", valid_to: "2026-03-01", observed_at: "2026-04-01", evidence: "Imported on 2026-04-01: audit log retention was 30 days from 2026-01-01 until 2026-03-01 (exclusive)." },
  { event_id: "rollout-v1", repo: "acme/worker", subject: "worker", predicate: "runtime", value: "Node 20", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "Worker ran Node 20 from 2026-01-01." },
  { event_id: "rollout-v2", repo: "acme/worker", subject: "worker", predicate: "runtime", value: "Node 22", valid_from: "2026-03-01", valid_to: "2026-04-01", observed_at: "2026-03-01", supersedes_event_id: "rollout-v1", evidence: "Worker moved from Node 20 to Node 22 effective 2026-03-01 until 2026-04-01, replacing rollout-v1." },
  { event_id: "rollout-v3", repo: "acme/worker", subject: "worker", predicate: "runtime", value: "Node 23", valid_from: "2026-05-01", observed_at: "2026-05-02", supersedes_event_id: "rollout-v2", evidence: "Worker moved from Node 22 to Node 23 effective 2026-05-01, replacing rollout-v2." },
  { event_id: "web-api-owner", repo: "acme/web", subject: "api", predicate: "primary region", value: "ap-southeast-1", valid_from: "2026-01-01", observed_at: "2026-01-01", evidence: "For acme/web, API primary region was ap-southeast-1 from 2026-01-01." },
] as const;

const q = (id: string, category: string, repo: string, subject: string, predicate: string, as_of: string, observed_before: string, expected_values: readonly string[], expected_event_ids: readonly string[], expected_conflict = false): TemporalQuestion => ({
  id, category, repo, subject, predicate, as_of, observed_before,
  question: `What is the ${predicate} for ${subject} in ${repo} effective ${as_of}, using only information observed on or before ${observed_before}?`,
  expected_values, expected_event_ids, expected_conflict,
});

export const TEMPORAL_QUESTIONS: readonly TemporalQuestion[] = [
  q("q01", "ordinary-history", "acme/web", "production", "hosting provider", "2026-02-15", "2026-04-01", ["Azure"], ["hosting-azure"]),
  q("q02", "ordinary-current", "acme/web", "production", "hosting provider", "2026-04-01", "2026-04-01", ["Cloudflare"], ["hosting-cloudflare"]),
  q("q03", "future-effective", "acme/web", "marketing site", "cdn", "2026-06-01", "2026-06-01", ["Fastly"], ["cdn-fastly"]),
  q("q04", "future-effective", "acme/web", "marketing site", "cdn", "2026-07-01", "2026-06-01", ["Cloudflare"], ["cdn-plan"]),
  q("q05", "late-correction", "acme/api", "api", "primary region", "2026-03-01", "2026-03-31", ["us-east-1"], ["region-us"]),
  q("q06", "late-correction", "acme/api", "api", "primary region", "2026-03-01", "2026-04-11", ["eu-west-1"], ["region-eu-correction"]),
  q("q07", "exclusive-boundary", "acme/api", "billing preview", "enabled", "2026-02-28", "2026-03-02", ["true"], ["flag-window"]),
  q("q08", "expired-gap", "acme/api", "billing preview", "enabled", "2026-03-01", "2026-03-02", [], []),
  q("q09", "conflict", "acme/api", "release notes", "owner", "2026-02-01", "2026-02-01", ["Alice", "Bob"], ["owner-alice", "owner-bob"], true),
  q("q10", "out-of-order", "acme/api", "audit logs", "retention", "2026-02-01", "2026-04-02", ["30 days"], ["retention-old"]),
  q("q11", "out-of-order", "acme/api", "audit logs", "retention", "2026-03-15", "2026-04-02", ["90 days"], ["retention-new"]),
  q("q12", "expired-successor", "acme/worker", "worker", "runtime", "2026-04-15", "2026-04-15", [], []),
  q("q13", "replacement-chain", "acme/worker", "worker", "runtime", "2026-02-15", "2026-04-15", ["Node 20"], ["rollout-v1"]),
  q("q14", "replacement-chain", "acme/worker", "worker", "runtime", "2026-03-15", "2026-04-15", ["Node 22"], ["rollout-v2"]),
  q("q15", "repo-isolation", "acme/web", "api", "primary region", "2026-02-01", "2026-02-01", ["ap-southeast-1"], ["web-api-owner"]),
  q("q16", "ordinary-history", "acme/web", "production", "hosting provider", "2026-01-01", "2026-01-02", ["Azure"], ["hosting-azure"]),
  q("q17", "ordinary-current", "acme/web", "production", "hosting provider", "2026-03-01", "2026-03-03", ["Cloudflare"], ["hosting-cloudflare"]),
  q("q18", "future-effective", "acme/web", "marketing site", "cdn", "2026-07-15", "2026-05-15", ["Cloudflare"], ["cdn-plan"]),
  q("q19", "late-correction", "acme/api", "api", "primary region", "2026-01-31", "2026-04-11", ["us-east-1"], ["region-us"]),
  q("q20", "expired-gap", "acme/api", "billing preview", "enabled", "2026-01-31", "2026-03-02", [], []),
  q("q21", "conflict", "acme/api", "release notes", "owner", "2026-01-15", "2026-01-03", ["Alice"], ["owner-alice"]),
  q("q22", "out-of-order", "acme/api", "audit logs", "retention", "2026-02-01", "2026-03-03", [], []),
  q("q23", "expired-successor", "acme/worker", "worker", "runtime", "2026-05-15", "2026-05-15", ["Node 23"], ["rollout-v3"]),
  q("q24", "repo-isolation", "acme/api", "api", "primary region", "2026-02-15", "2026-04-11", ["eu-west-1"], ["region-eu-correction"]),
  // rollout-v3 is not visible yet. rollout-v2 has expired and permanently
  // retired rollout-v1, so this is intentionally an empty successor gap.
  q("q25", "expired-successor-gap", "acme/worker", "worker", "runtime", "2026-04-01", "2026-04-01", [], []),
] as const;
