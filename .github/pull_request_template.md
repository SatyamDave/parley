## What this changes

## Why

If this fixes something that was silently wrong, say what the silent failure
looked like — that sentence is usually the most valuable part of the diff, and
it belongs in the code as a comment too.

## Verification

```
npm test
```

Paste the real result. Not "tests pass" — the count, and the failures if any.
This project's whole thesis is that an agent's word is not evidence; the same
applies to a person's.

- [ ] `npm test` run locally, output pasted above
- [ ] No new dependency (or: justified in the description, with the `node:`
      builtin I tried first)
- [ ] No build step introduced
- [ ] Any prompt sent to a model goes via stdin, not argv
- [ ] If this touches `src/map/*`: no model call originates structure
- [ ] If this closes a README *Known limits* entry, that entry is deleted
