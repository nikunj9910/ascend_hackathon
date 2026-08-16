import type { NextFunction, Request, Response } from 'express';

/**
 * Requires a valid X-API-Key header on write routes. Read routes
 * (GET /documents/:id/state, GET /documents/:id/audit) never use this.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.API_KEY;
  if (!expected) {
    // Fail closed: an unconfigured server must not silently accept writes.
    res.status(500).json({ error: 'Server misconfiguration: API_KEY is not set.' });
    return;
  }

  const provided = req.header('X-API-Key');
  if (!provided || provided !== expected) {
    res.status(401).json({ error: 'A valid X-API-Key header is required for this endpoint.' });
    return;
  }

  next();
}
