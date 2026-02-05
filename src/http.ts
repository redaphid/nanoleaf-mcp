import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createRestApi } from "./rest-api.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DeviceManager } from "./device-manager.ts";

type ParseColor = (
  color: string
) => { hue: number; saturation: number; brightness: number } | null;

export async function startHttp(
  server: McpServer,
  deviceManager: DeviceManager,
  parseColor: ParseColor,
  port: number,
) {
  const transports: Record<string, StreamableHTTPServerTransport> = {};
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  // Mount REST API
  app.use("/api", createRestApi(deviceManager, parseColor));

  app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    try {
      if (sessionId && transports[sessionId]) {
        await transports[sessionId].handleRequest(req, res, req.body);
      } else if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport;
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) delete transports[transport.sessionId];
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID" },
          id: null,
        });
      }
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send("Invalid or missing session ID");
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      return res.status(400).send("Invalid or missing session ID");
    }
    await transports[sessionId].handleRequest(req, res);
  });

  app.listen(port, () => {
    console.log(`Nanoleaf MCP server running on http://0.0.0.0:${port}/mcp`);
    console.log(`REST API:   http://0.0.0.0:${port}/api`);
    console.log(`Swagger UI: http://0.0.0.0:${port}/api/docs`);
    const devices = deviceManager.listAll();
    if (devices.length > 0) {
      console.log(`Registered devices (${devices.length}):`);
      for (const d of devices) {
        console.log(
          `  ${d.alias} — ${d.ip}${d.name ? ` — ${d.name}` : ""}${d.model ? ` (${d.model})` : ""}`
        );
      }
    } else {
      console.log(
        "No devices configured. Set NANOLEAF_DEVICES env var or use add_device at runtime."
      );
    }
  });
}
