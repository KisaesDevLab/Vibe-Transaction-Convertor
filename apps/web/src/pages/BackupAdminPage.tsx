import { Link } from 'react-router-dom';

export function BackupAdminPage() {
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <Link to="/admin" className="text-sm text-ink-muted hover:text-ink">
        ← Admin
      </Link>
      <h1 className="text-2xl font-semibold">Backup</h1>

      <section className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <h2 className="text-base font-medium">Database</h2>
        <p className="mt-1 text-ink-muted">
          The application connects under a role with no superuser rights — backups run on the
          container host. Use the standard <code>pg_dump</code> against the <code>vibetc</code>{' '}
          schema:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-md bg-surface-subtle p-3 font-mono text-xs">
          {`# host shell\npg_dump --no-owner --schema=vibetc \\\n  --format=custom \\\n  --file=vibetc-$(date +%Y%m%d).dump \\\n  postgres://vibetc:vibetc@localhost:5432/vibetc`}
        </pre>
        <p className="mt-2 text-xs text-ink-subtle">
          Schedule via your existing backup tooling (cron, restic, AWS Backup). The dump is
          self-contained — restore with <code>pg_restore</code> against an empty schema.
        </p>
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <h2 className="text-base font-medium">Uploaded PDFs</h2>
        <p className="mt-1 text-ink-muted">
          Source PDFs live under{' '}
          <code>$DATA_DIR/uploads/&#123;yyyy&#125;/&#123;mm&#125;/&#123;sha&#125;.pdf</code>{' '}
          (content-addressed). They are not necessary to restore — re-importing the same PDF
          produces byte-identical FITIDs and exports — but back them up if you need to retain the
          original source for audit.
        </p>
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <h2 className="text-base font-medium">FIDIR</h2>
        <p className="mt-1 text-ink-muted">
          The FIDIR mirror at <code>data/fidir/fidir-us.txt</code> is in source control — backups
          happen via your repository, not this database.
        </p>
      </section>

      <section className="rounded-lg border border-surface-muted bg-white p-4 text-sm">
        <h2 className="text-base font-medium">Restore plan</h2>
        <ol className="mt-1 ml-5 list-decimal space-y-1 text-ink-muted">
          <li>Bring up Postgres on the same major version (16+).</li>
          <li>
            <code>pg_restore</code> the latest dump into a fresh database; the schema and roles are
            recreated.
          </li>
          <li>
            Restore <code>$DATA_DIR/uploads</code> if you want the source PDFs back (optional).
          </li>
          <li>
            Re-deploy the API container; <code>seedFidirIfEmpty</code> picks up the vendored FIDIR
            on first boot.
          </li>
        </ol>
      </section>
    </section>
  );
}
