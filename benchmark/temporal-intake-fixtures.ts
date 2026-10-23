/** Fresh, hand-annotated source-language probe. Gold is evaluator-only. */
export interface IntakeFact {
  subject: string;
  predicate: string;
  value: string;
  valid_from: string;
  valid_to: string | null;
  supersedes_event_id: string | null;
}
export interface IntakeSource {
  event_id: string;
  observed_at: string;
  text: string;
  expected_status: "fact" | "ignore" | "unsupported";
  expected_fact?: IntakeFact;
}
export interface IntakeQuestion {
  id: string;
  text: string;
  subject: string;
  predicate: string;
  as_of: string;
  observed_before: string;
  expected_values: string[];
  expected_event_ids: string[];
  expected_conflict: boolean;
}
export interface IntakeWorld {
  id: string;
  repo: string;
  sources: IntakeSource[];
  questions: IntakeQuestion[];
}

const fact = (
  subject: string, predicate: string, value: string, valid_from: string,
  valid_to: string | null = null, supersedes_event_id: string | null = null,
): IntakeFact => ({ subject, predicate, value, valid_from, valid_to, supersedes_event_id });
const question = (
  id: string, text: string, subject: string, predicate: string,
  as_of: string, observed_before: string, expected_values: string[],
  expected_event_ids: string[], expected_conflict = false,
): IntakeQuestion => ({ id, text, subject, predicate, as_of, observed_before, expected_values, expected_event_ids, expected_conflict });

export const INTAKE_VERSION = "temporal-source-probe-v1";
export const INTAKE_WORLDS: IntakeWorld[] = [
  {
    id: "scheduled", repo: "probe/scheduled",
    sources: [
      { event_id: "s1", observed_at: "2026-01-03", text: "Production has run on Pine since January 1, 2026.", expected_status: "fact", expected_fact: fact("production", "host", "Pine", "2026-01-01") },
      { event_id: "s2", observed_at: "2026-02-05", text: "We have scheduled production's move to River for March 1, 2026. It will replace Pine then.", expected_status: "fact", expected_fact: fact("production", "host", "River", "2026-03-01", null, "s1") },
    ],
    questions: [
      question("s-q1", "What hosts production on February 15, 2026, using information known by March 15, 2026?", "production", "host", "2026-02-15", "2026-03-15", ["Pine"], ["s1"]),
      question("s-q2", "Where is production hosted on March 15, 2026, according to what was known by that same date?", "production", "host", "2026-03-15", "2026-03-15", ["River"], ["s2"]),
      question("s-q3", "Using only information known by January 4, 2026, what host applies to production on March 1, 2026?", "production", "host", "2026-03-01", "2026-01-04", ["Pine"], ["s1"]),
    ],
  },
  {
    id: "corrected", repo: "probe/corrected",
    sources: [
      { event_id: "c1", observed_at: "2026-01-03", text: "Mara is the releases owner, effective January 1, 2026.", expected_status: "fact", expected_fact: fact("releases", "owner", "Mara", "2026-01-01") },
      { event_id: "c2", observed_at: "2026-04-10", text: "Correction to the earlier assignment: Noel became releases owner on February 1, 2026. The Mara entry was superseded from then.", expected_status: "fact", expected_fact: fact("releases", "owner", "Noel", "2026-02-01", null, "c1") },
    ],
    questions: [
      question("c-q1", "Who owned releases on March 1, 2026, if we use only what was known by March 20, 2026?", "releases", "owner", "2026-03-01", "2026-03-20", ["Mara"], ["c1"]),
      question("c-q2", "With information available by April 15, 2026, who was releases owner on March 1, 2026?", "releases", "owner", "2026-03-01", "2026-04-15", ["Noel"], ["c2"]),
      question("c-q3", "Who was releases owner on January 15, 2026, based on records known by April 15, 2026?", "releases", "owner", "2026-01-15", "2026-04-15", ["Mara"], ["c1"]),
    ],
  },
  {
    id: "gap", repo: "probe/gap",
    sources: [
      { event_id: "g1", observed_at: "2026-01-01", text: "Backups retain data for two weeks from January 1, 2026 until February 1, 2026, excluding February 1. This statement does not establish retention after that interval.", expected_status: "fact", expected_fact: fact("backups", "retention_days", "14", "2026-01-01", "2026-02-01") },
      { event_id: "g2", observed_at: "2026-02-15", text: "Backups retain data for thirty days, starting February 15, 2026.", expected_status: "fact", expected_fact: fact("backups", "retention_days", "30", "2026-02-15") },
    ],
    questions: [
      question("g-q1", "How many days were backups retained on January 20, 2026, using records known by March 15, 2026?", "backups", "retention_days", "2026-01-20", "2026-03-15", ["14"], ["g1"]),
      question("g-q2", "What backup retention in days is supported for February 10, 2026, using information known by March 15, 2026?", "backups", "retention_days", "2026-02-10", "2026-03-15", [], []),
      question("g-q3", "As of March 1, 2026, how many days do backups retain data, using what was known by March 15, 2026?", "backups", "retention_days", "2026-03-01", "2026-03-15", ["30"], ["g2"]),
    ],
  },
  {
    id: "disputed", repo: "probe/disputed",
    sources: [
      { event_id: "d1", observed_at: "2026-06-01", text: "Production is hosted on Slate from June 1, 2026.", expected_status: "fact", expected_fact: fact("production", "host", "Slate", "2026-06-01") },
      { event_id: "d2", observed_at: "2026-06-02", text: "An independent incident report says Harbor has hosted production since June 1, 2026. This is an unresolved conflicting report, not a confirmed replacement of the Slate record.", expected_status: "fact", expected_fact: fact("production", "host", "Harbor", "2026-06-01") },
    ],
    questions: [
      question("d-q1", "What host applies to production on June 10, 2026, using only what was known by June 1, 2026?", "production", "host", "2026-06-10", "2026-06-01", ["Slate"], ["d1"]),
      question("d-q2", "Which production host values are supported for June 10, 2026, based on reports known by June 3, 2026? Preserve any unresolved conflict.", "production", "host", "2026-06-10", "2026-06-03", ["Slate", "Harbor"], ["d1", "d2"], true),
    ],
  },
  {
    id: "ephemeral", repo: "probe/ephemeral",
    sources: [
      { event_id: "e1", observed_at: "2026-02-01", text: "Leni has been the releases owner since January 1, 2026.", expected_status: "fact", expected_fact: fact("releases", "owner", "Leni", "2026-01-01") },
      { event_id: "e2", observed_at: "2026-02-02", text: "For this dry run only, pretend the releases owner is Ardi.", expected_status: "ignore" },
      { event_id: "e3", observed_at: "2026-02-03", text: "The example 'owner=Oren' comes from dummy configuration; it is not our real releases assignment.", expected_status: "ignore" },
    ],
    questions: [
      question("e-q1", "Who owns releases on February 10, 2026, using information known by February 10, 2026?", "releases", "owner", "2026-02-10", "2026-02-10", ["Leni"], ["e1"]),
      question("e-q2", "Who was releases owner on January 20, 2026, using what was known by February 10, 2026?", "releases", "owner", "2026-01-20", "2026-02-10", ["Leni"], ["e1"]),
    ],
  },
  {
    id: "unsupported", repo: "probe/unsupported",
    sources: [
      { event_id: "u1", observed_at: "2026-01-01", text: "Production serves two active regions, East and West, at the same time.", expected_status: "unsupported" },
    ],
    questions: [
      question("u-q1", "What host is supported for production on January 15, 2026, using records known by January 15, 2026?", "production", "host", "2026-01-15", "2026-01-15", [], []),
    ],
  },
  {
    id: "relative", repo: "probe/relative",
    sources: [
      { event_id: "r1", observed_at: "2026-08-01", text: "Production has run on Birch since August 1, 2026.", expected_status: "fact", expected_fact: fact("production", "host", "Birch", "2026-08-01") },
      { event_id: "r2", observed_at: "2026-08-20", text: "We replaced Birch with Cedar as production's host last Monday.", expected_status: "fact", expected_fact: fact("production", "host", "Cedar", "2026-08-17", null, "r1") },
    ],
    questions: [
      question("r-q1", "What hosted production on August 16, 2026, according to information known by August 21, 2026?", "production", "host", "2026-08-16", "2026-08-21", ["Birch"], ["r1"]),
      question("r-q2", "Using only what was known by August 19, 2026, what host applies to production on August 18, 2026?", "production", "host", "2026-08-18", "2026-08-19", ["Birch"], ["r1"]),
      question("r-q3", "What hosts production on August 18, 2026, using what was known by August 21, 2026?", "production", "host", "2026-08-18", "2026-08-21", ["Cedar"], ["r2"]),
    ],
  },
  {
    id: "denied", repo: "probe/denied",
    sources: [
      { event_id: "n1", observed_at: "2026-09-01", text: "Production has used Orchard for hosting since September 1, 2026.", expected_status: "fact", expected_fact: fact("production", "host", "Orchard", "2026-09-01") },
      { event_id: "n2", observed_at: "2026-09-05", text: "An example migration note says production moved to Willow on September 3. That note is false: no migration took place. It is not a new deployment record.", expected_status: "ignore" },
    ],
    questions: [
      question("n-q1", "What hosts production on September 6, 2026, using records known by September 6, 2026?", "production", "host", "2026-09-06", "2026-09-06", ["Orchard"], ["n1"]),
      question("n-q2", "Which host is supported for production on August 20, 2026, using records known by September 6, 2026?", "production", "host", "2026-08-20", "2026-09-06", [], []),
    ],
  },
];
