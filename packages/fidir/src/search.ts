import type { FidirEntry } from './types.js';

// In-memory search used for local development and testing. Production runs
// against pg_trgm — see apps/api/src/routes/fidir.ts.
export const searchFidir = (entries: FidirEntry[], query: string): FidirEntry[] => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const exactBidMatches = entries.filter((e) => e.intuBid === q);
  if (exactBidMatches.length > 0) return exactBidMatches;
  return entries.filter((e) => e.bankName.toLowerCase().includes(q));
};
