import { Navigate, Route, Routes } from 'react-router-dom';

import { AdminGate } from './components/AdminGate';
import { AppShell } from './components/AppShell';
import { AuthGate } from './components/AuthGate';
import { FeatureGate } from './components/FeatureGate';
import { FEATURE } from './lib/features';
import { AccessAdminPage } from './pages/AccessAdminPage';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { AccountProfilePage } from './pages/AccountProfilePage';
import { CompaniesPage } from './pages/CompaniesPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterFirstAdminPage } from './pages/RegisterFirstAdminPage';
import { AdminHomePage } from './pages/AdminHomePage';
import { AuditLogPage } from './pages/AuditLogPage';
import { BackupAdminPage } from './pages/BackupAdminPage';
import { CategoryAdminPage } from './pages/CategoryAdminPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { EnginesAdminPage } from './pages/EnginesAdminPage';
import { ExportPage } from './pages/ExportPage';
import { GlobalStatementsPage } from './pages/GlobalStatementsPage';
import { HelpPage } from './pages/HelpPage';
import { EnrichmentPromptAdminPage } from './pages/EnrichmentPromptAdminPage';
import { LlmProviderAdminPage } from './pages/LlmProviderAdminPage';
import { MaintenanceAdminPage } from './pages/MaintenanceAdminPage';
import { StatementReviewPage } from './pages/StatementReviewPage';
import { StatementsListPage } from './pages/StatementsListPage';
import { UsersAdminPage } from './pages/UsersAdminPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterFirstAdminPage />} />
      <Route
        path="/*"
        element={
          <AuthGate>
            <AppShell>
              <Routes>
                <Route path="/" element={<Navigate to="/companies" replace />} />
                <Route path="/account" element={<AccountProfilePage />} />
                <Route
                  path="/companies"
                  element={
                    <FeatureGate feature={FEATURE.companies}>
                      <CompaniesPage />
                    </FeatureGate>
                  }
                />
                <Route
                  path="/companies/:companyId"
                  element={
                    <FeatureGate feature={FEATURE.companies}>
                      <CompanyDetailPage />
                    </FeatureGate>
                  }
                />
                <Route
                  path="/accounts/:accountId"
                  element={
                    <FeatureGate feature={FEATURE.companies}>
                      <AccountDetailPage />
                    </FeatureGate>
                  }
                />
                <Route
                  path="/accounts/:accountId/statements"
                  element={
                    <FeatureGate feature={FEATURE.statements}>
                      <StatementsListPage />
                    </FeatureGate>
                  }
                />
                <Route
                  path="/statements/:statementId"
                  element={
                    <FeatureGate feature={FEATURE.statements}>
                      <StatementReviewPage />
                    </FeatureGate>
                  }
                />
                <Route
                  path="/statements/:statementId/export"
                  element={
                    <FeatureGate feature={FEATURE.exports}>
                      <ExportPage />
                    </FeatureGate>
                  }
                />
                <Route
                  path="/statements"
                  element={
                    <FeatureGate feature={FEATURE.statements}>
                      <GlobalStatementsPage />
                    </FeatureGate>
                  }
                />
                <Route path="/help" element={<HelpPage />} />
                <Route path="/help/:slug" element={<HelpPage />} />
                <Route
                  path="/admin"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminHome}>
                        <AdminHomePage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/llm-provider"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminLlmProvider}>
                        <LlmProviderAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/audit"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminAudit}>
                        <AuditLogPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/users"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminUsers}>
                        <UsersAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/access"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminAccessControl}>
                        <AccessAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/diagnostics"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminDiagnostics}>
                        <DiagnosticsPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/maintenance"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminMaintenance}>
                        <MaintenanceAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/engines"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminEngines}>
                        <EnginesAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/backup"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminBackup}>
                        <BackupAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/categories"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminCategories}>
                        <CategoryAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/enrichment-prompt"
                  element={
                    <AdminGate>
                      <FeatureGate feature={FEATURE.adminEnrichmentPrompt}>
                        <EnrichmentPromptAdminPage />
                      </FeatureGate>
                    </AdminGate>
                  }
                />
                <Route path="*" element={<Placeholder title="Not found" />} />
              </Routes>
            </AppShell>
          </AuthGate>
        }
      />
    </Routes>
  );
}

function Placeholder({ title }: { title: string }) {
  return (
    <section className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-ink-muted">Lands in a later phase.</p>
    </section>
  );
}
