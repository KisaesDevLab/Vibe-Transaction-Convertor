import type { Db } from '../db/client.js';
import { readSettingPlain, upsertSetting } from './system-settings.js';
import { writeAudit } from './audit.js';

export type PdfProcessingStrategy =
  | 'auto'
  | 'force-text'
  | 'force-ocr'
  | 'auto-ocr-fallback'
  | 'auto-text-fallback';

const KEY = 'pdf.processing.strategy';
const VALID: readonly PdfProcessingStrategy[] = [
  'auto',
  'force-text',
  'force-ocr',
  'auto-ocr-fallback',
  'auto-text-fallback',
];

export const isPdfProcessingStrategy = (v: unknown): v is PdfProcessingStrategy =>
  typeof v === 'string' && (VALID as readonly string[]).includes(v);

// Firm-wide default. Falls back to 'auto' when the row hasn't been set,
// which matches the historical worker behavior so an in-place upgrade
// is a no-op.
export const getFirmDefaultPdfStrategy = async (db: Db): Promise<PdfProcessingStrategy> => {
  const v = await readSettingPlain(db, KEY);
  return isPdfProcessingStrategy(v) ? v : 'auto';
};

export const setFirmDefaultPdfStrategy = async (
  db: Db,
  value: PdfProcessingStrategy,
  actorUserId: string,
): Promise<void> => {
  await upsertSetting(db, KEY, value, actorUserId);
  await writeAudit(db, {
    actorUserId,
    entityType: 'system_settings',
    entityId: KEY,
    action: 'pdf-strategy.set',
    payload: { value },
  });
};

// Per-statement override wins when present; otherwise fall back to the
// firm default. Worker calls this once per extraction.
export const resolvePdfStrategy = async (
  db: Db,
  override: PdfProcessingStrategy | null | undefined,
): Promise<PdfProcessingStrategy> => {
  if (override) return override;
  return getFirmDefaultPdfStrategy(db);
};
