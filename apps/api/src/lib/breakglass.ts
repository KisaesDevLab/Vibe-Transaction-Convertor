// Vibe Auth (ADR-027): the dotted placeholder address the break-glass
// account is stored under. A leaf module so services/auth.ts can refuse to
// manage that account without importing lib/vibe-auth-users.ts, which
// itself imports services/auth.ts.
export const BREAKGLASS_EMAIL = 'vibe-breakglass@vibe-tx-converter.local';
