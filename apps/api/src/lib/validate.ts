import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodSchema, ZodTypeAny, z } from 'zod';

import { ValidationError } from './errors.js';

export interface ValidateSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

export interface Parsed<S extends ValidateSchemas> {
  body: S['body'] extends ZodTypeAny ? z.infer<S['body']> : undefined;
  query: S['query'] extends ZodTypeAny ? z.infer<S['query']> : undefined;
  params: S['params'] extends ZodTypeAny ? z.infer<S['params']> : undefined;
}

declare global {
  namespace Express {
    interface Request {
      parsed?: Parsed<ValidateSchemas>;
    }
  }
}

const tryParse = <T>(
  schema: ZodSchema<T> | undefined,
  input: unknown,
  label: string,
): T | undefined => {
  if (!schema) return undefined;
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ValidationError(`${label} failed validation`, result.error.flatten());
  }
  return result.data;
};

export const validate =
  <S extends ValidateSchemas>(schemas: S): RequestHandler =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.parsed = {
        body: tryParse(schemas.body, req.body, 'body'),
        query: tryParse(schemas.query, req.query, 'query'),
        params: tryParse(schemas.params, req.params, 'params'),
      } as Parsed<S>;
      next();
    } catch (err) {
      next(err);
    }
  };
