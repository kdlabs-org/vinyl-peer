import express, { Express, Request, Response } from "express";
import multer from "multer";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { NodeManager } from "./NodeManager.js";
import { VinylPeerPlugin, PluginManager, Vinyl } from "vinyl-peer-protocol";
import { NodeFile } from "./Node.js";
import mime from "mime-types";

/**
 * WebServer: Expose both core Vinyl endpoints and automatically discover
 * any plugin that implements getHttpNamespace()/getHttpRouter().
 */
export class WebServer {
  private app: Express;
  private vinyl: Vinyl;
  private nodeManager: NodeManager;
  private upload: multer.Multer;
  private serverInstance: any;

  /** Buffer of recent events for SSE (Server-Sent Events) replay. */
  private recentEvents: { event: string; data: any; timestamp: number }[] = [];

  constructor(vinyl: Vinyl) {
    this.vinyl = vinyl;
    this.nodeManager = new NodeManager(this.vinyl);

    // Create Express app and configure Multer for in-memory file uploads
    this.app = express();
    this.upload = multer({ storage: multer.memoryStorage() });

    // Set up middleware (CORS, JSON parsing, static files)
    this.setupMiddleware();

    // Register core REST endpoints
    this.setupCoreRoutes();

    // Enable Server-Sent Events for real-time event streaming
    this.setupEventSSE();
  }

  private setupMiddleware(): void {
    this.app.use(cors());
    this.app.use(express.json());
    this.app.use(express.static("public"));
  }

  private setupCoreRoutes(): void {
    this.app.get("/api/status", (req: Request, res: Response) => {
      try {
        const stats = this.vinyl.getNodeStats();
        res.json({
          status: "ok",
          nodeId: this.nodeManager.getNodeId(),
          isRunning: this.nodeManager.isNodeRunning(),
          stats,
        });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get("/api/peers", (req: Request, res: Response) => {
      try {
        const peers = this.vinyl.getPeers();
        res.json(peers);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get("/api/files", (req: Request, res: Response) => {
      try {
        const files = this.vinyl.getFiles();
        res.json(files);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post(
      "/api/upload",
      this.upload.single("file"),
      async (req: Request, res: Response) => {
        try {
          if (!req.file) {
            res.status(400).json({ error: "No file uploaded" });
            return;
          }

          const storageMode = (req.body.storageMode as "ipfs" | "p2p-stream") || "ipfs";
          const metadata = req.body.metadata ? JSON.parse(req.body.metadata as string) : undefined;

          const buffer = req.file.buffer;
          const originalName = req.file.originalname;
          const mimeType =
            req.file.mimetype ||
            (mime.lookup(originalName) as string) ||
            "application/octet-stream";
          const nodeFile = new NodeFile(buffer, originalName, mimeType);

          const cid = await this.vinyl.uploadFile(nodeFile, storageMode, metadata);
          res.json({ success: true, cid });
        } catch (err: any) {
          console.error("WebServer: upload error:", err);
          res.status(500).json({ error: err.message });
        }
      },
    );

    this.app.get("/api/download/:cid", async (req: Request, res: Response) => {
      try {
        const cid = req.params.cid;
        const data = await this.vinyl.downloadFile(cid);
        if (!data) {
          res.status(404).json({ error: "File not found" });
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${cid}"`);
        res.send(Buffer.from(data));
      } catch (err: any) {
        console.error("WebServer: download error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get("/api/search", async (req: Request, res: Response) => {
      try {
        const query = req.query.q as string;
        if (!query) {
          res.status(400).json({ error: "Query parameter 'q' is required" });
          return;
        }
        const results = await this.vinyl.searchFiles(query);
        res.json(results);
      } catch (err: any) {
        console.error("WebServer: search error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post("/api/pin/:cid", async (req: Request, res: Response) => {
      try {
        const cid = req.params.cid;
        await this.vinyl.pinFile(cid);
        res.json({ success: true, message: "File pinned successfully" });
      } catch (err: any) {
        console.error("WebServer: pin error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.delete("/api/pin/:cid", async (req: Request, res: Response) => {
      try {
        const cid = req.params.cid;
        await this.vinyl.unpinFile(cid);
        res.json({ success: true, message: "File unpinned successfully" });
      } catch (err: any) {
        console.error("WebServer: unpin error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get("/health", (req: Request, res: Response) => {
      res.json({ status: "healthy", timestamp: new Date().toISOString() });
    });
  }

  /**
   * 3) Discover all plugins implementing HttpPlugin and mount their routers.
   * Casting the `limiter` (and router) to `any` works around the v4/v5 typings mismatch.
   */
  private mountPluginRouters(): void {
    const pluginManager: PluginManager = (this.vinyl as any).getPluginManager();
    const allPlugins: VinylPeerPlugin[] = pluginManager.getAllPlugins();

    for (const plugin of allPlugins) {
      const hasNamespace = typeof (plugin as any).getHttpNamespace === "function";
      const hasRouter = typeof (plugin as any).getHttpRouter === "function";
      if (hasNamespace && hasRouter) {
        let namespace: string = (plugin as any).getHttpNamespace();
        const router = (plugin as any).getHttpRouter();

        // Normalize namespace: must start with "/" and not end with "/"
        if (!namespace.startsWith("/")) {
          namespace = "/" + namespace;
        }
        if (namespace.endsWith("/") && namespace.length > 1) {
          namespace = namespace.slice(0, -1);
        }

        const limiter = rateLimit({
          windowMs: 15 * 60 * 1000,
          max: 100,
          standardHeaders: true,
          legacyHeaders: false,
          message: { error: "Too many requests – try again later." },
        });

        this.app.use(
          namespace,
          cors({
            origin: ["https://your-trusted-origin.com"],
            methods: ["GET", "POST", "PUT", "DELETE"],
            credentials: true,
          }),
          helmet(),
          limiter as any,
          router as any,
        );

        console.log(`WebServer: mounted plugin routes at "${namespace}"`);
      }
    }
  }

  private setupEventSSE(): void {
    this.vinyl.onEvent((eventName: string, eventData: any) => {
      this.recentEvents.push({
        event: eventName,
        data: eventData,
        timestamp: Date.now(),
      });
      if (this.recentEvents.length > 500) {
        this.recentEvents.shift();
      }
    });

    this.app.get("/api/events", (req: Request, res: Response) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(":\n\n");

      const sendEvent = (name: string, payload: any) => {
        res.write(`event: ${name}\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const replayCount = Math.min(20, this.recentEvents.length);
      for (let i = this.recentEvents.length - replayCount; i < this.recentEvents.length; i++) {
        const e = this.recentEvents[i];
        sendEvent(e.event, e.data);
      }

      const listener = (evt: string, payload: any) => {
        sendEvent(evt, payload);
      };
      this.vinyl.onEvent(listener);

      req.on("close", () => {
        // In a more advanced setup you'd remove `listener` here
      });
    });
  }

  /**
   * 5) Start the HTTP server on the specified port (default: 3001).
   * Mount plugin routers after Vinyl.initialize completes.
   */
  start(port: number = 3001): Promise<void> {
    return new Promise(async (resolve, reject) => {
      try {
        this.mountPluginRouters();
        this.serverInstance = this.app.listen(port, () => {
          console.log(`WebServer: running on port ${port}`);
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * 6) Stop the HTTP server gracefully.
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.serverInstance) {
        this.serverInstance.close(() => {
          console.log("WebServer: stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getApp(): Express {
    return this.app;
  }
}
