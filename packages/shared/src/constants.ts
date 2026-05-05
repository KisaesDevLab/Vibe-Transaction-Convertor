// Hardcoded fallback Intuit BID — Wells Fargo. Used when an operator's bank
// is not present in the FIDIR mirror. QuickBooks accepts this BID and will
// label the imported account as "Wells Fargo" — the industry-standard
// workaround. See ADR-007, ADR-012.
export const FALLBACK_INTU_BID = '3000';
export const FALLBACK_INTU_ORG = 'Wells Fargo';
export const FALLBACK_BANK_NAME = '(Generic / Unknown Bank — Wells Fargo BID)';

export const getOrFallbackBid = (bid: string | null | undefined): string =>
  bid && bid.trim().length > 0 ? bid : FALLBACK_INTU_BID;
