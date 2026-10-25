# LongMemEval minimal-policy supplemental candidate, 21 October 2026

## Candidate and selection disclosure

This candidate runs `benchmark/longmemeval-qa.ts` with supplemental top-20
evidence, the system History contract plus `MINIMAL_ANSWER_POLICY`
(`--answer-policy minimal`), adaptive Qwen reasoning, a 16,384-token answer
limit, robust transport and the unchanged none/4,096 judge.

It was selected after the [minimal-answer trial](LONGMEMEVAL-MINIMAL-ANSWER-PROTOCOL.md)
comparison arm scored 59/60 with all seven original cases correct. That
trial rejected the policy's token-saving and grounding claims; this protocol
makes neither claim. It tests only whether the configuration passes the
original benchmark gates. The development result was seen before selection,
so development is repeated fresh, and later cohorts decide advancement.

Offline checks before any call confirmed that the runner rebuilds all 60
development contexts byte for byte (60/60 context hashes), all 60 answer
prompts (60/60) and the trial's combined instruction hash `c14ff38d…`.
Follow-up100 renders 20 lexical sources for all 100 questions; full500
renders 20 exact E5 sources for all 500 questions.

## Serial gates

1. Fresh development60 on the protected extended rankings: at least
   **58/60 and all seven original cases**.
2. Only after that pass, the locked lexical follow-up100 with top-20 lexical
   retrieval: at least **93/100 and 14/16 unanswerable**.
3. Only after that pass, all500 on the exact fresh E5 top-20 rankings: at
   least **457/500, 27/30 unanswerable, 25/30 preferences and all seven
   original cases**.

A failed gate stops later stages. Failures and timeouts count as incorrect.
No selective retries, answer repair, rejudging, reference changes, gate
relaxation or tuning from follow-up or full-corpus outcomes is permitted.
Repeated public development data cannot establish generalization.

## Commands

All stages run from a frozen source copy under Node 22 with private pinned
dependencies, through `dgx run`, with fresh output paths:

```sh
dgx run -- node --import tsx benchmark/longmemeval-qa.ts \
  --input benchmark/data/longmemeval-amb-input-2026-10-19.json \
  --retrieval cached \
  --rankings benchmark/data/longmemeval-supplemental-development60-extended-rankings-2026-10-20.json \
  --top-k 20 --context-chars 180000 --evidence supplemental \
  --evidence-policy system --answer-policy minimal --provider qwen-local \
  --request-mode robust --reasoning-effort adaptive --max-output-tokens 16384 \
  --answer-check none --concurrency 3 --out benchmark/data/NEW.json
```

Follow-up100 replaces the input with
`longmemeval-adaptive-followup100-input-2026-10-20.json` and uses
`--retrieval lexical` without rankings. Full500 uses the AMB input with
`--rankings benchmark/data/longmemeval-fresh-e5-full500-exact-2026-10-20.json`.

## Results

| Stage | Result | Gate | Outcome |
| --- | ---: | --- | --- |
| Development60 | **58/60**, 7/7 original, 0 errors | 58/60, 7/7 | Pass |
| Follow-up100 | **94/100**, 12/16 unanswerable, 1 error | 93/100, 14/16 | Fail |
| Full500 | Not started | 457/500, 27/30, 25/30, 7/7 | Not run |

Answerable follow-up accuracy was 82/84, above the recorded fixed-high
control's 93/100 overall. Unanswerable accuracy fell to 12/16 against the
control's 14/16. Three unanswerable misses (`a96c20ee_abs`, `09ba9854_abs`,
`gpt4_70e84552_abs`) answered a nearby question instead of rejecting the
false premise; `edced276_abs` exhausted its output budget. The minimal
policy does not target false-premise abstention, so the candidate stops here.
The decision record
binds the freeze, source archive and both reports.
