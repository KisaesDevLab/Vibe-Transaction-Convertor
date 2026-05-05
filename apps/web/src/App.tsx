import { Navigate, Route, Routes } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { AuthGate } from './components/AuthGate';
import { CompaniesPage } from './pages/CompaniesPage';
import { CompanyDetailPage } from './pages/CompanyDetailPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterFirstAdminPage } from './pages/RegisterFirstAdminPage';

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
                <Route path="/companies" element={<CompaniesPage />} />
                <Route path="/companies/:companyId" element={<CompanyDetailPage />} />
                <Route path="/statements" element={<Placeholder title="Statements" />} />
                <Route path="/admin" element={<Placeholder title="Admin" />} />
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
