# LongMemEval separate premise-check candidate, 22 October 2026

## Candidate

This candidate runs `benchmark/longmemeval-qa.ts` with supplemental top-20
evidence, `--answer-policy minimal`, adaptive Qwen reasoning, a 16,384-token
answer limit, robust transport and the unchanged none/4,096 judge. It adds
`--answer-check premise`: after each successful answer, one low-reasoning call
sees only the question, clock and the same evidence, never the draft or any
reference. Only an explicit `false` verdict replaces the answer with a fixed
"not recorded" statement plus the checker's reason. Check failures or
malformed output keep the draft. The answer prompt itself is unchanged.

The check wording is version 4 (`benchmark/longmemeval-premise-check.ts`,
SHA-256 `31cd42cae005bc666b6d306265a1f10675a7b758025fefba2415625d4274ee71`).

## Selection disclosure

The check was developed on development60, validation100 and 14 synthetic
false-premise probes built from development questions. Validation100 and all
30 unanswerable cases also belong to full500. The motivating failure pattern
was first seen in the 457/500 full run and in the failed minimal-policy
follow-up100; those outcomes were not used to choose wording.

| Version | Synthetic | Development60 | Validation100 |
| --- | ---: | --- | --- |
| v2 | 14/14 | 55/60, 0 overrides | 91/100, 14/14 unanswerable, 2 wrong overrides |
| v3 | 14/14 | 54/60, wrong override on `dd2973ad` | 92/100, 14/14, 1 wrong override |
| v4 | 14/14 | 55/60, 0 overrides | 92/100, 14/14, 1 wrong override |

Versions 3 and 4 were measured by replaying only the check on saved v2
answers and evidence. Development60 misses were all answer-side: three
600-second timeouts during a slow-server period, the disputed model-kit count
and the variable preference case. The
selection record
binds every replay.

## Serial gates

1. Fresh development60 on the protected extended rankings: at least
   **58/60 and all seven original cases**.
2. Only after that pass, the locked lexical follow-up100: at least
   **93/100 and 14/16 unanswerable**.
3. Only after that pass, all500 on the exact fresh E5 top-20 rankings: at
   least **457/500, 27/30 unanswerable, 25/30 preferences and all seven
   original cases**.

A failed gate stops later stages. Failures and timeouts count as incorrect.
No selective retries, answer repair, rejudging, reference changes, gate
relaxation or tuning from follow-up or full-corpus outcomes is permitted.

## Runtime

Homebrew replaced `node@22` on 21 October. Runs use a read-only copy of a
v22.23.4 binary (ABI 127, matching the private dependencies) instead of the
previously pinned v22.23.3. All stages run through `dgx run` from a frozen
read-only source copy, under one supervisor that records each gate verdict.

## Results

| Stage | Result | Gate | Outcome |
| --- | ---: | --- | --- |
| Development60 | **57/60**, 7/7 original, 0 overrides, 1 error | 58/60, 7/7 | Fail |
| Follow-up100 | Not started | 93/100, 14/16 | Not run |
| Full500 | Not started | 457/500, 27/30, 25/30, 7/7 | Not run |

The check made no overrides on development60, and all seven original cases
passed. The three misses all came from the answer call: the disputed
model-kit count (`gpt4_59c863d7`), a slow-cooker preference answer
(`caf03d32`), and `f523d9fe`, whose low-reasoning answer used the whole
16,384-token output budget without finishing. The
decision record
binds the supervisor, state, report and frozen source.
