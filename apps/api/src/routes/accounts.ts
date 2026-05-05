import { Router } from 'express';

import { schemas } from '@vibe-tx-converter/shared';

import { db } from '../db/client.js';
import { ForbiddenError } from '../lib/errors.js';
import {
  createAccount,
  deleteAccount,
  getAccount,
  listAccountsByCompany,
  updateAccount,
} from '../services/accounts.js';

const { AccountCreate, AccountUpdate, AccountId } = schemas.account;

export const accountsByCompanyRouter = (): Router => {
  const router = Router({ mergeParams: true });

  router.get('/', async (req, res, next) => {
    try {
      const companyId = String((req.params as Record<string, string>).companyId ?? '');
      const rows = await listAccountsByCompany(db, companyId);
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const companyId = String((req.params as Record<string, string>).companyId ?? '');
      const body = AccountCreate.parse({ ...req.body, companyId });
      const created = await createAccount(db, req.user!, body);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  return router;
};

export const accountsRouter = (): Router => {
  const router = Router();

  router.get('/:id', async (req, res, next) => {
    try {
      const id = AccountId.parse(req.params.id);
      const reveal = req.query.reveal === 'true';
      if (reveal && req.user?.role !== 'admin') {
        throw new ForbiddenError('admin required for ?reveal=true');
      }
      const account = await getAccount(db, id, reveal ? { reveal: true, actor: req.user! } : {});
      res.json(account);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const id = AccountId.parse(req.params.id);
      const body = AccountUpdate.parse(req.body);
      const updated = await updateAccount(db, req.user!, id, body);
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = AccountId.parse(req.params.id);
      const force = req.query.force === 'true';
      await deleteAccount(db, req.user!, id, { force });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
};
