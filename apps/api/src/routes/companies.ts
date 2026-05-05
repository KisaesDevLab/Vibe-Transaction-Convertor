import { Router } from 'express';

import { schemas } from '@vibe-tx-converter/shared';

const { CompanyCreate, CompanyId, CompanyListQuery, CompanyUpdate } = schemas.company;

import { db } from '../db/client.js';
import { ValidationError } from '../lib/errors.js';
import {
  createCompany,
  deleteCompany,
  getCompany,
  listCompanies,
  updateCompany,
} from '../services/companies.js';

export const companiesRouter = (): Router => {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const params = CompanyListQuery.parse(req.query);
      res.json(await listCompanies(db, params));
    } catch (err) {
      next(err);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const body = CompanyCreate.parse(req.body);
      const created = await createCompany(db, req.user!, body);
      res.status(201).json(created);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = CompanyId.parse(req.params.id);
      res.json(await getCompany(db, id));
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const id = CompanyId.parse(req.params.id);
      const body = CompanyUpdate.parse(req.body);
      if (Object.keys(body).length === 0) {
        throw new ValidationError('no fields to update');
      }
      res.json(await updateCompany(db, req.user!, id, body));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = CompanyId.parse(req.params.id);
      const force = req.query.force === 'true';
      await deleteCompany(db, req.user!, id, { force });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
};
