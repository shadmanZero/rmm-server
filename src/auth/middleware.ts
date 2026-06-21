/**
 * Express auth middleware.
 *
 * `loadAuth` resolves the (optional) session cookie into `req.auth` and always
 * continues — it short-circuits with no database hit when no cookie is present, so it
 * is cheap to mount only on the routes that care. `requireApiAuth` and
 * `requirePageAuth` are the sync guards layered on top: the API guard answers `401`
 * JSON, the page guard redirects a browser to the login screen.
 */

import type { NextFunction, Request, Response } from "express";
import { logger } from "../log";
import { readSessionCookie } from "./cookies";
import { validateSession, type AuthContext } from "./sessions";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present only when the request carried a valid, unexpired session. */
      auth?: AuthContext;
    }
  }
}

export async function loadAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const sessionId = readSessionCookie(req.headers.cookie);
    if (sessionId) {
      const context = await validateSession(sessionId);
      if (context) req.auth = context;
    }
  } catch (err) {
    // A DB hiccup must not 500 every request — treat it as "not authenticated".
    logger.warn(`loadAuth failed: ${(err as Error).message}`);
  }
  next();
}

export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    res.status(401).json({ error: { code: "unauthorized", message: "authentication required" } });
    return;
  }
  next();
}

export function requirePageAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.auth) {
    const next_ = encodeURIComponent(req.originalUrl);
    res.redirect(`/login.html?next=${next_}`);
    return;
  }
  next();
}
