/**
 * Frozen synthetic development evaluation for UMP temporal intake.
 * These invented conversations are not an official benchmark, independent
 * held-out evidence, or proof of quality against any external memory system.
 * Capture receives source fields only; expected labels and queries stay local.
 */
export type UmpCategory = "first_person" | "dated_change" | "late_correction" |
  "future_effective" | "ambiguity_negation" | "unsupported_events";
export interface UmpExpectedFact {
  subject: string; predicate: string; value: string;
  valid_from: string; valid_to: string | null;
}
export interface UmpFixtureSource {
  event_id: string; text: string; observed_at: string;
  speaker_spans?: { start: number; end: number; role: "user" | "assistant"; subject: string }[];
  expected: UmpExpectedFact[]; source_is_unsupported?: boolean;
}
export interface UmpFixtureQuery {
  question: string; subject: string; predicate: string;
  as_of: string; observed_before: string; expected_values: string[];
}
export interface UmpFixtureWorld {
  id: string; category: UmpCategory; difficulty: "straightforward" | "harder";
  sources: UmpFixtureSource[]; queries: UmpFixtureQuery[];
}

/** Narrow state-only vocabulary. Events, duration and hypothetical states defer. */
export const UMP_POLICIES = [
  { name: "home_city", description: "A person's explicitly stated home city, not visits, travel, another person's home, or a hypothetical move.", value_kind: "string", value_case: "preserve" },
  { name: "employer", description: "A person's explicitly stated employing organization, not interviews, offers, meetings, or a hypothetical job.", value_kind: "string", value_case: "preserve" },
  { name: "primary_database", description: "A service's explicitly stated primary database, not evaluation, training, migrations without a resulting state, or a hypothetical choice.", value_kind: "string", value_case: "preserve" },
  { name: "subscription_tier", description: "An account's explicitly stated subscription tier, not shopping, offers, cancelled plans, or possible upgrades.", value_kind: "string", value_case: "preserve" },
  { name: "service_region", description: "A service's explicitly stated serving region, not test locations, trips, meetings, or a hypothetical deployment.", value_kind: "string", value_case: "preserve" },
] as const;

// Pure fixture constructors: they perform no capture, query, IO or model calls.
const F = (subject: string, predicate: string, value: string, valid_from: string, valid_to: string | null = null): UmpExpectedFact =>
  ({ subject, predicate, value, valid_from, valid_to });
const S = (event_id: string, observed_at: string, text: string, expected: UmpExpectedFact[], speaker?: string, unsupported = false): UmpFixtureSource => ({
  event_id, text, observed_at, expected,
  ...(speaker ? { speaker_spans: [{ start: 0, end: text.length, role: "user" as const, subject: speaker }] } : {}),
  ...(unsupported ? { source_is_unsupported: true } : {}),
});
const Q = (question: string, subject: string, predicate: string, as_of: string, observed_before: string, expected_values: string[]): UmpFixtureQuery =>
  ({ question, subject, predicate, as_of, observed_before, expected_values });
const W = (id: string, category: UmpCategory, difficulty: UmpFixtureWorld["difficulty"], sources: UmpFixtureSource[], queries: UmpFixtureQuery[]): UmpFixtureWorld =>
  ({ id, category, difficulty, sources, queries });

export const UMP_FIXTURE_VERSION = "ump-temporal-synthetic-development-2034-v1";
export const UMP_WORLDS: readonly UmpFixtureWorld[] = [
  W("ump-fp-01", "first_person", "straightforward", [
    S("ump-fp-01-a", "2034-01-19", "My home city has been Talven since 2034-01-11.",
      [F("nira velen", "home_city", "Talven", "2034-01-11")], "nira velen"),
  ], [
    Q("Where did Nira Velen live on January 15?", "nira velen", "home_city", "2034-01-15", "2034-01-20", ["Talven"]),
    Q("Do we know Nira's home city before January 11?", "nira velen", "home_city", "2034-01-10", "2034-01-20", []),
  ]),
  W("ump-fp-02", "first_person", "straightforward", [
    S("ump-fp-02-a", "2034-02-16", "My employer has been Brindle Works since 2034-02-09.",
      [F("orin dask", "employer", "Brindle Works", "2034-02-09")], "orin dask"),
  ], [
    Q("Who employed Orin Dask on February 10?", "orin dask", "employer", "2034-02-10", "2034-02-17", ["Brindle Works"]),
  ]),
  W("ump-fp-03", "first_person", "straightforward", [
    S("ump-fp-03-a", "2034-03-21", "My subscription tier has been Studio since 2034-03-14.",
      [F("vesa torren", "subscription_tier", "Studio", "2034-03-14")], "vesa torren"),
  ], [
    Q("What subscription tier did Vesa Torren have on March 20?", "vesa torren", "subscription_tier", "2034-03-20", "2034-03-22", ["Studio"]),
  ]),
  W("ump-fp-04", "first_person", "harder", [
    S("ump-fp-04-a", "2034-04-18", "My colleague said, \"My employer has been Quill Foundry since 2034-04-07.\" I have not named my own employer.",
      [], "dalen pex", true),
  ], [
    Q("Who employed Dalen Pex on April 17?", "dalen pex", "employer", "2034-04-17", "2034-04-19", []),
  ]),

  W("ump-dc-01", "dated_change", "straightforward", [
    S("ump-dc-01-a", "2034-05-06", "Tessan Ledger's primary database has been RillDB since 2034-05-02.",
      [F("tessan ledger", "primary_database", "RillDB", "2034-05-02")]),
    S("ump-dc-01-b", "2034-05-24", "On 2034-05-20, Tessan Ledger changed its primary database from RillDB to PebbleSQL. This replaces the RillDB state reported in ump-dc-01-a.",
      [F("tessan ledger", "primary_database", "PebbleSQL", "2034-05-20")]),
  ], [
    Q("Which primary database backed Tessan Ledger on May 19?", "tessan ledger", "primary_database", "2034-05-19", "2034-05-25", ["RillDB"]),
    Q("Which primary database backed Tessan Ledger on May 20?", "tessan ledger", "primary_database", "2034-05-20", "2034-05-25", ["PebbleSQL"]),
  ]),
  W("ump-dc-02", "dated_change", "straightforward", [
    S("ump-dc-02-a", "2034-06-08", "Marren Relay's service region has been west-ridge since 2034-06-03.",
      [F("marren relay", "service_region", "west-ridge", "2034-06-03")]),
    S("ump-dc-02-b", "2034-06-27", "Marren Relay changed its service region from west-ridge to east-vale on 2034-06-23, replacing the west-ridge state in ump-dc-02-a.",
      [F("marren relay", "service_region", "east-vale", "2034-06-23")]),
  ], [
    Q("Where did Marren Relay serve on June 22?", "marren relay", "service_region", "2034-06-22", "2034-06-28", ["west-ridge"]),
    Q("Where did Marren Relay serve on June 24?", "marren relay", "service_region", "2034-06-24", "2034-06-28", ["east-vale"]),
  ]),
  W("ump-dc-03", "dated_change", "straightforward", [
    S("ump-dc-03-a", "2034-07-09", "Iven Pell's subscription tier has been Basic since 2034-07-04.",
      [F("iven pell", "subscription_tier", "Basic", "2034-07-04")]),
    S("ump-dc-03-b", "2034-07-28", "Iven Pell changed subscription tier from Basic to Team on 2034-07-25, replacing the Basic state in ump-dc-03-a.",
      [F("iven pell", "subscription_tier", "Team", "2034-07-25")]),
  ], [
    Q("What tier did Iven Pell have before the upgrade?", "iven pell", "subscription_tier", "2034-07-24", "2034-07-29", ["Basic"]),
    Q("What tier did Iven Pell have at the upgrade boundary?", "iven pell", "subscription_tier", "2034-07-25", "2034-07-29", ["Team"]),
  ]),
  W("ump-dc-04", "dated_change", "harder", [
    S("ump-dc-04-a", "2034-08-29", "For a temporary residence, Luma Senn's home city was Kestrel Bay from 2034-08-12 until 2034-08-26 exclusive. No later home city is recorded.",
      [F("luma senn", "home_city", "Kestrel Bay", "2034-08-12", "2034-08-26")]),
  ], [
    Q("Where was Luma Senn's home on August 25?", "luma senn", "home_city", "2034-08-25", "2034-08-30", ["Kestrel Bay"]),
    Q("Where was Luma Senn's home at the exclusive endpoint?", "luma senn", "home_city", "2034-08-26", "2034-08-30", []),
  ]),

  W("ump-lc-01", "late_correction", "straightforward", [
    S("ump-lc-01-a", "2034-09-06", "Ossa Marten's employer has been Maple Thread since 2034-09-01.",
      [F("ossa marten", "employer", "Maple Thread", "2034-09-01")]),
    S("ump-lc-01-b", "2034-10-17", "Late correction to ump-lc-01-a: Ossa Marten changed employer from Maple Thread to Wren Assembly on 2034-09-19. The new employer replaces the earlier Maple Thread state from that date.",
      [F("ossa marten", "employer", "Wren Assembly", "2034-09-19")]),
  ], [
    Q("What employer was supported for September 22 before the correction arrived?", "ossa marten", "employer", "2034-09-22", "2034-10-01", ["Maple Thread"]),
    Q("What employer was supported for September 22 after the correction arrived?", "ossa marten", "employer", "2034-09-22", "2034-10-18", ["Wren Assembly"]),
  ]),
  W("ump-lc-02", "late_correction", "straightforward", [
    S("ump-lc-02-a", "2034-10-08", "Fennel Portal's primary database has been SlateDB since 2034-10-03.",
      [F("fennel portal", "primary_database", "SlateDB", "2034-10-03")]),
    S("ump-lc-02-b", "2034-11-21", "Late update replacing ump-lc-02-a: Fennel Portal switched its primary database from SlateDB to SprigSQL on 2034-10-24.",
      [F("fennel portal", "primary_database", "SprigSQL", "2034-10-24")]),
  ], [
    Q("Which database was known for October 30 before November's update?", "fennel portal", "primary_database", "2034-10-30", "2034-11-01", ["SlateDB"]),
    Q("Which database was known for October 30 after November's update?", "fennel portal", "primary_database", "2034-10-30", "2034-11-22", ["SprigSQL"]),
  ]),
  W("ump-lc-03", "late_correction", "harder", [
    S("ump-lc-03-a", "2034-11-09", "Runa Tev's home city has been Ferndale since 2034-11-02.",
      [F("runa tev", "home_city", "Ferndale", "2034-11-02")]),
    S("ump-lc-03-b", "2035-01-13", "Correction of ump-lc-03-a: Runa Tev moved her home city from Ferndale to Tallow Reach on 2034-11-27. Replace the Ferndale state from 2034-11-27 onward.",
      [F("runa tev", "home_city", "Tallow Reach", "2034-11-27")]),
  ], [
    Q("Where was Runa Tev's home on November 26 after the correction?", "runa tev", "home_city", "2034-11-26", "2035-01-14", ["Ferndale"]),
    Q("Where was Runa Tev's home on November 27 before the correction was observed?", "runa tev", "home_city", "2034-11-27", "2035-01-12", ["Ferndale"]),
    Q("Where was Runa Tev's home on November 27 with the correction visible?", "runa tev", "home_city", "2034-11-27", "2035-01-13", ["Tallow Reach"]),
  ]),
  W("ump-lc-04", "late_correction", "harder", [
    S("ump-lc-04-a", "2034-12-05", "Nettle Dispatch's service region has been north-mere since 2034-12-01.",
      [F("nettle dispatch", "service_region", "north-mere", "2034-12-01")]),
    S("ump-lc-04-b", "2035-02-15", "Late correction replacing ump-lc-04-a: Nettle Dispatch changed service region from north-mere to south-glade on 2034-12-18.",
      [F("nettle dispatch", "service_region", "south-glade", "2034-12-18")]),
    S("ump-lc-04-c", "2035-02-16", "An independent observation states that Nettle Dispatch's service region has been inner-fen since 2034-12-18. This is a separate report, not a replacement of ump-lc-04-b.",
      [F("nettle dispatch", "service_region", "inner-fen", "2034-12-18")]),
  ], [
    Q("Which region reports remain for Nettle Dispatch after both late reports?", "nettle dispatch", "service_region", "2034-12-20", "2035-02-17", ["south-glade", "inner-fen"]),
    Q("Which region was supported before either late report?", "nettle dispatch", "service_region", "2034-12-20", "2035-02-14", ["north-mere"]),
  ]),

  // Structured append can store future schedules. This language-capture pilot
  // deliberately defers plans; these queries ask the supported current state.
  // This contract correction precedes all model runs.
  W("ump-fe-01", "future_effective", "straightforward", [
    S("ump-fe-01-a", "2035-01-07", "Pellin Index's primary database has been DriftDB since 2035-01-02.",
      [F("pellin index", "primary_database", "DriftDB", "2035-01-02")]),
    S("ump-fe-01-b", "2035-01-14", "Confirmed future schedule: Pellin Index's primary database changes from DriftDB to MossSQL effective 2035-02-11, replacing ump-fe-01-a from that date.",
      [], undefined, true),
  ], [
    Q("What is Pellin Index's current primary database on January 14?", "pellin index", "primary_database", "2035-01-14", "2035-01-15", ["DriftDB"]),
  ]),
  W("ump-fe-02", "future_effective", "straightforward", [
    S("ump-fe-02-a", "2035-02-08", "Saren Dock's service region has been upper-heath since 2035-02-03.",
      [F("saren dock", "service_region", "upper-heath", "2035-02-03")]),
    S("ump-fe-02-b", "2035-02-16", "Confirmed future schedule: Saren Dock's service region changes from upper-heath to lower-brook effective 2035-03-12, replacing ump-fe-02-a.",
      [], undefined, true),
  ], [
    Q("What is Saren Dock's current service region on February 16?", "saren dock", "service_region", "2035-02-16", "2035-02-17", ["upper-heath"]),
  ]),
  W("ump-fe-03", "future_effective", "straightforward", [
    S("ump-fe-03-a", "2035-03-09", "Tavi Reln's subscription tier has been Solo since 2035-03-04.",
      [F("tavi reln", "subscription_tier", "Solo", "2035-03-04")]),
    S("ump-fe-03-b", "2035-03-18", "Confirmed future schedule: Tavi Reln's subscription tier changes from Solo to Collective effective 2035-04-13, replacing ump-fe-03-a.",
      [], undefined, true),
  ], [
    Q("What is Tavi Reln's current subscription tier on March 18?", "tavi reln", "subscription_tier", "2035-03-18", "2035-03-19", ["Solo"]),
  ]),
  W("ump-fe-04", "future_effective", "straightforward", [
    S("ump-fe-04-a", "2035-04-10", "Venn Orla's employer has been Flint Loom since 2035-04-05.",
      [F("venn orla", "employer", "Flint Loom", "2035-04-05")]),
    S("ump-fe-04-b", "2035-04-19", "Confirmed future employment schedule: Venn Orla changes employer from Flint Loom to Rowan Instruments effective 2035-05-14, replacing ump-fe-04-a.",
      [], undefined, true),
  ], [
    Q("Who currently employs Venn Orla on April 19?", "venn orla", "employer", "2035-04-19", "2035-04-20", ["Flint Loom"]),
  ]),

  W("ump-an-01", "ambiguity_negation", "harder", [
    S("ump-an-01-a", "2035-05-22", "Neran Cache did not change its primary database to BirchSQL on 2035-05-16. Its actual primary database is not stated.",
      [], undefined, true),
  ], [
    Q("What primary database backed Neran Cache on May 21?", "neran cache", "primary_database", "2035-05-21", "2035-05-23", []),
  ]),
  W("ump-an-02", "ambiguity_negation", "harder", [
    S("ump-an-02-a", "2035-06-23", "If Solen Bridge had changed its service region to outer-dell on 2035-06-17, latency would have fallen. That change never happened; its actual region is unstated.",
      [], undefined, true),
  ], [
    Q("What service region did Solen Bridge have on June 22?", "solen bridge", "service_region", "2035-06-22", "2035-06-24", []),
  ]),
  W("ump-an-03", "ambiguity_negation", "harder", [
    S("ump-an-03-a", "2035-07-24", "Mirel Annex may use the Plus subscription tier from 2035-07-18, but that is an unapproved proposal and no subscription tier is confirmed.",
      [], undefined, true),
  ], [
    Q("What subscription tier is established for Mirel Annex on July 23?", "mirel annex", "subscription_tier", "2035-07-23", "2035-07-25", []),
  ]),
  W("ump-an-04", "ambiguity_negation", "harder", [
    S("ump-an-04-a", "2035-08-25", "Dovren Stream's primary database has been ThistleDB since 2035-08-19. We might repaint the office later, and no desks were replaced.",
      [F("dovren stream", "primary_database", "ThistleDB", "2035-08-19")]),
  ], [
    Q("What primary database backed Dovren Stream on August 24?", "dovren stream", "primary_database", "2035-08-24", "2035-08-26", ["ThistleDB"]),
  ]),

  W("ump-ue-01", "unsupported_events", "harder", [
    S("ump-ue-01-a", "2035-09-26", "I visited Calden from 2035-09-11 through 2035-09-15. The visit lasted five days. I have not stated my home city.",
      [], "perin shal", true),
  ], [
    Q("What home city is established for Perin Shal on September 20?", "perin shal", "home_city", "2035-09-20", "2035-09-27", []),
  ]),
  W("ump-ue-02", "unsupported_events", "harder", [
    S("ump-ue-02-a", "2035-10-27", "Elvan Rusk interviewed with Copper Kite on 2035-10-21 for two hours. No job offer or employment resulted.",
      [], undefined, true),
  ], [
    Q("Who employed Elvan Rusk on October 26?", "elvan rusk", "employer", "2035-10-26", "2035-10-28", []),
  ]),
  W("ump-ue-03", "unsupported_events", "harder", [
    S("ump-ue-03-a", "2035-11-28", "The Torren Queue team attended a LichenSQL training session on 2035-11-22. It lasted three hours. No primary database choice or database state is stated.",
      [], undefined, true),
  ], [
    Q("Which primary database backed Torren Queue on November 27?", "torren queue", "primary_database", "2035-11-27", "2035-11-29", []),
  ]),
  W("ump-ue-04", "unsupported_events", "harder", [
    S("ump-ue-04-a", "2035-12-29", "The Briar Ferry team held a deployment workshop in silver-marsh on 2035-12-23. The workshop lasted ninety minutes and did not establish a service region.",
      [], undefined, true),
  ], [
    Q("What service region is established for Briar Ferry on December 28?", "briar ferry", "service_region", "2035-12-28", "2035-12-30", []),
  ]),
];
