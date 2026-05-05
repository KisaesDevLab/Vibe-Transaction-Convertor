import { Router, type RequestHandler } from 'express';
import type { ZodTypeAny, z } from 'zod';

import { validate, type Parsed, type ValidateSchemas } from './validate.js';

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';

type Handler<S extends ValidateSchemas> = (
  req: Express.Request & { parsed: Parsed<S> },
  res: Parameters<RequestHandler>[1],
  next: Parameters<RequestHandler>[2],
) => unknown;

export interface TypedRouter {
  raw: Router;
  get: <S extends ValidateSchemas>(path: string, schemas: S, handler: Handler<S>) => TypedRouter;
  post: <S extends ValidateSchemas>(path: string, schemas: S, handler: Handler<S>) => TypedRouter;
  put: <S extends ValidateSchemas>(path: string, schemas: S, handler: Handler<S>) => TypedRouter;
  patch: <S extends ValidateSchemas>(path: string, schemas: S, handler: Handler<S>) => TypedRouter;
  delete: <S extends ValidateSchemas>(path: string, schemas: S, handler: Handler<S>) => TypedRouter;
  use: (...handlers: RequestHandler[]) => TypedRouter;
}

const wrap =
  <S extends ValidateSchemas>(handler: Handler<S>): RequestHandler =>
  async (req, res, next) => {
    try {
      await Promise.resolve(handler(req as never, res, next));
    } catch (err) {
      next(err);
    }
  };

export const createRouter = (): TypedRouter => {
  const raw = Router();
  const route =
    (method: Method) =>
    <S extends ValidateSchemas>(path: string, schemas: S, handler: Handler<S>): TypedRouter => {
      raw[method](path, validate(schemas), wrap(handler));
      return api;
    };

  const api: TypedRouter = {
    raw,
    get: route('get'),
    post: route('post'),
    put: route('put'),
    patch: route('patch'),
    delete: route('delete'),
    use: (...handlers) => {
      raw.use(...handlers);
      return api;
    },
  };
  return api;
};

// Re-export so callers don't need to import zod separately.
export type { ZodTypeAny, z };
