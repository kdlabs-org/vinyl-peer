import { Router, Request, Response } from "express";
import type { ReplicationBalancer } from "../utils/balancer.js";

/**
 * POST /api/replicate/override
 * Body: { cid: string, action: "pin" | "unpin" }
 */
export default function overrideRoute(balancer: ReplicationBalancer) {
  return async (req: Request, res: Response) => {
    const { cid, action } = req.body;
    if (!cid || (action !== "pin" && action !== "unpin")) {
      res.status(400).json({ error: "Invalid payload" });
      return;
    }
    try {
      await balancer.override(cid, action);
      res.json({ success: true });
    } catch (err) {
      console.error("[auto-replication] override error:", err);
      res.status(500).json({ error: "Override failed" });
    }
  };
}
