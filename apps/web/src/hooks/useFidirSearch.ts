import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { api } from '../lib/api';

export interface FidirHit {
  id: number;
  intuBid: string;
  intuOrg: string;
  bankName: string;
  url: string | null;
  score: number;
}

const useDebounced = <T>(value: T, ms: number): T => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
};

export const useFidirSearch = (query: string) => {
  const debounced = useDebounced(query.trim(), 250);
  return useQuery({
    queryKey: ['fidir', 'search', debounced],
    queryFn: () =>
      api.get<{ query: string; results: FidirHit[] }>('/api/fidir/search', { q: debounced }),
    enabled: debounced.length > 0,
    staleTime: 60_000,
  });
};
