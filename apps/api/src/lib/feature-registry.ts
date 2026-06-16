// Canonical catalog of per-user gateable features. Single source of
// truth for: the requireFeature() middleware, the management API, the
// /api/auth/me feature map, and (mirrored by key) the SPA.
//
// Semantics: access defaults to ENABLED. A user is denied a feature only
// when an explicit user_feature_access row sets enabled = false. New
// features added here are therefore on-by-default for every existing
// user with no migration backfill needed.

export type FeatureArea = 'core' | 'admin';

export interface FeatureDef {
  key: string;
  label: string;
  area: FeatureArea;
  description: string;
}

export const FEATURE_DEFS: readonly FeatureDef[] = [
  // ----- core (staff-facing) -----
  {
    key: 'companies',
    label: 'Companies & Accounts',
    area: 'core',
    description: 'View and manage companies and their bank/credit-card accounts.',
  },
  {
    key: 'statements',
    label: 'View & Review Statements',
    area: 'core',
    description: 'Browse statements and open the review grid. Required to reach exports.',
  },
  {
    key: 'uploads',
    label: 'Upload PDFs',
    area: 'core',
    description: 'Upload statement PDFs to an account to start the extraction pipeline.',
  },
  {
    key: 'reextract',
    label: 'Re-extract / Reprocess',
    area: 'core',
    description: 'Re-run extraction on a statement (e.g. retry a failed or low-quality run).',
  },
  {
    key: 'enrich',
    label: 'Auto Cleanse & Categorize',
    area: 'core',
    description: 'Run LLM enrichment to cleanse descriptions and assign business categories.',
  },
  {
    key: 'checkResolve',
    label: 'Resolve Check Payees',
    area: 'core',
    description: 'Vision-based resolution of check payee names from the source PDF.',
  },
  {
    key: 'exports',
    label: 'Export Files',
    area: 'core',
    description: 'Generate and download CSV / OFX / QFX / QBO export files.',
  },

  // ----- admin (one key per admin sub-page) -----
  {
    key: 'admin.home',
    label: 'Admin Dashboard',
    area: 'admin',
    description: 'Access the /admin dashboard hub. Individual widgets honor their own feature.',
  },
  {
    key: 'admin.users',
    label: 'User Management',
    area: 'admin',
    description: 'Create staff users and reset passwords.',
  },
  {
    key: 'admin.accessControl',
    label: 'Access Management',
    area: 'admin',
    description:
      'Manage per-user feature access (this page). At least one admin must always keep it.',
  },
  {
    key: 'admin.llmProvider',
    label: 'LLM Provider',
    area: 'admin',
    description: 'Configure the LLM routing policy, Anthropic key, models, pricing, and cost caps.',
  },
  {
    key: 'admin.audit',
    label: 'Audit Log',
    area: 'admin',
    description: 'View the firm audit trail.',
  },
  {
    key: 'admin.diagnostics',
    label: 'Diagnostics',
    area: 'admin',
    description: 'View system diagnostics and environment info.',
  },
  {
    key: 'admin.maintenance',
    label: 'Maintenance & FIDIR',
    area: 'admin',
    description: 'Queue stats, session/temp cleanup, PDF strategy & retention, and FIDIR refresh.',
  },
  {
    key: 'admin.engines',
    label: 'Engine Config',
    area: 'admin',
    description:
      'Configure the Vibe Shield (OCR) and LLM-Gateway engine endpoints and credentials.',
  },
  {
    key: 'admin.backup',
    label: 'Backup & Restore',
    area: 'admin',
    description: 'Create, list, download, and delete database backups.',
  },
  {
    key: 'admin.categories',
    label: 'Business Categories',
    area: 'admin',
    description: 'Manage the business-category dictionary used for enrichment.',
  },
  {
    key: 'admin.enrichmentPrompt',
    label: 'Enrichment Prompt',
    area: 'admin',
    description: 'Tune the enrichment toggles and the cleanse/categorize system prompt.',
  },
] as const;

export type FeatureKey = (typeof FEATURE_DEFS)[number]['key'];

export const FEATURE_KEYS: readonly string[] = FEATURE_DEFS.map((f) => f.key);

// The feature that controls this very management surface. Guarded against
// last-admin lockout in services/feature-access.ts.
export const ACCESS_CONTROL_FEATURE = 'admin.accessControl';

export const isFeatureKey = (k: string): k is FeatureKey => FEATURE_KEYS.includes(k);

// A fresh, fully-enabled access map. Used as the base before applying a
// user's explicit overrides, and as the fallback when no user is loaded.
export const defaultFeatureAccess = (): Record<string, boolean> =>
  Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
