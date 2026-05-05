// /help — bundled, searchable, in-app knowledge base.
//
// Topic content lives as .md files under src/help/. Vite imports the
// raw text via the ?raw suffix, marked turns it into HTML, and this
// page renders it with a side nav + client-side search.
//
// All content ships in the SPA bundle — no network calls, no external
// docs site. Edits to the .md files take effect on the next build.

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { marked } from 'marked';

import gettingStartedMd from '../help/getting-started.md?raw';
import uploadingPdfsMd from '../help/uploading-pdfs.md?raw';
import reviewingTransactionsMd from '../help/reviewing-transactions.md?raw';
import reconciliationMd from '../help/reconciliation.md?raw';
import exportingMd from '../help/exporting.md?raw';
import adminEnginesMd from '../help/admin-engines.md?raw';
import adminLlmProviderMd from '../help/admin-llm-provider.md?raw';
import troubleshootingMd from '../help/troubleshooting.md?raw';

interface Topic {
  slug: string;
  title: string;
  body: string;
}

// Title is parsed from the first H1 in each file; topics that lose
// their leading "# Foo" header would fall back to the slug.
const stripFirstHeading = (md: string): { title: string; rest: string } => {
  const m = /^\s*#\s+(.+?)\s*\n/.exec(md);
  if (!m) return { title: '', rest: md };
  return { title: m[1]!, rest: md.slice(m[0].length) };
};

const TOPICS: Topic[] = [
  { slug: 'getting-started', ...stripFirstHeading(gettingStartedMd), body: gettingStartedMd },
  { slug: 'uploading-pdfs', ...stripFirstHeading(uploadingPdfsMd), body: uploadingPdfsMd },
  {
    slug: 'reviewing-transactions',
    ...stripFirstHeading(reviewingTransactionsMd),
    body: reviewingTransactionsMd,
  },
  { slug: 'reconciliation', ...stripFirstHeading(reconciliationMd), body: reconciliationMd },
  { slug: 'exporting', ...stripFirstHeading(exportingMd), body: exportingMd },
  { slug: 'admin-engines', ...stripFirstHeading(adminEnginesMd), body: adminEnginesMd },
  {
    slug: 'admin-llm-provider',
    ...stripFirstHeading(adminLlmProviderMd),
    body: adminLlmProviderMd,
  },
  { slug: 'troubleshooting', ...stripFirstHeading(troubleshootingMd), body: troubleshootingMd },
];

// marked options: GFM, no auto-linking of bare URLs (we want explicit
// markdown links only). The output is HTML we set via dangerouslySet —
// safe because the source is bundled .md files we control, not user
// content.
marked.setOptions({ gfm: true, breaks: false });

export function HelpPage() {
  const { slug } = useParams<{ slug?: string }>();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return TOPICS;
    return TOPICS.filter(
      (t) => t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
    );
  }, [query]);

  // When no slug is in the URL, default to "getting-started". When a
  // search filters the list and the active slug isn't in it, fall
  // through to the first match instead of showing an empty pane.
  const activeSlug = slug ?? 'getting-started';
  const active = filtered.find((t) => t.slug === activeSlug) ?? filtered[0] ?? TOPICS[0]!;

  // Render markdown to HTML. Memoized on body so we don't re-parse on
  // every keystroke in the search box.
  const html = useMemo(() => marked.parse(active.body) as string, [active.body]);

  // Scroll to top whenever the active topic changes — long topics
  // shouldn't keep their previous scroll position when you click
  // away.
  useEffect(() => {
    document.querySelector('main')?.scrollTo({ top: 0 });
  }, [active.slug]);

  return (
    <section className="grid gap-6 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-3 lg:sticky lg:top-0 lg:self-start">
        <div>
          <h1 className="text-2xl font-semibold">Help</h1>
          <p className="text-xs text-ink-muted">In-app knowledge base.</p>
        </div>
        <input
          type="search"
          placeholder="Search topics…"
          aria-label="Search help topics"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md border border-surface-muted px-3 py-1.5 text-sm"
        />
        <nav>
          <ul className="space-y-0.5 text-sm">
            {filtered.map((t) => (
              <li key={t.slug}>
                <Link
                  to={`/help/${t.slug}`}
                  className={`block rounded-md px-2 py-1.5 ${
                    t.slug === active.slug
                      ? 'bg-accent/10 font-medium text-ink'
                      : 'text-ink-muted hover:bg-surface-subtle hover:text-ink'
                  }`}
                >
                  {t.title || t.slug}
                </Link>
              </li>
            ))}
            {filtered.length === 0 ? (
              <li className="px-2 py-1.5 text-xs text-ink-muted">No topics match.</li>
            ) : null}
          </ul>
        </nav>
      </aside>
      {/* Source is bundled markdown we control, not user input — safe. */}
      <article
        className="prose prose-sm max-w-none rounded-lg border border-surface-muted bg-white p-6"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </section>
  );
}
