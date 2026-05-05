# Open Questions Log

Questions Claude could not resolve from `BuildPlan.md` or prior conversation
turns while building. Each entry: **what was asked**, **what assumption I
made to keep going**, and **what to revisit**. Resolve by editing the
relevant code/doc, then strike through the entry.

Format:

```
### Q-NNN — short title (Phase X, item Y) — yyyy-mm-dd
**Question:** ...
**Assumption made:** ...
**Where to revisit:** file:line / acceptance step / ADR-NNN
```

---

### Q-001 — drizzle-kit 0.24.2 silently drops `check()` constraints (Phase 3, item 27) — 2026-05-04

**Question:** With drizzle-orm 0.33.0 + drizzle-kit 0.24.2, table-level
`check('name', sql\`expr\`)`constraints inside the`(t) => ({ ... })`callback
are accepted at typecheck time but never appear in the generated migration
SQL or the snapshot. The schema.ts still declares them, but`db:generate`emits zero`ALTER TABLE ... ADD CONSTRAINT` statements.

**Assumption made:** Wrote the four CHECK constraints
(`accounts_currency_usd_only`, `accounts_credit_card_no_routing`,
`transactions_amount_nonzero`, `system_settings_secret_xor_plaintext`) as a
manual SQL migration `0003_check_constraints.sql`. Live smoke test confirms
they fire (CC-with-routing insert is rejected; system_settings xor insert is
rejected).

**Where to revisit:** Bumping drizzle-kit (0.25+ may fix), or migrating to
`pgPolicy`/`@drizzle/pgvector`-style constraint declarations. The `check`
imports in `apps/api/src/db/schema.ts` are kept for future kit upgrades to
re-detect them; if a future generator emits duplicates, drop the manual
migration.

### Q-002 — Authoritative Intuit FIDIR format + source URL (Phase 5, items 1-2) — 2026-05-04

**Question:** BuildPlan.md item 1 says "Document the canonical Intuit FIDIR
URL". The plan does not commit to one. Public mirrors of `fidir.txt` use at
least three different formats (flat key=value, INI-style sections,
JSON-with-headers) and the canonical Intuit URL has moved at least twice.
Without an authoritative source, the parser format I picked
(`KEY=value` lines, blank-line-separated records) is a documented choice
rather than Intuit's choice.

**Assumption made:** Vendored `data/fidir/fidir-us.txt` as a 127-record
**starter set** of major US banks/credit unions in the parser's expected
format. Documented this loud and clear in `data/fidir/README.md`. Wired
the seeder defensive cap (refuse < 100 entries) so a half-imported file
doesn't ship.

**Where to revisit:** Operator must confirm Intuit's authoritative URL
and format before production. If Intuit's format diverges from the
parser-friendly form, write a one-shot converter at
`apps/api/src/scripts/fidir-convert.ts`. Mirror cadence: quarterly per
plan.
