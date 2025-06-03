import { promises as fs } from "fs";
import path from "path";
import { Router } from "express";
import {
  BasePlugin,
  PluginCapabilities,
  PluginContext,
  VinylPeerPlugin,
} from "vinyl-peer-protocol";

interface EndpointInfo {
  method: string; // "GET" | "POST" | ...
  fullPath: string; // e.g. "/api/files/:cid"
  pathParams: string[]; // ["cid"] if path contains ":cid"
  hasQueryParams: boolean; // true for GET/DELETE
  hasBody: boolean; // true for POST/PUT/PATCH
}

interface SdkGeneratorOptions {
  outputDir?: string;
}

export class SdkGeneratorPlugin extends BasePlugin implements VinylPeerPlugin {
  protected context!: PluginContext;
  private options: Required<SdkGeneratorOptions>;

  constructor(options: SdkGeneratorOptions = {}) {
    super();
    this.options = {
      outputDir: options.outputDir ?? "generated-sdk",
    };
  }

  getCapabilities(): PluginCapabilities {
    return {
      name: "vinyl-peer-plugin-sdk-generator",
      version: "0.0.1",
      protocols: [],
      capabilities: ["sdk-generator"],
      permissions: {
        accessFiles: true,
        useNetwork: false,
        modifyPeers: false,
        exposeHttp: false,
      },
    };
  }

  async initialize(context: PluginContext): Promise<boolean> {
    const ok = await super.initialize(context);
    if (!ok) return false;
    this.context = context;
    return true;
  }

  /**
   * Once all plugins are registered and the HTTP server is up,
   * generate the SDK files.
   */
  async start(): Promise<void> {
    await super.start();

    // Wait until after Express has mounted all core/plugin routes
    // (e.g. after vinyl.startHttp() has been called in the main application).
    // A next‐tick delay ensures that `httpApp._router.stack` is “baked.”
    await new Promise((r) => process.nextTick(r));

    try {
      await this.generateSdkFiles();
      console.log(`[vinyl-sdk-generator] SDK written to "${this.options.outputDir}"`);
    } catch (err: any) {
      console.error("[vinyl-sdk-generator] Error generating SDK:", err);
    }
  }

  async stop(): Promise<void> {
    await super.stop();
  }

  setupProtocols(): void {
    // No libp2p protocols needed for SDK generation
  }

  async handleProtocol(_protocol: string, _stream: any, _peerId: string) {
    // Not used
  }

  getHttpNamespace(): string {
    return ""; // exposeHttp=false
  }
  getHttpRouter(): Router {
    return Router(); // never actually mounted
  }

  private async generateSdkFiles(): Promise<void> {
    // 1) Prepare output directory
    const outDir = path.isAbsolute(this.options.outputDir)
      ? this.options.outputDir
      : path.join(process.cwd(), this.options.outputDir);
    await fs.mkdir(outDir, { recursive: true });

    // 2) Collect all endpoints from core + plugins
    const endpoints: EndpointInfo[] = [];

    // Utility to walk an Express router stack
    const extract = (stack: any[], prefix = "") => {
      for (const layer of stack) {
        // a route “layer” has layer.route.path
        if (layer.route && layer.route.path) {
          const routePath: string = prefix + layer.route.path;
          Object.keys(layer.route.methods).forEach((m) => {
            if (!(layer.route.methods as any)[m]) return;
            const fullPath = routePath;
            const paramMatches = Array.from(fullPath.matchAll(/:([^\/]+)/g)).map(
              (match) => (match as RegExpMatchArray)[1],
            );
            endpoints.push({
              method: m.toUpperCase(),
              fullPath,
              pathParams: paramMatches,
              hasQueryParams: ["GET", "DELETE"].includes(m.toUpperCase()),
              hasBody: ["POST", "PUT", "PATCH"].includes(m.toUpperCase()),
            });
          });
        }
        // nested router (e.g. app.use("/foo", subRouter))
        else if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
          extract(layer.handle.stack, prefix);
        }
      }
    };

    // 2A) Core routes (registered by Vinyl.setupCoreRoutes)
    if (this.context.httpApp) {
      const coreStack = (this.context.httpApp as any)._router?.stack;
      if (Array.isArray(coreStack)) {
        extract(coreStack, "");
      }
    }

    // 2B) Plugin routes (each plugin.getHttpRouter())
    if (this.context.pluginManager) {
      for (const plugin of this.context.pluginManager.getAllPlugins()) {
        if (
          typeof (plugin as any).getHttpNamespace !== "function" ||
          typeof (plugin as any).getHttpRouter !== "function"
        ) {
          continue;
        }
        let namespace: string = (plugin as any).getHttpNamespace();
        if (!namespace.startsWith("/")) namespace = "/" + namespace;
        if (namespace.endsWith("/") && namespace.length > 1) {
          namespace = namespace.slice(0, -1);
        }
        const routerObj = (plugin as any).getHttpRouter();
        const subStack = (routerObj as any)._router?.stack ?? (routerObj as any).stack ?? [];
        extract(subStack, namespace);
      }
    }

    // 3) Write types.d.ts
    const typesDts = this.buildTypesDts();
    await fs.writeFile(path.join(outDir, "types.d.ts"), typesDts, "utf8");

    // 4) Write sdk.ts
    const sdkTs = this.buildSdkTs(endpoints);
    await fs.writeFile(path.join(outDir, "sdk.ts"), sdkTs, "utf8");
  }

  private buildTypesDts(): string {
    return `/**
 * AUTO‐GENERATED shared types for Vinyl SDK
 * Do not edit by hand.
 */

export type QueryParams = Record<string, any>;
export type RequestBody = any;
export type ResponseData = any;

export interface SdkClient {
  /**
   * Simple HTTP client with baseURL pointing to your Vinyl node.
   * e.g. const client = createSdkClient("http://localhost:3001")
   */
  get<T = ResponseData>(path: string, params?: QueryParams): Promise<T>;
  post<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T>;
  put<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T>;
  delete<T = ResponseData>(path: string, params?: QueryParams): Promise<T>;
}
`;
  }

  private buildSdkTs(endpoints: EndpointInfo[]): string {
    const lines: string[] = [];

    // Header + imports
    lines.push(`/**`);
    lines.push(` * AUTO‐GENERATED VINYL SDK`);
    lines.push(` * Do not edit by hand.`);
    lines.push(` */`);
    lines.push(``);
    lines.push(`import fetch from "node-fetch";`);
    lines.push(`import { SdkClient, QueryParams, RequestBody, ResponseData } from "./types";`);
    lines.push(``);

    // createSdkClient utility
    lines.push(`/**`);
    lines.push(` * Create a simple SdkClient using fetch`);
    lines.push(` */`);
    lines.push(`export function createSdkClient(baseURL: string): SdkClient {`);
    lines.push(`  return {`);
    lines.push(`    async get<T = ResponseData>(path: string, params?: QueryParams): Promise<T> {`);
    lines.push(`      const url = new URL(path, baseURL);`);
    lines.push(
      `      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));`,
    );
    lines.push(`      const res = await fetch(url.toString(), { method: "GET" });`);
    lines.push(`      return res.json();`);
    lines.push(`    },`);
    lines.push(
      `    async post<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T> {`,
    );
    lines.push(`      const url = new URL(path, baseURL);`);
    lines.push(
      `      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));`,
    );
    lines.push(`      const res = await fetch(url.toString(), {`);
    lines.push(`        method: "POST",`);
    lines.push(`        headers: { "Content-Type": "application/json" },`);
    lines.push(`        body: body ? JSON.stringify(body) : undefined`);
    lines.push(`      });`);
    lines.push(`      return res.json();`);
    lines.push(`    },`);
    lines.push(
      `    async put<T = ResponseData>(path: string, body?: RequestBody, params?: QueryParams): Promise<T> {`,
    );
    lines.push(`      const url = new URL(path, baseURL);`);
    lines.push(
      `      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));`,
    );
    lines.push(`      const res = await fetch(url.toString(), {`);
    lines.push(`        method: "PUT",`);
    lines.push(`        headers: { "Content-Type": "application/json" },`);
    lines.push(`        body: body ? JSON.stringify(body) : undefined`);
    lines.push(`      });`);
    lines.push(`      return res.json();`);
    lines.push(`    },`);
    lines.push(
      `    async delete<T = ResponseData>(path: string, params?: QueryParams): Promise<T> {`,
    );
    lines.push(`      const url = new URL(path, baseURL);`);
    lines.push(
      `      if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.append(k, String(v)));`,
    );
    lines.push(`      const res = await fetch(url.toString(), { method: "DELETE" });`);
    lines.push(`      return res.json();`);
    lines.push(`    }`);
    lines.push(`  };`);
    lines.push(`}`);
    lines.push(``);

    // Generate one function per endpoint
    endpoints.forEach((ep) => {
      // Build a safe function name
      const sanitized = ep.fullPath
        .replace(/^\/+/g, "")
        .replace(/\/+/g, "_")
        .replace(/:([^_]+)/g, "By$1")
        .replace(/[^a-zA-Z0-9_]/g, "");
      const fnName = `${ep.method.toLowerCase()}_${sanitized}`;

      // 1) Required path params
      const paramsList: string[] = [];
      ep.pathParams.forEach((p) => {
        paramsList.push(`${p}: string`);
      });

      // 2) Required client comes next
      paramsList.push(`client: SdkClient`);

      // 3) Optional query params (for GET/DELETE) or optional body (for POST/PUT/PATCH)
      if (ep.hasQueryParams) {
        paramsList.push(`queryParams?: QueryParams`);
      }
      if (ep.hasBody) {
        paramsList.push(`body?: RequestBody`);
      }

      // Write JSDoc
      lines.push(`/**`);
      lines.push(` * ${ep.method} ${ep.fullPath}`);
      lines.push(` */`);

      // Function signature
      lines.push(
        `export async function ${fnName}(${paramsList.join(", ")}): Promise<ResponseData> {`,
      );

      // Build the actual path expression (interpolating path params)
      const pathExpr = "`" + ep.fullPath.replace(/:([^\/]+)/g, "${$1}") + "`";

      // Decide invocation based on HTTP method
      if (["GET", "DELETE"].includes(ep.method)) {
        // GET/DELETE: client.get(path, queryParams)
        lines.push(
          `  return client.${ep.method.toLowerCase()}(${pathExpr}${
            ep.hasQueryParams ? ", queryParams" : ""
          });`,
        );
      } else {
        // POST/PUT/PATCH: client.post(path, body)
        lines.push(
          `  return client.${ep.method.toLowerCase()}(${pathExpr}, ${
            ep.hasBody ? "body" : "undefined"
          }${ep.hasQueryParams ? ", queryParams" : ""});`,
        );
      }

      lines.push(`}`);
      lines.push(``);
    });

    return lines.join("\n");
  }
}
