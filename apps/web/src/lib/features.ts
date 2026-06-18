// Feature keys mirrored from the API registry (apps/api/src/lib/
// feature-registry.ts). Keep keys in sync with that file — labels and
// descriptions for the management UI come from the API at runtime, so
// only the keys live here (for nav/route gating).
//
// Access is default-on: a feature is treated as enabled unless the me
// feature map explicitly carries `false`. See hasFeature() in useAuth.ts.
export const FEATURE = {
  companies: 'companies',
  statements: 'statements',
  uploads: 'uploads',
  reextract: 'reextract',
  enrich: 'enrich',
  checkResolve: 'checkResolve',
  exports: 'exports',
  addTransactions: 'addTransactions',
  deleteTransactions: 'deleteTransactions',
  overrideVariance: 'overrideVariance',
  adminHome: 'admin.home',
  adminUsers: 'admin.users',
  adminAccessControl: 'admin.accessControl',
  adminLlmProvider: 'admin.llmProvider',
  adminAudit: 'admin.audit',
  adminDiagnostics: 'admin.diagnostics',
  adminMaintenance: 'admin.maintenance',
  adminEngines: 'admin.engines',
  adminBackup: 'admin.backup',
  adminCategories: 'admin.categories',
  adminEnrichmentPrompt: 'admin.enrichmentPrompt',
} as const;

export type FeatureKey = (typeof FEATURE)[keyof typeof FEATURE];
