# Historical documents

Superseded material, kept for context. **Do not treat anything here as current.**

## The cross-repo handoff docs (2026-08-15)

`fridgie-api` and `fridgie` used to be separate GitHub repositories. Agents
working on one could not see the other, so they coordinated by writing markdown
at each other:

| File | Direction |
|---|---|
| `2026-08-15-backend-handoff.md` | frontend → backend |
| `2026-08-15-frontend-handoff.md` | backend → frontend |
| `2026-08-15-alignment-check.md` | frontend's checklist of what to verify |

That protocol did not work. A review after the repos were merged found 41
confirmed defects at the seam, including two independently written `quantity.ts`
implementations that disagreed on plurals, unit aliases and rounding; two
`rank.ts` implementations that repaired invalid ranks differently and so
produced conflicting list orderings; and a complete `rev`-based concurrency
protocol built server-side that the client never called.

Those are fixed, and the class of problem is designed out: the contract and the
shared logic now live in `packages/shared`, so there is one implementation
rather than two descriptions of one.

The specific claims in these files are stale — they describe code that has since
changed. They are worth reading only as a record of what the two sides believed
about each other.
