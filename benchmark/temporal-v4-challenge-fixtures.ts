/**
 * Independently authored targeted synthetic challenges for v4 development.
 * Novel fixture text is not public held-out data or evidence of general quality.
 * No candidate implementation was consulted. Capture sees only source fields.
 */
import type {
  UmpExpectedFact, UmpFixtureQuery, UmpFixtureSource, UmpFixtureWorld,
} from "./temporal-ump-fixtures.js";
export { UMP_POLICIES } from "./temporal-ump-fixtures.js";

// Inputs retain date-only clocks; expected store timestamps use UTC midnight.
const midnight = (date: string): string => `${date}T00:00:00.000Z`;
const F = (subject: string, predicate: string, value: string, from: string, to: string | null = null): UmpExpectedFact =>
  ({ subject, predicate, value, valid_from: midnight(from), valid_to: to ? midnight(to) : null });
const S = (event_id: string, observed_at: string, text: string, expected: UmpExpectedFact[], speaker?: string, unsupported = false): UmpFixtureSource => ({
  event_id, observed_at, text, expected,
  ...(speaker ? { speaker_spans: [{ start: 0, end: text.length, role: "user" as const, subject: speaker }] } : {}),
  ...(unsupported ? { source_is_unsupported: true } : {}),
});
const Q = (question: string, subject: string, predicate: string, as_of: string, observed_before: string, expected_values: string[]): UmpFixtureQuery =>
  ({ question, subject, predicate, as_of, observed_before, expected_values });
const W = (id: string, category: UmpFixtureWorld["category"], difficulty: UmpFixtureWorld["difficulty"], sources: UmpFixtureSource[], queries: UmpFixtureQuery[]): UmpFixtureWorld =>
  ({ id, category, difficulty, sources, queries });

export const V4_CHALLENGE_WORLDS: readonly UmpFixtureWorld[] = [
  W("v4-ch-fp-01", "first_person", "straightforward", [
    S("v4-ch-fp-01-a", "2041-01-23",
      "My employer has been Amber Spindle since 2041-01-08.",
      [F("zela marn", "employer", "Amber Spindle", "2041-01-08")], "zela marn"),
  ], [
    Q("Who employed Zela Marn on January 22?", "zela marn", "employer", "2041-01-22", "2041-01-24", ["Amber Spindle"]),
    Q("Is Zela Marn's employer known for January 7?", "zela marn", "employer", "2041-01-07", "2041-01-24", []),
  ]),
  W("v4-ch-fp-02", "first_person", "harder", [
    S("v4-ch-fp-02-a", "2041-02-24",
      "My sibling's manager wrote, \"My home city has been Opal Crossing since 2041-02-06.\" That sentence reports the manager's home, and I have not stated my own home city.",
      [], "joret vahn", true),
  ], [
    Q("Where was Joret Vahn's home on February 23?", "joret vahn", "home_city", "2041-02-23", "2041-02-25", []),
  ]),

  W("v4-ch-dc-01", "dated_change", "harder", [
    S("v4-ch-dc-01-a", "2041-03-12",
      "Cobalt Orchard's service region was mist-basin from 2041-03-04 until 2041-03-19 exclusive.",
      [F("cobalt orchard", "service_region", "mist-basin", "2041-03-04", "2041-03-19")]),
    S("v4-ch-dc-01-b", "2041-03-25",
      "Cobalt Orchard's service region has been sun-plateau since 2041-03-19. This state replaces the mist-basin state recorded in v4-ch-dc-01-a from 2041-03-19 onward.",
      [F("cobalt orchard", "service_region", "sun-plateau", "2041-03-19")]),
  ], [
    Q("Where did Cobalt Orchard serve on March 18?", "cobalt orchard", "service_region", "2041-03-18", "2041-03-26", ["mist-basin"]),
    Q("Where did Cobalt Orchard serve at the March 19 boundary?", "cobalt orchard", "service_region", "2041-03-19", "2041-03-26", ["sun-plateau"]),
    Q("What region was known for March 19 before the correction arrived?", "cobalt orchard", "service_region", "2041-03-19", "2041-03-20", []),
  ]),
  W("v4-ch-dc-02", "dated_change", "harder", [
    S("v4-ch-dc-02-a", "2041-04-07",
      "Garnet Channel's primary database has been AsterDB since 2041-04-02.",
      [F("garnet channel", "primary_database", "AsterDB", "2041-04-02")]),
    S("v4-ch-dc-02-b", "2041-04-08",
      "Ochre Cabinet's primary database has been MicaSQL since 2041-04-03.",
      [F("ochre cabinet", "primary_database", "MicaSQL", "2041-04-03")]),
    S("v4-ch-dc-02-c", "2041-04-26",
      "Ochre Cabinet's primary database has been DuneDB since 2041-04-17. This corrects Ochre Cabinet's MicaSQL state in v4-ch-dc-02-b. Garnet Channel's proposed move to QuartzSQL, scheduled to take effect on 2041-04-15, remains unexecuted.",
      [F("ochre cabinet", "primary_database", "DuneDB", "2041-04-17")]),
  ], [
    Q("Which database backed Garnet Channel on April 25?", "garnet channel", "primary_database", "2041-04-25", "2041-04-27", ["AsterDB"]),
    Q("Which database backed Ochre Cabinet on April 25?", "ochre cabinet", "primary_database", "2041-04-25", "2041-04-27", ["DuneDB"]),
  ]),

  W("v4-ch-lc-01", "late_correction", "harder", [
    S("v4-ch-lc-01-a", "2041-05-09",
      "Halem Rivo's home city has been Vireo Port since 2041-05-01.",
      [F("halem rivo", "home_city", "Vireo Port", "2041-05-01")]),
    S("v4-ch-lc-01-b", "2041-07-16",
      "Halem Rivo's home city has been Juniper Quay since 2041-05-21. This is a late correction replacing Halem Rivo's Vireo Port state in v4-ch-lc-01-a from 2041-05-21 onward.",
      [F("halem rivo", "home_city", "Juniper Quay", "2041-05-21")]),
  ], [
    Q("What home city was supported for Halem Rivo on May 23 before July's correction?", "halem rivo", "home_city", "2041-05-23", "2041-07-15", ["Vireo Port"]),
    Q("What home city was supported for May 23 when the July 16 correction became visible?", "halem rivo", "home_city", "2041-05-23", "2041-07-16", ["Juniper Quay"]),
    Q("What home city was supported on May 20 after the correction?", "halem rivo", "home_city", "2041-05-20", "2041-07-17", ["Vireo Port"]),
  ]),
  W("v4-ch-lc-02", "late_correction", "harder", [
    S("v4-ch-lc-02-a", "2041-06-11",
      "Indigo Lantern's subscription tier has been Fleet since 2041-06-05.",
      [F("indigo lantern", "subscription_tier", "Fleet", "2041-06-05")]),
    S("v4-ch-lc-02-b", "2041-08-18",
      "An independent billing report states that Indigo Lantern's subscription tier has been Harbor since 2041-06-05. This report is not a replacement or correction of v4-ch-lc-02-a; both reports remain on record.",
      [F("indigo lantern", "subscription_tier", "Harbor", "2041-06-05")]),
  ], [
    Q("What tier was supported for Indigo Lantern on June 20 before the independent report arrived?", "indigo lantern", "subscription_tier", "2041-06-20", "2041-08-17", ["Fleet"]),
    Q("Which tier claims remain for June 20 after both reports?", "indigo lantern", "subscription_tier", "2041-06-20", "2041-08-19", ["Fleet", "Harbor"]),
  ]),

  // State-only capture defers schedules. Queries remain before future effects.
  W("v4-ch-fe-01", "future_effective", "harder", [
    S("v4-ch-fe-01-a", "2042-01-13",
      "Saffron Beacon's service region has been cedar-coast since 2042-01-06.",
      [F("saffron beacon", "service_region", "cedar-coast", "2042-01-06")]),
    S("v4-ch-fe-01-b", "2042-01-27",
      "Confirmed future schedule for 2042-02-22: Saffron Beacon will change its service region to crystal-hill. The draft announcement says, \"Saffron Beacon's service region has been crystal-hill since 2042-02-22.\" This is advance wording for the schedule, not an established state.",
      [], undefined, true),
  ], [
    Q("What is Saffron Beacon's current service region on January 27?", "saffron beacon", "service_region", "2042-01-27", "2042-01-28", ["cedar-coast"]),
  ]),
  W("v4-ch-fe-02", "future_effective", "harder", [
    S("v4-ch-fe-02-a", "2042-03-10",
      "My employer has been Velvet Compass since 2042-03-03.",
      [F("pava keld", "employer", "Velvet Compass", "2042-03-03")], "pava keld"),
    S("v4-ch-fe-02-b", "2042-03-24",
      "My confirmed future employment schedule starts on 2042-04-18 with Sable Mechanics. For that date the prepared notice reads, \"My employer has been Sable Mechanics since 2042-04-18.\" I have not started that job.",
      [], "pava keld", true),
  ], [
    Q("Who currently employs Pava Keld on March 24?", "pava keld", "employer", "2042-03-24", "2042-03-25", ["Velvet Compass"]),
  ]),

  W("v4-ch-an-01", "ambiguity_negation", "harder", [
    S("v4-ch-an-01-a", "2042-05-28",
      "Umber Pavilion's primary database has been LotusSQL since 2042-05-12. We might replace the lobby lights in July, and no paintings have been moved.",
      [F("umber pavilion", "primary_database", "LotusSQL", "2042-05-12")]),
  ], [
    Q("Which database backed Umber Pavilion on May 27?", "umber pavilion", "primary_database", "2042-05-27", "2042-05-29", ["LotusSQL"]),
  ]),
  W("v4-ch-an-02", "ambiguity_negation", "harder", [
    S("v4-ch-an-02-a", "2042-06-29",
      "If Maroon Archive had adopted OrbitDB on 2042-06-14, its primary database would be OrbitDB. It did not adopt OrbitDB, and its actual primary database is unstated.",
      [], undefined, true),
  ], [
    Q("Which primary database is established for Maroon Archive on June 28?", "maroon archive", "primary_database", "2042-06-28", "2042-06-30", []),
  ]),

  W("v4-ch-ue-01", "unsupported_events", "harder", [
    S("v4-ch-ue-01-a", "2042-07-30",
      "I visited Citrine Haven from 2042-07-09 through 2042-07-13 for a five-day festival. That was a visit; my home city is not stated.",
      [], "sori nemb", true),
  ], [
    Q("What home city is established for Sori Nemb on July 29?", "sori nemb", "home_city", "2042-07-29", "2042-07-31", []),
  ]),
  W("v4-ch-ue-02", "unsupported_events", "harder", [
    S("v4-ch-ue-02-a", "2042-08-31",
      "The team for Azure Trestle completed a two-hour PetalSQL evaluation workshop on 2042-08-16. Attendance and evaluation do not establish Azure Trestle's primary database; no database state was reported.",
      [], undefined, true),
  ], [
    Q("What primary database is established for Azure Trestle on August 30?", "azure trestle", "primary_database", "2042-08-30", "2042-09-01", []),
  ]),
];
