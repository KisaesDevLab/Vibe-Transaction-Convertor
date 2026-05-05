import { useEffect, useRef, useState } from 'react';

import {
  FALLBACK_BANK_NAME,
  FALLBACK_INTU_BID,
  FALLBACK_INTU_ORG,
} from '@vibe-tx-converter/shared';

import { useFidirSearch, type FidirHit } from '../hooks/useFidirSearch';
import { cn } from '../lib/cn';

export interface BankSelection {
  intuBid: string;
  intuOrg: string;
  bankName: string;
}

const FALLBACK_HIT: FidirHit = {
  id: -1,
  intuBid: FALLBACK_INTU_BID,
  intuOrg: FALLBACK_INTU_ORG,
  bankName: FALLBACK_BANK_NAME,
  url: null,
  score: 0,
};

export function BankPickerCombobox({
  value,
  onChange,
  id,
}: {
  value: BankSelection | null;
  onChange: (v: BankSelection) => void;
  id?: string;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const search = useFidirSearch(query);

  const hits: FidirHit[] = (search.data?.results ?? []).slice(0, 25);
  const list = [...hits, FALLBACK_HIT];

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const select = (hit: FidirHit) => {
    onChange({ intuBid: hit.intuBid, intuOrg: hit.intuOrg, bankName: hit.bankName });
    setQuery(hit.bankName);
    setOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <input
        id={id}
        type="text"
        autoComplete="off"
        placeholder="Search for a bank…"
        className="w-full rounded-md border border-surface-muted px-3 py-2"
        value={open ? query : (value?.bankName ?? query)}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIndex((i) => Math.min(i + 1, list.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((i) => Math.max(i - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const hit = list[activeIndex];
            if (hit) select(hit);
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
        aria-expanded={open}
        aria-haspopup="listbox"
        role="combobox"
      />
      {value ? (
        <p className="mt-1 text-xs text-ink-subtle">
          BID <code className="rounded bg-surface-subtle px-1 py-0.5">{value.intuBid}</code> ·{' '}
          {value.intuOrg}
        </p>
      ) : null}
      {open ? (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-surface-muted bg-white py-1 shadow-md"
        >
          {search.isPending && query.trim().length > 0 ? (
            <li className="px-3 py-2 text-sm text-ink-subtle">Searching…</li>
          ) : null}
          {list.map((hit, i) => (
            <li
              key={hit.id}
              role="option"
              aria-selected={i === activeIndex}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => select(hit)}
              className={cn(
                'cursor-pointer px-3 py-2 text-sm',
                i === activeIndex ? 'bg-surface-subtle' : '',
                hit.id === -1 ? 'border-t border-dashed border-surface-muted text-ink-muted' : '',
              )}
            >
              <p className="font-medium">{hit.bankName}</p>
              <p className="text-xs text-ink-subtle">
                BID {hit.intuBid}
                {hit.id === -1
                  ? ' · Bank not listed? QuickBooks will accept this fallback BID.'
                  : ''}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
