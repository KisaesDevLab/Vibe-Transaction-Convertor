import { and, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { userFeatureAccess, users } from '../db/schema.js';
import { ConflictError, ValidationError } from '../lib/errors.js';
import {
  ACCESS_CONTROL_FEATURE,
  defaultFeatureAccess,
  isFeatureKey,
} from '../lib/feature-registry.js';
import { writeAudit } from './audit.js';

// Effective feature map for one user: start fully-enabled, then apply
// that user's explicit override rows. Loaded once per request in
// loadSession and consumed by requireFeature().
export const loadFeatureAccess = async (
  db: Db,
  userId: string,
): Promise<Record<string, boolean>> => {
  const map = defaultFeatureAccess();
  const rows = await db
    .select({ featureKey: userFeatureAccess.featureKey, enabled: userFeatureAccess.enabled })
    .from(userFeatureAccess)
    .where(eq(userFeatureAccess.userId, userId));
  for (const r of rows) {
    // Ignore rows for keys no longer in the registry (a removed feature).
    if (isFeatureKey(r.featureKey)) map[r.featureKey] = r.enabled;
  }
  return map;
};

export interface FeatureAccessUser {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'staff';
  features: Record<string, boolean>;
}

// Full users × features matrix for the management UI. One query per
// table; the override rows are folded onto a default-on base per user.
export const getFeatureAccessMatrix = async (db: Db): Promise<FeatureAccessUser[]> => {
  const us = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(users)
    .orderBy(users.createdAt);

  const overrides = await db
    .select({
      userId: userFeatureAccess.userId,
      featureKey: userFeatureAccess.featureKey,
      enabled: userFeatureAccess.enabled,
    })
    .from(userFeatureAccess);

  const byUser = new Map<string, Record<string, boolean>>();
  for (const u of us) byUser.set(u.id, defaultFeatureAccess());
  for (const o of overrides) {
    const m = byUser.get(o.userId);
    if (m && isFeatureKey(o.featureKey)) m[o.featureKey] = o.enabled;
  }

  return us.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role as 'admin' | 'staff',
    features: byUser.get(u.id) ?? defaultFeatureAccess(),
  }));
};

// Count of admins who would still hold the Access Management feature if
// `excludingUserId` lost it. Drives the last-admin lockout guard.
const adminsRetainingAccessControl = async (db: Db, excludingUserId: string): Promise<number> => {
  const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, 'admin'));

  const denials = await db
    .select({ userId: userFeatureAccess.userId })
    .from(userFeatureAccess)
    .where(
      and(
        eq(userFeatureAccess.featureKey, ACCESS_CONTROL_FEATURE),
        eq(userFeatureAccess.enabled, false),
      ),
    );
  const denied = new Set(denials.map((d) => d.userId));

  return admins.filter((a) => a.id !== excludingUserId && !denied.has(a.id)).length;
};

export interface SetFeatureAccessInput {
  actorUserId: string;
  targetUserId: string;
  featureKey: string;
  enabled: boolean;
}

// Upsert one grant + audit it. Refuses to remove Access Management from
// the last admin who holds it, which would lock the firm out of this
// surface entirely (admins are gated like everyone else).
export const setFeatureAccess = async (db: Db, input: SetFeatureAccessInput): Promise<void> => {
  const { actorUserId, targetUserId, featureKey, enabled } = input;

  if (!isFeatureKey(featureKey)) {
    throw new ValidationError(`unknown feature: ${featureKey}`);
  }

  const target = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, targetUserId))
    .limit(1);
  if (target.length === 0) {
    throw new ValidationError('unknown user');
  }

  if (featureKey === ACCESS_CONTROL_FEATURE && enabled === false && target[0]!.role === 'admin') {
    const remaining = await adminsRetainingAccessControl(db, targetUserId);
    if (remaining === 0) {
      throw new ConflictError(
        'At least one admin must keep Access Management — re-enable it for another admin first.',
      );
    }
  }

  await db
    .insert(userFeatureAccess)
    .values({ userId: targetUserId, featureKey, enabled, updatedBy: actorUserId })
    .onConflictDoUpdate({
      target: [userFeatureAccess.userId, userFeatureAccess.featureKey],
      set: { enabled, updatedAt: sql`now()`, updatedBy: actorUserId },
    });

  await writeAudit(db, {
    actorUserId,
    entityType: 'feature_access',
    entityId: targetUserId,
    action: `feature_access.${enabled ? 'enable' : 'disable'}`,
    payload: { featureKey, enabled },
  });
};
