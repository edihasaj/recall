/** Fresh, frozen fixtures for the v2 intake comparison. Evaluator labels stay local. */
export type Route = "temporal" | "ordinary" | "ignore" | "defer";
export type MemoryType = "rule" | "command" | "gotcha" | "decision" | "review_pattern";
export interface V2Fact { subject: string; predicate: string; value: string; valid_from: string | null; valid_to: string | null; supersedes_source_id?: string; }
export interface V2Source { id: string; observed_at: string; text: string; expected_route: Route; expected_type?: MemoryType; expected_facts: V2Fact[]; }
export interface V2Question { id: string; text: string; now: string; subject: string; predicate: string; as_of: string; observed_before: string; expected_values: string[]; expected_source_ids: string[]; expected_conflict: boolean; }
export interface V2World { id: string; split: "development" | "holdout"; repo: string; family: string; sources: V2Source[]; questions: V2Question[]; }

/** An evaluator-authored clock. It is deliberately independent of each answer's dates. */
export const V2_REFERENCE_NOW = "2026-12-31T12:00:00.000Z";
const iso = (value: string) => new Date(value.includes("T") ? value : `${value}T00:00:00.000Z`).toISOString();
const fact = (subject: string, predicate: string, value: string, valid_from: string | null, valid_to: string | null = null, supersedes_source_id?: string): V2Fact => ({ subject, predicate, value, valid_from: valid_from && iso(valid_from), valid_to: valid_to && iso(valid_to), supersedes_source_id });
const source = (id: string, observed_at: string, text: string, expected_route: Route, expected_facts: V2Fact[] = [], expected_type?: MemoryType): V2Source => ({ id, observed_at: iso(observed_at), text, expected_route, expected_type, expected_facts });
const question = (id: string, text: string, subject: string, predicate: string, as_of: string, observed_before: string, expected_values: string[], expected_source_ids: string[], expected_conflict = false): V2Question => {
  const effective = iso(as_of); const cutoff = iso(observed_before);
  return { id, text: `${text} Resolve the effective state at ${effective}, using only sources observed no later than ${cutoff}.`, now: V2_REFERENCE_NOW, subject, predicate, as_of: effective, observed_before: cutoff, expected_values, expected_source_ids, expected_conflict };
};
const currentQuestion = (id: string, text: string, subject: string, predicate: string, expected_values: string[], expected_source_ids: string[], expected_conflict = false) => question(id, `${text} At the current reference time ${V2_REFERENCE_NOW},`, subject, predicate, V2_REFERENCE_NOW, V2_REFERENCE_NOW, expected_values, expected_source_ids, expected_conflict);
const world = (id: string, split: V2World["split"], family: string, sources: V2Source[], questions: V2Question[]): V2World => ({ id, split, family, repo: `workbench/${id}-archive`, sources, questions });

export const V2_PREDICATES = [
  "storage_provider", "gateway", "currency", "ttl_days", "ranking_mode", "size", "mode", "cutoff_mode", "schedule_mode", "format", "transport",
] as const;

// The first six worlds are development. All later worlds are holdout and were authored together.
export const V2_WORLDS: readonly V2World[] = [
  world("cedar", "development", "explicit replacement", [
    source("cedar-a", "2026-01-04", "Cedar Ledger ran on Wasabi storage from 2026-01-01.", "temporal", [fact("cedar ledger", "storage_provider", "Wasabi", "2026-01-01")]),
    source("cedar-b", "2026-03-03", "Confirmed: Cedar Ledger moved to Backblaze B2 on 2026-03-01, replacing cedar-a.", "temporal", [fact("cedar ledger", "storage_provider", "Backblaze B2", "2026-03-01", null, "cedar-a")]),
    source("cedar-c", "2026-03-05", "An audit independently observed Cedar Ledger on Backblaze B2 from 2026-03-01.", "temporal", [fact("cedar ledger", "storage_provider", "Backblaze B2", "2026-03-01")]),
  ], [question("cedar-q1", "Which storage backed Cedar Ledger in February?", "cedar ledger", "storage_provider", "2026-02-14", "2026-03-06", ["Wasabi"], ["cedar-a"]), question("cedar-q2", "What stored Cedar Ledger after the move?", "cedar ledger", "storage_provider", "2026-03-04", "2026-03-06", ["Backblaze B2", "Backblaze B2"], ["cedar-b", "cedar-c"]), question("cedar-q3", "What was known before the confirmation arrived?", "cedar ledger", "storage_provider", "2026-03-02", "2026-03-02", ["Wasabi"], ["cedar-a"]), currentQuestion("cedar-current", "Which storage backs Cedar Ledger?", "cedar ledger", "storage_provider", ["Backblaze B2", "Backblaze B2"], ["cedar-b", "cedar-c"])]),
  world("meridian", "development", "independent disagreement", [
    source("meridian-a", "2026-02-01", "The Meridian relay gateway has been Copper since 2026-02-01.", "temporal", [fact("meridian relay", "gateway", "Copper", "2026-02-01")]),
    source("meridian-b", "2026-02-02", "A field report says Meridian relay used Silver as of 2026-02-01.", "temporal", [fact("meridian relay", "gateway", "Silver", "2026-02-01")]),
    source("meridian-c", "2026-02-03", "The operating manual confirms the Meridian relay gateway was Copper on 2026-02-01.", "temporal", [fact("meridian relay", "gateway", "Copper", "2026-02-01")]),
  ], [question("meridian-q1", "What gateway reports remain visible for Meridian relay?", "meridian relay", "gateway", "2026-02-04", "2026-02-04", ["Copper", "Silver", "Copper"], ["meridian-a", "meridian-b", "meridian-c"], true), question("meridian-q2", "What did the first report say?", "meridian relay", "gateway", "2026-02-04", "2026-02-01", ["Copper"], ["meridian-a"]), currentQuestion("meridian-current", "Which gateway reports remain visible for Meridian relay?", "meridian relay", "gateway", ["Copper", "Silver", "Copper"], ["meridian-a", "meridian-b", "meridian-c"], true)]),
  world("larkspur", "development", "dates and exclusive end", [
    source("larkspur-a", "2024-02-29", "Larkspur Vault kept data for 45 days beginning on leap day 2024-02-29.", "temporal", [fact("larkspur vault", "ttl_days", "45", "2024-02-29")]),
    source("larkspur-b", "2026-04-01", "For April only, Larkspur Vault retention was 14 days from 2026-04-01 until 2026-04-10 exclusive.", "temporal", [fact("larkspur vault", "ttl_days", "14", "2026-04-01", "2026-04-10")]),
    source("larkspur-c", "2026-05-02", "Larkspur Vault changed to 30-day retention on 2026-05-01, replacing larkspur-a.", "temporal", [fact("larkspur vault", "ttl_days", "30", "2026-05-01", null, "larkspur-a")]),
  ], [question("larkspur-q1", "What retention applied on 2024-02-29?", "larkspur vault", "ttl_days", "2024-02-29", "2024-03-01", ["45"], ["larkspur-a"]), question("larkspur-q2", "What retention applies at the exclusive April endpoint?", "larkspur vault", "ttl_days", "2026-04-10", "2026-04-11", ["45"], ["larkspur-a"]), question("larkspur-q3", "What is the May retention?", "larkspur vault", "ttl_days", "2026-05-02", "2026-05-03", ["30"], ["larkspur-c"]), currentQuestion("larkspur-current", "What retention applies to Larkspur Vault?", "larkspur vault", "ttl_days", ["30"], ["larkspur-c"])]),
  world("orchid", "development", "observed present state", [
    source("orchid-a", "2026-06-09", "At today’s review, Orchid Broker is in guarded mode.", "temporal", [fact("orchid broker", "mode", "guarded", null)]),
    source("orchid-b", "2026-06-10", "A separate operator also sees Orchid Broker in guarded mode today.", "temporal", [fact("orchid broker", "mode", "guarded", null)]),
    source("orchid-c", "2026-06-12", "Orchid Broker entered open mode on 2026-06-12, replacing orchid-a.", "temporal", [fact("orchid broker", "mode", "open", "2026-06-12", null, "orchid-a")]),
  ], [question("orchid-q1", "What was known about Orchid Broker on June 8?", "orchid broker", "mode", "2026-06-08", "2026-06-13", [], []), question("orchid-q2", "What mode appears at the June 10 observation?", "orchid broker", "mode", "2026-06-10", "2026-06-11", ["guarded", "guarded"], ["orchid-a", "orchid-b"]), question("orchid-q3", "What mode applies after the dated change?", "orchid broker", "mode", "2026-06-13", "2026-06-13", ["open", "guarded"], ["orchid-b", "orchid-c"], true)]),
  world("harbor", "development", "ordinary controls", [
    source("harbor-a", "2026-01-08", "Always preserve the migration receipt with a schema change.", "ordinary", [], "rule"),
    source("harbor-b", "2026-01-09", "Run the focused reconciliation test before sharing a patch.", "ordinary", [], "command"),
    source("harbor-c", "2026-01-10", "Gotcha: rotating a fixture clock invalidates snapshot dates.", "ordinary", [], "gotcha"),
  ], [question("harbor-q1", "What storage provider backs Harbor?", "harbor", "storage_provider", "2026-01-11", "2026-01-11", [], []), question("harbor-q2", "What is Harbor transport?", "harbor", "transport", "2026-01-11", "2026-01-11", [], []), question("harbor-q3", "What schedule mode backs Harbor?", "harbor", "schedule_mode", "2026-01-11", "2026-01-11", [], [])]),
  world("polder", "development", "ignore and defer", [
    source("polder-a", "2026-07-01", "Example only: Polder Index uses MarsNet from 2026-07-01.", "ignore"),
    source("polder-b", "2026-07-02", "If Polder Index adopted rapid ranking next month, dashboards would change.", "ignore"),
    source("polder-c", "2026-07-03", "Polder Index may move to an unspecified ranking setting sometime this summer.", "defer"),
  ], [question("polder-q1", "What ranking mode does Polder Index use?", "polder index", "ranking_mode", "2026-07-04", "2026-07-04", [], []), question("polder-q2", "What transport does Polder Index use?", "polder index", "transport", "2026-07-04", "2026-07-04", [], []), question("polder-q3", "What format does Polder Index use?", "polder index", "format", "2026-07-04", "2026-07-04", [], [])]),
  world("saffron", "holdout", "expired successor no revival", [
    source("saffron-a", "2026-01-01", "Saffron Search used plain ranking from 2026-01-01.", "temporal", [fact("saffron search", "ranking_mode", "plain", "2026-01-01")]),
    source("saffron-b", "2026-02-02", "Saffron Search used spectral ranking from 2026-02-01 through 2026-02-10 exclusive, replacing saffron-a.", "temporal", [fact("saffron search", "ranking_mode", "spectral", "2026-02-01", "2026-02-10", "saffron-a")]),
    source("saffron-c", "2026-03-01", "A review notes Saffron Search had no ranking assignment after the trial ended.", "defer"),
  ], [question("saffron-q1", "Which ranking applied during the trial?", "saffron search", "ranking_mode", "2026-02-05", "2026-02-11", ["spectral"], ["saffron-b"]), question("saffron-q2", "Which ranking applies after the trial expired?", "saffron search", "ranking_mode", "2026-02-11", "2026-03-02", [], [])]),
  world("nimbus", "holdout", "late correction cutoff", [
    source("nimbus-a", "2026-03-01", "Nimbus Invoices used CAD from 2026-03-01.", "temporal", [fact("nimbus invoices", "currency", "CAD", "2026-03-01")]),
    source("nimbus-b", "2026-05-09", "Correction: Nimbus Invoices used USD from 2026-04-01, replacing nimbus-a.", "temporal", [fact("nimbus invoices", "currency", "USD", "2026-04-01", null, "nimbus-a")]),
    source("nimbus-c", "2026-05-10", "Finance independently recorded Nimbus Invoices as USD since 2026-04-01.", "temporal", [fact("nimbus invoices", "currency", "USD", "2026-04-01")]),
  ], [question("nimbus-q1", "Which currency was knowable on April 15 before the correction?", "nimbus invoices", "currency", "2026-04-15", "2026-05-01", ["CAD"], ["nimbus-a"]), question("nimbus-q2", "Which currency is supported after the correction?", "nimbus invoices", "currency", "2026-04-15", "2026-05-11", ["USD", "USD"], ["nimbus-b", "nimbus-c"]), currentQuestion("nimbus-current", "Which currency is supported for Nimbus Invoices?", "nimbus invoices", "currency", ["USD", "USD"], ["nimbus-b", "nimbus-c"])]),
  world("solace", "holdout", "timezone instant", [
    source("solace-a", "2026-08-01", "Solace Billing switched to strict cutoff at 2026-08-01T00:00:00+02:00.", "temporal", [fact("solace billing", "cutoff_mode", "strict", "2026-07-31T22:00:00Z")]),
    source("solace-b", "2026-08-03", "Solace Billing format is receipt-v3 from 2026-08-03.", "temporal", [fact("solace billing", "format", "receipt-v3", "2026-08-03")]),
    source("solace-c", "2026-08-04", "The Solace Billing cutoff label was never changed in the draft mockup.", "ignore"),
  ], [question("solace-q1", "What cutoff applies at 21:59:59 UTC?", "solace billing", "cutoff_mode", "2026-07-31T21:59:59Z", "2026-08-02", [], []), question("solace-q2", "What cutoff applies at 22:00 UTC?", "solace billing", "cutoff_mode", "2026-07-31T22:00:00Z", "2026-08-02", ["strict"], ["solace-a"]), question("solace-q3", "Which format appears in August?", "solace billing", "format", "2026-08-04", "2026-08-04", ["receipt-v3"], ["solace-b"]), currentQuestion("solace-current", "Which format is supported for Solace Billing?", "solace billing", "format", ["receipt-v3"], ["solace-b"])]),
  world("ember", "holdout", "multi-property expansion", [
    source("ember-a", "2026-09-01", "On 2026-09-01, Ember Queue set schedule mode to nightly and transport to HTTPS.", "temporal", [fact("ember queue", "schedule_mode", "nightly", "2026-09-01"), fact("ember queue", "transport", "HTTPS", "2026-09-01")]),
    source("ember-b", "2026-09-02", "Ember Queue size became 12 on 2026-09-02.", "temporal", [fact("ember queue", "size", "12", "2026-09-02")]),
    source("ember-c", "2026-09-03", "Ember Queue may send either HTTPS or QUIC while an experiment runs.", "defer"),
  ], [question("ember-q1", "How is Ember Queue scheduled?", "ember queue", "schedule_mode", "2026-09-03", "2026-09-03", ["nightly"], ["ember-a"]), question("ember-q2", "Which transport is recorded for Ember Queue?", "ember queue", "transport", "2026-09-03", "2026-09-03", ["HTTPS"], ["ember-a"]), question("ember-q3", "What queue size is recorded?", "ember queue", "size", "2026-09-03", "2026-09-03", ["12"], ["ember-b"]), currentQuestion("ember-current", "How is Ember Queue scheduled?", "ember queue", "schedule_mode", ["nightly"], ["ember-a"])]),
  world("cobalt", "holdout", "ordinary decision review", [
    source("cobalt-a", "2026-02-05", "We chose append-only notes so incident evidence stays reviewable.", "ordinary", [], "decision"),
    source("cobalt-b", "2026-02-06", "Review pattern: ask for a time-bound reproduction when a cache bug is reported.", "ordinary", [], "review_pattern"),
    source("cobalt-c", "2026-02-07", "Keep review comments in complete sentences for external contributors.", "ordinary", [], "rule"),
  ], [question("cobalt-q1", "What gateway does Cobalt use?", "cobalt", "gateway", "2026-02-08", "2026-02-08", [], []), question("cobalt-q2", "What currency does Cobalt use?", "cobalt", "currency", "2026-02-08", "2026-02-08", [], [])]),
  world("quartz", "holdout", "ordinary procedures", [
    source("quartz-a", "2026-02-11", "Before release, run the documentation link check.", "ordinary", [], "command"),
    source("quartz-b", "2026-02-12", "Gotcha: a stale local schema can make a clean migration look valid.", "ordinary", [], "gotcha"),
    source("quartz-c", "2026-02-13", "The team decided exports must remain usable while offline.", "ordinary", [], "decision"),
  ], [question("quartz-q1", "What storage provider does Quartz use?", "quartz", "storage_provider", "2026-02-14", "2026-02-14", [], []), question("quartz-q2", "What format does Quartz use?", "quartz", "format", "2026-02-14", "2026-02-14", [], [])]),
  world("alder", "holdout", "ordinary standing guidance", [
    source("alder-a", "2026-03-11", "Always write a focused regression for a repaired parser defect.", "ordinary", [], "rule"),
    source("alder-b", "2026-03-12", "Review pattern: reject an unscoped repository-wide substitution.", "ordinary", [], "review_pattern"),
    source("alder-c", "2026-03-13", "Run the generated client check after editing an API schema.", "ordinary", [], "command"),
  ], [question("alder-q1", "What mode does Alder use?", "alder", "mode", "2026-03-14", "2026-03-14", [], []), question("alder-q2", "What cutoff mode does Alder use?", "alder", "cutoff_mode", "2026-03-14", "2026-03-14", [], [])]),
  world("fable", "holdout", "ordinary caveats", [
    source("fable-a", "2026-04-11", "Gotcha: a source observation date is not its effective date.", "ordinary", [], "gotcha"),
    source("fable-b", "2026-04-12", "We decided raw provider errors must not enter a report.", "ordinary", [], "decision"),
    source("fable-c", "2026-04-13", "Keep fixture names readable for reviewers.", "ordinary", [], "rule"),
  ], [question("fable-q1", "What schedule mode does Fable use?", "fable", "schedule_mode", "2026-04-14", "2026-04-14", [], []), question("fable-q2", "What transport does Fable use?", "fable", "transport", "2026-04-14", "2026-04-14", [], [])]),
  world("juniper", "holdout", "ordinary review commands", [
    source("juniper-a", "2026-05-11", "Run the isolated store check before comparing timing results.", "ordinary", [], "command"),
    source("juniper-b", "2026-05-12", "Review pattern: preserve a counterexample in the failure denominator.", "ordinary", [], "review_pattern"),
    source("juniper-c", "2026-05-13", "Gotcha: same-value corroboration is still separate evidence.", "ordinary", [], "gotcha"),
  ], [question("juniper-q1", "What ranking mode does Juniper use?", "juniper", "ranking_mode", "2026-05-14", "2026-05-14", [], []), question("juniper-q2", "What TTL does Juniper use?", "juniper", "ttl_days", "2026-05-14", "2026-05-14", [], [])]),
  world("vela", "holdout", "unsupported controls", [
    source("vela-a", "2026-06-01", "Vela Sync did not switch to batch mode on 2026-06-01.", "ignore"),
    source("vela-b", "2026-06-02", "The Vela Sync plan for QUIC was cancelled before rollout.", "defer"),
    source("vela-c", "2026-06-03", "In a dry run, Vela Sync used the lunar gateway.", "ignore"),
  ], [question("vela-q1", "What mode does Vela Sync use?", "vela sync", "mode", "2026-06-04", "2026-06-04", [], []), question("vela-q2", "What transport does Vela Sync use?", "vela sync", "transport", "2026-06-04", "2026-06-04", [], []), question("vela-q3", "What gateway does Vela Sync use?", "vela sync", "gateway", "2026-06-04", "2026-06-04", [], [])]),
  world("rivulet", "holdout", "events versus state", [
    source("rivulet-a", "2026-07-01", "Rivulet Runner completed a migration on 2026-07-01.", "defer"),
    source("rivulet-b", "2026-07-02", "Rivulet Runner will evaluate a faster gateway next quarter.", "defer"),
    source("rivulet-c", "2026-07-03", "Rivulet Runner transport has been HTTPS since 2026-07-03.", "temporal", [fact("rivulet runner", "transport", "HTTPS", "2026-07-03")]),
  ], [question("rivulet-q1", "What transport does Rivulet Runner use?", "rivulet runner", "transport", "2026-07-04", "2026-07-04", ["HTTPS"], ["rivulet-c"]), question("rivulet-q2", "What gateway does Rivulet Runner use?", "rivulet runner", "gateway", "2026-07-04", "2026-07-04", [], []), question("rivulet-q3", "What schedule mode does Rivulet Runner use?", "rivulet runner", "schedule_mode", "2026-07-04", "2026-07-04", [], [])]),
  world("tangent", "holdout", "ambiguous and policy scope", [
    source("tangent-a", "2026-08-01", "Tangent API changed mode on 04/05/2026, but the regional date order is unspecified.", "defer"),
    source("tangent-b", "2026-08-02", "For this one rollout, Tangent API may use a temporary gateway.", "ignore"),
    source("tangent-c", "2026-08-03", "Tangent API format has been envelope-v2 since 2026-08-03.", "temporal", [fact("tangent api", "format", "envelope-v2", "2026-08-03")]),
  ], [question("tangent-q1", "What format is recorded for Tangent API?", "tangent api", "format", "2026-08-04", "2026-08-04", ["envelope-v2"], ["tangent-c"]), question("tangent-q2", "What mode is recorded for Tangent API?", "tangent api", "mode", "2026-08-04", "2026-08-04", [], [])]),
  world("zephyr", "holdout", "corroboration preservation", [
    source("zephyr-a", "2026-09-10", "Zephyr Gateway has used Amber since 2026-09-10.", "temporal", [fact("zephyr gateway", "gateway", "Amber", "2026-09-10")]),
    source("zephyr-b", "2026-09-11", "A second deployment log confirms Zephyr Gateway uses Amber from 2026-09-10.", "temporal", [fact("zephyr gateway", "gateway", "Amber", "2026-09-10")]),
    source("zephyr-c", "2026-09-12", "Zephyr Gateway uses Amber in the tutorial screenshot only.", "ignore"),
  ], [question("zephyr-q1", "Which gateway evidence is present?", "zephyr gateway", "gateway", "2026-09-13", "2026-09-13", ["Amber", "Amber"], ["zephyr-a", "zephyr-b"]), question("zephyr-q2", "Which gateway was visible after the first log only?", "zephyr gateway", "gateway", "2026-09-13", "2026-09-10", ["Amber"], ["zephyr-a"])]),
  world("mosaic", "holdout", "source cutoff and unknown", [
    source("mosaic-a", "2026-10-01", "Mosaic Reports use compact schedule mode from 2026-10-01.", "temporal", [fact("mosaic reports", "schedule_mode", "compact", "2026-10-01")]),
    source("mosaic-b", "2026-11-15", "Mosaic Reports changed to interval schedule mode on 2026-10-20, replacing mosaic-a.", "temporal", [fact("mosaic reports", "schedule_mode", "interval", "2026-10-20", null, "mosaic-a")]),
    source("mosaic-c", "2026-11-16", "The Mosaic Reports team is considering a color refresh.", "defer"),
  ], [question("mosaic-q1", "What schedule was known on October 25 before the later report?", "mosaic reports", "schedule_mode", "2026-10-25", "2026-11-01", ["compact"], ["mosaic-a"]), question("mosaic-q2", "What schedule is supported after the later report?", "mosaic reports", "schedule_mode", "2026-10-25", "2026-11-17", ["interval"], ["mosaic-b"]), question("mosaic-q3", "What currency is known for Mosaic Reports?", "mosaic reports", "currency", "2026-11-17", "2026-11-17", [], [])]),
];

export const V2_VERSION = "temporal-v2-fresh-2026-10-18";
