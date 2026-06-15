import type {
  accounts,
  auditLog,
  companies,
  exportJobs,
  fidirEntries,
  sessions,
  statements,
  systemSettings,
  transactions,
  userFeatureAccess,
  users,
} from './schema.js';

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type UserFeatureAccess = typeof userFeatureAccess.$inferSelect;
export type NewUserFeatureAccess = typeof userFeatureAccess.$inferInsert;

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

export type Statement = typeof statements.$inferSelect;
export type NewStatement = typeof statements.$inferInsert;

export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;

export type FidirEntry = typeof fidirEntries.$inferSelect;
export type NewFidirEntry = typeof fidirEntries.$inferInsert;

export type ExportJob = typeof exportJobs.$inferSelect;
export type NewExportJob = typeof exportJobs.$inferInsert;

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;

export type SystemSetting = typeof systemSettings.$inferSelect;
export type NewSystemSetting = typeof systemSettings.$inferInsert;
