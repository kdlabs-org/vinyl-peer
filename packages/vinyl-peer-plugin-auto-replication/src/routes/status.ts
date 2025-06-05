import { Router, Request, Response } from "express";
import type { ReplicationStatus } from "../types.js";
import type { ReplicationBalancer } from "../utils/balancer.js";

/**
 * GET /api/replicate/status
 * → Return JSON array of { cid, replicaCount, peers }
 */
export default function statusRoute(balancer: ReplicationBalancer) {
  return (_req: Request, res: Response) => {
    const statusMap = balancer.getStatus();
    const response: ReplicationStatus[] = Object.entries(statusMap).map(
      ([cid, { replicaCount, peers }]) => ({ cid, replicaCount, peers }),
    );
    res.json(response);
  };
}
