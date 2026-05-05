import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const HEADER = 'x-request-id';

export const requestId = (req: Request, res: Response, next: NextFunction): void => {
  const incoming = req.header(HEADER);
  const id = incoming && incoming.length > 0 && incoming.length <= 128 ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader(HEADER, id);
  next();
};
