import rateLimit from 'express-rate-limit';

/**
 * In-memory, per-process, per-IP token bucket for write endpoints. Resets on
 * server restart and is not shared across processes — acceptable for a
 * single-process local demo, called out explicitly in the README.
 */
export const writeRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests from this IP; please slow down and try again shortly.' },
});
