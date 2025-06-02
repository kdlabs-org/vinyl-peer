import { Vinyl } from "./packages/vinyl-peer-protocol/dist/esm/index.js";
import { MusicPlugin } from "./packages/vinyl-peer-plugin-music/dist/esm/index.js";
import { AnalyticsPlugin } from "./packages/vinyl-peer-plugin-analytics/dist/esm/index.js";
import { ReplicationPlugin } from "./packages/vinyl-peer-plugin-replication/dist/esm/index.js";
import { WebServer } from "./packages/vinyl-peer-cli/dist/esm/WebServer.js";

async function main() {
  // 1) Instantiate Vinyl with Music, Analytics, and Replication plugins
  const vinyl = new Vinyl([
    new MusicPlugin(),
    new AnalyticsPlugin(),
    new ReplicationPlugin(),
  ]);

  // 2) Initialize the node (starts libp2p, Helia, and registers/plugins)
  const ok = await vinyl.initialize(true, []);
  if (!ok) {
    console.error("❌ Vinyl failed to initialize");
    process.exit(1);
  }

  console.log("✅ Vinyl node is up!");
  console.log(`   • Node ID: ${vinyl.getNodeStats().id}`);
  console.log(
    `   • Storage: ${
      vinyl.getNodeStats().storageAvailable > 0 ? "IPFS enabled" : "relay-only"
    }`
  );

  // 3) Start the HTTP server on port 3001
  const webServer = new WebServer(vinyl);
  await webServer.start(3001);
  console.log("🌐 Web server listening at http://localhost:3001");

  // 4) Forward all Vinyl events to the console
  vinyl.onEvent((eventName, data) => {
    console.log(`[event] ${eventName}:`, data);
  });

  // 5) Clean up on SIGINT: stop both Vinyl node and HTTP server
  process.on("SIGINT", async () => {
    console.log("\n🛑 Shutting down Vinyl...");

    await webServer.stop();
    console.log("✅ Web server stopped.");

    await vinyl.stop();
    console.log("✅ Vinyl node stopped.");

    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error in run-vinyl:", err);
  process.exit(1);
});
