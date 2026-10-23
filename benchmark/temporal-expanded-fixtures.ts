import type { TemporalQuestion, TemporalSourceEvent } from "./temporal-fixtures.js";

export interface ExpandedQuestion extends TemporalQuestion {
  readonly world_id: string;
  readonly stratum: "clean" | "noise";
}

export interface ExpandedDataset {
  readonly version: string;
  readonly seed: number;
  readonly events: readonly TemporalSourceEvent[];
  readonly questions: readonly ExpandedQuestion[];
}

type Stratum = ExpandedQuestion["stratum"];
type World = { readonly id: string; readonly repo: string; readonly stratum: Stratum; readonly name: string; readonly start: number };
type Build = (world: World, random: Random) => { events: TemporalSourceEvent[]; questions: ExpandedQuestion[] };

const SERVICES = ["harbor", "lantern", "orchard", "quartz", "tandem", "willow", "cinder", "meadow"];
const PROPERTIES = ["release channel", "default editor", "storage class", "support tier", "sync mode", "approval route"];
const VALUES = ["amber", "birch", "cobalt", "dune", "ember", "fjord", "grove", "helium"];
const TEMPLATES: ReadonlyArray<readonly [string, Build]> = [
  ["future-schedule", scheduled],
  ["late-correction", correction],
  ["exclusive-interval", interval],
  ["expired-successor", expiredSuccessor],
  ["independent-conflict", conflict],
  ["replacement-chain", chain],
  ["out-of-order", outOfOrder],
  ["static-preference", preference],
  ["repo-isolation", isolation],
  ["unknown-gap", unknown],
];

/** Generates only synthetic, hand-authored temporal capability fixtures. */
export function generateExpandedDataset(seed = 20261018, worldsPerTemplate = 4): ExpandedDataset {
  if (!Number.isInteger(worldsPerTemplate) || worldsPerTemplate < 1) throw new Error("worldsPerTemplate must be a positive integer");
  const random = new Random(seed);
  const events: TemporalSourceEvent[] = [];
  const questions: ExpandedQuestion[] = [];
  for (const [template, build] of TEMPLATES) {
    for (let variant = 0; variant < worldsPerTemplate; variant++) {
      const stratum: Stratum = variant % 2 === 0 ? "clean" : "noise";
      const name = `${random.pick(SERVICES)}-${random.pick(SERVICES)}-${variant + 1}`;
      const world: World = {
        id: `${template}-${variant + 1}`,
        repo: `synthetic/${template}-${name}`,
        stratum,
        name,
        start: random.int(0, 120),
      };
      const built = build(world, random);
      events.push(...built.events);
      questions.push(...built.questions);
      if (stratum === "noise") {
        events.push(...noise(world, random));
        if (template === "repo-isolation") events.push(...noise({ ...world, repo: `${world.repo}-mirror` }, random));
      }
    }
  }
  return { version: "temporal-expanded-v1", seed, events, questions };
}

function scheduled(world: World, random: Random) {
  const [before, after] = pair(random);
  const predicate = random.pick(PROPERTIES);
  const old = event(world, "record-a", predicate, before, 0, 0, `The ${predicate} for ${world.name} was ${before} from ${date(world.start)}.`);
  const next = event(world, "record-b", predicate, after, 35, 5, `On ${date(world.start + 5)}, the schedule set ${world.name}'s ${predicate} to ${after} effective ${date(world.start + 35)}, replacing record-a.`, { supersedes_event_id: old.event_id });
  return make(world, "future scheduled change", [old, next], [
    question(world, "before", predicate, world.start + 20, world.start + 10, [before], [old.event_id], `Before the scheduled date, what ${predicate} applied to ${world.name} in ${world.repo}?`),
    question(world, "after", predicate, world.start + 45, world.start + 10, [after], [next.event_id], `After the planned change, which ${predicate} is effective for ${world.name} in ${world.repo}?`),
  ]);
}

function correction(world: World, random: Random) {
  const [before, after] = pair(random);
  const predicate = random.pick(PROPERTIES);
  const old = event(world, "record-a", predicate, before, 0, 0, `The ${predicate} for ${world.name} began as ${before} on ${date(world.start)}.`);
  const fixed = event(world, "record-b", predicate, after, 10, 35, `On ${date(world.start + 35)} we corrected ${world.name}'s ${predicate}: it became ${after} effective ${date(world.start + 10)}, replacing record-a.`, { supersedes_event_id: old.event_id });
  return make(world, "late observed correction", [old, fixed], [
    question(world, "before-knowledge", predicate, world.start + 20, world.start + 25, [before], [old.event_id], `Using the earlier knowledge cutoff, what ${predicate} was known for ${world.name} in ${world.repo}?`),
    question(world, "after-knowledge", predicate, world.start + 20, world.start + 40, [after], [fixed.event_id], `After the correction was observed, what ${predicate} applied to ${world.name} in ${world.repo}?`),
  ]);
}

function interval(world: World, random: Random) {
  const predicate = random.pick(PROPERTIES);
  const value = random.pick(VALUES);
  const end = offsetDate(world.start + 10);
  const active = event(world, "record-a", predicate, value, 0, 0, `${world.name}'s ${predicate} was ${value} from ${date(world.start)} until ${end} (exclusive).`, { valid_to: `${end}T01:00:00+01:00` });
  return make(world, "exclusive finite interval", [active], [
    question(world, "before-end", predicate, world.start + 9, world.start + 11, [value], [active.event_id], `Immediately before the exclusive end, what ${predicate} did ${world.name} have in ${world.repo}?`),
    question(world, "at-end", predicate, world.start + 10, world.start + 11, [], [], `At the explicit end boundary, what ${predicate} is supported for ${world.name} in ${world.repo}?`),
  ]);
}

function expiredSuccessor(world: World, random: Random) {
  const [before, after] = pair(random);
  const predicate = random.pick(PROPERTIES);
  const old = event(world, "record-a", predicate, before, 0, 0, `${world.name} used ${before} for ${predicate} from ${date(world.start)}.`);
  const next = event(world, "record-b", predicate, after, 20, 21, `${world.name}'s ${predicate} changed from ${before} to ${after} on ${date(world.start + 20)} and ended ${date(world.start + 30)}, replacing record-a.`, { valid_to: date(world.start + 30), supersedes_event_id: old.event_id });
  return make(world, "expired successor", [old, next], [
    question(world, "during", predicate, world.start + 25, world.start + 32, [after], [next.event_id], `During the successor window, which ${predicate} applied to ${world.name} in ${world.repo}?`),
    question(world, "after-expiry", predicate, world.start + 35, world.start + 36, [], [], `After that successor expired, what ${predicate} is supported for ${world.name} in ${world.repo}?`),
  ]);
}

function conflict(world: World, random: Random) {
  const [first, second] = pair(random);
  const predicate = random.pick(PROPERTIES);
  const a = event(world, "record-a", predicate, first, 0, 0, `The first ${world.name} report says ${predicate} was ${first} from ${date(world.start)}.`);
  const b = event(world, "record-b", predicate, second, 0, 3, `A separate report says ${world.name}'s ${predicate} was ${second} from ${date(world.start)}; it does not replace record-a.`);
  return make(world, "independent conflicting reports", [a, b], [
    question(world, "first-report", predicate, world.start + 10, world.start + 2, [first], [a.event_id], `Before the second report, what ${predicate} was available for ${world.name} in ${world.repo}?`),
    question(world, "both-reports", predicate, world.start + 10, world.start + 4, [first, second], [a.event_id, b.event_id], `For repository ${world.repo}, what ${predicate} applied to ${world.name}?`, true),
  ]);
}

function chain(world: World, random: Random) {
  const [first, middle, last] = triple(random);
  const predicate = random.pick(PROPERTIES);
  const a = event(world, "record-a", predicate, first, 0, 0, `${world.name} began with ${predicate} ${first} on ${date(world.start)}.`);
  const b = event(world, "record-b", predicate, middle, 10, 11, `${world.name}'s ${predicate} changed from ${first} to ${middle} effective ${date(world.start + 10)}, replacing record-a.`, { supersedes_event_id: a.event_id });
  const c = event(world, "record-c", predicate, last, 20, 21, `${world.name}'s ${predicate} changed from ${middle} to ${last} effective ${date(world.start + 20)}, replacing record-b.`, { supersedes_event_id: b.event_id });
  return make(world, "three-step replacement chain", [a, b, c], [
    question(world, "middle-history", predicate, world.start + 15, world.start + 25, [middle], [b.event_id], `Historically at ${date(world.start + 15)}, what ${predicate} applied to ${world.name} in ${world.repo}?`),
    question(world, "current", predicate, world.start + 25, world.start + 25, [last], [c.event_id], `At the current point in this record, what ${predicate} applies to ${world.name} in ${world.repo}?`),
  ]);
}

function outOfOrder(world: World, random: Random) {
  const [first, second] = pair(random);
  const predicate = random.pick(PROPERTIES);
  const later = event(world, "record-b", predicate, second, 20, 22, `${world.name}'s ${predicate} was ${second} from ${date(world.start + 20)}.`);
  const earlier = event(world, "record-a", predicate, first, 0, 35, `An imported record says ${world.name}'s ${predicate} was ${first} from ${date(world.start)} until ${date(world.start + 20)} (exclusive).`, { valid_to: date(world.start + 20) });
  return make(world, "out-of-order nonoverlapping intervals", [later, earlier], [
    question(world, "historical", predicate, world.start + 10, world.start + 40, [first], [earlier.event_id], `After the late import, what historical ${predicate} applied to ${world.name} in ${world.repo}?`),
    question(world, "current", predicate, world.start + 25, world.start + 40, [second], [later.event_id], `What current ${predicate} applied to ${world.name} in ${world.repo}?`),
  ]);
}

function preference(world: World, random: Random) {
  const predicate = "default editor";
  const value = random.pick(VALUES);
  const assertion = event(world, "record-a", predicate, value, 0, 0, `${world.name}'s saved ${predicate} was ${value} from ${date(world.start)}.`);
  return make(world, "static preference control", [assertion], [
    question(world, "first-date", predicate, world.start + 5, world.start + 5, [value], [assertion.event_id], `For repository ${world.repo}, what saved ${predicate} applied to ${world.name}?`),
    question(world, "second-date", predicate, world.start + 20, world.start + 20, [value], [assertion.event_id], `For repository ${world.repo}, what saved ${predicate} applied to ${world.name}?`),
  ]);
}

function isolation(world: World, random: Random) {
  const predicate = random.pick(PROPERTIES);
  const [leftValue, rightValue] = pair(random);
  const left = event(world, "shared-record", predicate, leftValue, 0, 0, `In ${world.repo}, ${world.name}'s ${predicate} was ${leftValue} from ${date(world.start)}.`);
  const otherRepo = `${world.repo}-mirror`;
  const right: TemporalSourceEvent = { ...event({ ...world, repo: otherRepo }, "shared-record", predicate, rightValue, 0, 0, `In ${otherRepo}, ${world.name}'s ${predicate} was ${rightValue} from ${date(world.start)}.`), event_id: left.event_id };
  return make(world, "repo isolation", [left, right], [
      question(world, "left", predicate, world.start + 5, world.start + 5, [leftValue], [left.event_id], `For repository ${world.repo}, what ${predicate} applied to ${world.name}?`),
      question({ ...world, repo: otherRepo }, "right", predicate, world.start + 5, world.start + 5, [rightValue], [right.event_id], `For repository ${otherRepo}, what ${predicate} applied to ${world.name}?`),
  ]);
}

function unknown(world: World, random: Random) {
  const predicate = random.pick(PROPERTIES);
  const knownValue = random.pick(VALUES);
  const known = event(world, "record-a", predicate, knownValue, 10, 10, `The first source for ${world.name}'s ${predicate} says it was ${knownValue} on ${date(world.start + 10)}.`);
  const missingPredicate = PROPERTIES.find((property) => property !== predicate)!;
  const missingSubject = `${world.name} satellite`;
  return make(world, "unknown and gap", [known], [
    question(world, "before-first", predicate, world.start + 5, world.start + 20, [], [], `For repository ${world.repo}, what ${predicate} applied to ${world.name}?`),
    question(world, "missing-property", missingPredicate, world.start + 20, world.start + 20, [], [], `For repository ${world.repo}, what ${missingPredicate} applied to ${missingSubject}?`, false, missingSubject),
  ]);
}

function make(world: World, category: string, events: TemporalSourceEvent[], questions: ExpandedQuestion[]) { return { events, questions: questions.map((item) => ({ ...item, category })) }; }
function event(world: World, suffix: string, predicate: string, value: string, validOffset: number, observedOffset: number, evidence: string, extra: Partial<TemporalSourceEvent> = {}): TemporalSourceEvent {
  return { event_id: `${world.id}-${suffix}`, repo: world.repo, subject: world.name, predicate, value, valid_from: date(world.start + validOffset), observed_at: date(world.start + observedOffset), evidence, confidence: 0.4 + ((world.start + validOffset + observedOffset) % 6) / 10, ...extra };
}
function question(world: World, suffix: string, predicate: string, asOffset: number, observedOffset: number, expected_values: string[], expected_event_ids: string[], wording: string, expected_conflict = false, subject = world.name): ExpandedQuestion {
  return { id: `${world.id}-${suffix}`, world_id: world.id, stratum: world.stratum, category: "", repo: world.repo, subject, predicate, as_of: date(asOffset), observed_before: date(observedOffset), question: `${wording} Explicit as_of: ${date(asOffset)}; observed_before: ${date(observedOffset)}.`, expected_values: [...expected_values].sort(), expected_event_ids: [...expected_event_ids].sort(), expected_conflict };
}
function noise(world: World, random: Random): TemporalSourceEvent[] {
  return Array.from({ length: 10 }, (_, index) => {
    const subject = `incidental ${random.pick(SERVICES)} ${index + 1}`;
    const predicate = `incidental ${random.pick(PROPERTIES)}`;
    const value = random.pick(VALUES);
    return event({ ...world, name: subject }, `context-${index + 1}`, predicate, value, index, index, `A routine note records ${subject}'s ${predicate} as ${value} from ${date(world.start + index)}.`);
  });
}
function pair(random: Random): [string, string] { const first = random.pick(VALUES); let second = random.pick(VALUES); while (second === first) second = random.pick(VALUES); return [first, second]; }
function triple(random: Random): [string, string, string] { const values = new Set<string>(); while (values.size < 3) values.add(random.pick(VALUES)); return [...values] as [string, string, string]; }
function date(offset: number): string { return offsetDate(offset); }
function offsetDate(offset: number): string { const value = new Date(Date.UTC(2027, 0, 1 + offset)); return value.toISOString().slice(0, 10); }
class Random { private state: number; constructor(seed: number) { this.state = seed >>> 0; } next() { this.state = (this.state + 0x6d2b79f5) | 0; let value = Math.imul(this.state ^ this.state >>> 15, 1 | this.state); value ^= value + Math.imul(value ^ value >>> 7, 61 | value); return ((value ^ value >>> 14) >>> 0) / 4294967296; } int(min: number, max: number) { return min + Math.floor(this.next() * (max - min + 1)); } pick<T>(items: readonly T[]): T { return items[this.int(0, items.length - 1)]!; } }
