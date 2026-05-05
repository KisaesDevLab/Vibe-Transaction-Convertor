export interface FidirEntry {
  intuBid: string;
  intuOrg: string;
  bankName: string;
  url?: string;
  country: 'US';
  raw: Record<string, string>;
}
