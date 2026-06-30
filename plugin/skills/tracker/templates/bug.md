# Bug: <short symptom>

## Repro

Numbered, deterministic steps. Anyone reading this should be able to hit the
bug in under a minute on a clean checkout.

1. ...
2. ...
3. Observe: <what goes wrong>

## Expected

What you expected to happen, in one sentence.

## Actual

What actually happens. Include the exact error text, log line, or observable
signal — not a paraphrase.

```text
<paste the real output here>
```

## Environment

Anything that distinguishes your setup from a clean default. Skip rows that
don't matter.

| What | Value |
|------|-------|
| OS | |
| runtime / version | |
| commit / build | |
| config flag | |

## Suspected cause

Your best current hypothesis for *why* this happens. Name the component and
the mechanism if you can — "X doesn't account for Y when Z". If you have no
hypothesis, say so and stop — don't dress up a guess as a fix.

## Fix

The proposed change, or a pointer to the branch / commit that carries it.
If the fix is non-obvious, one line on why it's the right shape.

> [!WARNING]
> If the fix only papers over the symptom, say so here. A bug that
> regresses twice is worse than one that stayed open.

## Open questions

1. ...
2. ...