import { Navigate, Route, Routes } from 'react-router-dom';

import { AdminGate } from './components/AdminGate';
import { AppShell } from './components/AppShell';
import { AuthGate } from './components/AuthGate';
import { AccountDetailPage } from './pages/AccountDetailPage';
import { AccountProfilePage } from './pages/AccountProfilePage';
import { CompaniesPage } from './pages/CompaniesPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterFirstAdminPage } from './pages/RegisterFirstAdminPage';
import { AdminHomePage } from './pages/AdminHomePage';
import { AuditLogPage } from './pages/AuditLogPage';
import { BackupAdminPage } from './pages/BackupAdminPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { EnginesAdminPage } from './pages/EnginesAdminPage';
import { ExportPage } from './pages/ExportPage';
import { GlobalStatementsPage } from './pages/GlobalStatementsPage';
import { HelpPage } from './pages/HelpPage';
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
                <Route path="/companies" element={<CompaniesPage />} />
                <Route path="/companies/:companyId" element={<CompanyDetailPage />} />
                <Route path="/accounts/:accountId" element={<AccountDetailPage />} />
                <Route path="/accounts/:accountId/statements" element={<StatementsListPage />} />
                <Route path="/statements/:statementId" element={<StatementReviewPage />} />
                <Route path="/statements/:statementId/export" element={<ExportPage />} />
                <Route path="/statements" element={<GlobalStatementsPage />} />
                <Route path="/help" element={<HelpPage />} />
                <Route path="/help/:slug" element={<HelpPage />} />
                <Route
                  path="/admin"
                  element={
                    <AdminGate>
                      <AdminHomePage />
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/llm-provider"
                  element={
                    <AdminGate>
                      <LlmProviderAdminPage />
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/audit"
                  element={
                    <AdminGate>
                      <AuditLogPage />
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/users"
                  element={
                    <AdminGate>
                      <UsersAdminPage />
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/diagnostics"
                  element={
                    <AdminGate>
                      <DiagnosticsPage />
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/maintenance"
                  element={
                    <AdminGate>
                      <MaintenanceAdminPage />
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/engines"
                  element={
                    <AdminGate>
                      <EnginesAdminPage />
                    </AdminGate>
                  }
                />
                <Route
                  path="/admin/backup"
                  element={
                    <AdminGate>
                      <BackupAdminPage />
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
