# ADR-011 — PolyForm Internal Use 1.0.0, no runtime enforcement

## Status

Accepted.

## Context

The Vibe family historically shipped a license-portal integration
(`kisaes-license-portal`) that gated runtime behavior on a JWT issued by a
central server. Operators routinely complained that license check-ins
failed during outages, that air-gapped installs were second-class, and
that the JWT path forced an outbound call which conflicted with our zero-
egress posture (BuildPlan.md §0 invariants). For this product, we are
explicitly stepping out of that pattern.

## Decision

The product is licensed under **PolyForm Internal Use 1.0.0** and that
license is enforced **only at the source level** — copy of the LICENSE
file in the repo, NOTICE for third-party attribution, and nothing else.
There is **no runtime enforcement**:

- No JWT validation at boot.
- No phone-home to a license server.
- No Stripe / billing integration.
- No `kisaes-license-portal` code path at all.
- No feature flags keyed on license tier.

If a customer is out of compliance, that is a contract / sales
conversation, not something the running container can or should resolve.

## Consequences

- **Pro:** Air-gapped, zero-egress installs are first-class.
- **Pro:** Boot path is simpler and faster — one less external dependency.
- **Pro:** No silent feature gating, fewer support tickets.
- **Con:** Misuse is harder to detect. We accept this risk for the product's
  target market (internal accounting use within firms that have signed an
  internal-use license).
- **Con:** Future tier differentiation, if it ever lands, will need a fresh
  enforcement mechanism — but this ADR makes it an explicit design choice
  rather than an accidental gap.

## References

- `LICENSE`
- `NOTICE`
- BuildPlan.md §3 ADR-011, §0 invariants.
