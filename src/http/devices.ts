/** `GET /api/devices` — the client-safe device list the frontend polls. */

import type { Request, Response } from "express";
import * as registry from "../registry";

export function listDevicesHandler(_req: Request, res: Response): void {
  res.json(registry.listDevices());
}
