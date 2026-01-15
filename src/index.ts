import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  NanoleafClient,
  discoverDevicesMdns,
  discoverDevicesScan,
  type RGBColor,
} from "./nanoleaf-client.js";

const NANOLEAF_IP = process.env.NANOLEAF_IP || "";
const NANOLEAF_AUTH_TOKEN = process.env.NANOLEAF_AUTH_TOKEN || "";
const PORT = parseInt(process.env.PORT || "3101", 10);

let nanoleafClient: NanoleafClient | null = null;

if (NANOLEAF_IP && NANOLEAF_AUTH_TOKEN) {
  nanoleafClient = new NanoleafClient(NANOLEAF_IP, NANOLEAF_AUTH_TOKEN);
}

const server = new McpServer({
  name: "nanoleaf-mcp",
  version: "1.0.0",
});

// Helper for tool responses
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (error: any) => ({
  content: [{ type: "text" as const, text: `Error: ${error.message || error}` }],
  isError: true,
});
const json = (data: unknown) => ok(JSON.stringify(data, null, 2));
const notConfigured = () =>
  ok(
    "Not configured. Set NANOLEAF_IP and NANOLEAF_AUTH_TOKEN environment variables, or use discover_devices and create_auth_token tools."
  );
const isConfigured = () => NANOLEAF_IP && NANOLEAF_AUTH_TOKEN && nanoleafClient;

// ============================================
// DEVICE INFO TOOLS
// ============================================

server.registerTool("get_device_info", {
  title: "Get Device Info",
  description:
    "Get detailed information about the Nanoleaf device including name, model, firmware version, and current state",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    return json(await nanoleafClient!.getInfo());
  } catch (e) {
    return err(e);
  }
});

server.registerTool("get_panel_layout", {
  title: "Get Panel Layout",
  description:
    "Get the physical layout of all panels including their positions and IDs",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    return json(await nanoleafClient!.getPanelLayout());
  } catch (e) {
    return err(e);
  }
});

// ============================================
// POWER CONTROL TOOLS
// ============================================

server.registerTool("turn_on", {
  title: "Turn On",
  description: "Turn on the Nanoleaf device",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.turnOn();
    return ok("Nanoleaf turned on");
  } catch (e) {
    return err(e);
  }
});

server.registerTool("turn_off", {
  title: "Turn Off",
  description: "Turn off the Nanoleaf device",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.turnOff();
    return ok("Nanoleaf turned off");
  } catch (e) {
    return err(e);
  }
});

// ============================================
// BRIGHTNESS CONTROL
// ============================================

server.registerTool("set_brightness", {
  title: "Set Brightness",
  description: "Set the brightness of the Nanoleaf device (0-100)",
  inputSchema: z.object({
    brightness: z
      .number()
      .min(0)
      .max(100)
      .describe("Brightness value (0-100)"),
  }),
}, async ({ brightness }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setBrightness(brightness);
    return ok(`Brightness set to ${brightness}%`);
  } catch (e) {
    return err(e);
  }
});

// ============================================
// COLOR CONTROL TOOLS
// ============================================

server.registerTool("set_hue", {
  title: "Set Hue",
  description: "Set the hue of the Nanoleaf device (0-360 degrees on color wheel)",
  inputSchema: z.object({
    hue: z
      .number()
      .min(0)
      .max(360)
      .describe("Hue value (0-360, where 0=red, 120=green, 240=blue)"),
  }),
}, async ({ hue }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setHue(hue);
    return ok(`Hue set to ${hue}`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_saturation", {
  title: "Set Saturation",
  description: "Set the saturation of the Nanoleaf device (0-100)",
  inputSchema: z.object({
    saturation: z
      .number()
      .min(0)
      .max(100)
      .describe("Saturation value (0=white, 100=full color)"),
  }),
}, async ({ saturation }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setSaturation(saturation);
    return ok(`Saturation set to ${saturation}%`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_color_rgb", {
  title: "Set Color RGB",
  description: "Set the color using RGB values (0-255 for each channel)",
  inputSchema: z.object({
    r: z.number().min(0).max(255).describe("Red value (0-255)"),
    g: z.number().min(0).max(255).describe("Green value (0-255)"),
    b: z.number().min(0).max(255).describe("Blue value (0-255)"),
  }),
}, async ({ r, g, b }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setColor({ r, g, b });
    return ok(`Color set to RGB(${r}, ${g}, ${b})`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_color_temperature", {
  title: "Set Color Temperature",
  description:
    "Set the color temperature in Kelvin (1200-6500, lower=warmer, higher=cooler)",
  inputSchema: z.object({
    ct: z
      .number()
      .min(1200)
      .max(6500)
      .describe("Color temperature in Kelvin (1200=warm candlelight, 6500=cool daylight)"),
  }),
}, async ({ ct }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setColorTemperature(ct);
    return ok(`Color temperature set to ${ct}K`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_state", {
  title: "Set State",
  description: "Set multiple properties at once",
  inputSchema: z.object({
    on: z.boolean().optional().describe("Turn device on or off"),
    brightness: z.number().min(0).max(100).optional().describe("Brightness (0-100)"),
    hue: z.number().min(0).max(360).optional().describe("Hue (0-360)"),
    saturation: z.number().min(0).max(100).optional().describe("Saturation (0-100)"),
    ct: z.number().min(1200).max(6500).optional().describe("Color temperature in Kelvin"),
  }),
}, async ({ on, brightness, hue, saturation, ct }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setState({ on, brightness, hue, saturation, ct });
    return ok("State updated");
  } catch (e) {
    return err(e);
  }
});

// ============================================
// EFFECTS TOOLS
// ============================================

server.registerTool("list_effects", {
  title: "List Effects",
  description: "Get a list of all available effects on the device",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    const effects = await nanoleafClient!.listEffects();
    return ok(`Available effects:\n${effects.join("\n")}`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("get_current_effect", {
  title: "Get Current Effect",
  description: "Get the name of the currently active effect",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    const effect = await nanoleafClient!.getCurrentEffect();
    return ok(`Current effect: ${effect}`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_effect", {
  title: "Set Effect",
  description: "Activate a specific effect by name",
  inputSchema: z.object({
    effectName: z.string().describe("The name of the effect to activate"),
  }),
}, async ({ effectName }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setEffect(effectName);
    return ok(`Effect "${effectName}" activated`);
  } catch (e) {
    return err(e);
  }
});

// ============================================
// PANEL CONTROL TOOLS
// ============================================

server.registerTool("set_panel_colors", {
  title: "Set Panel Colors",
  description: "Set colors for individual panels. Provide an array of panel colors.",
  inputSchema: z.object({
    panels: z
      .array(
        z.object({
          panelId: z.number().describe("The panel ID"),
          r: z.number().min(0).max(255).describe("Red (0-255)"),
          g: z.number().min(0).max(255).describe("Green (0-255)"),
          b: z.number().min(0).max(255).describe("Blue (0-255)"),
        })
      )
      .describe("Array of panel colors"),
  }),
}, async ({ panels }) => {
  if (!isConfigured()) return notConfigured();
  try {
    const panelColors = new Map<number, RGBColor>();
    for (const panel of panels) {
      panelColors.set(panel.panelId, { r: panel.r, g: panel.g, b: panel.b });
    }
    await nanoleafClient!.setPanelColors(panelColors);
    return ok(`Set colors for ${panels.length} panels`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_solid_color", {
  title: "Set Solid Color",
  description: "Set all panels to the same color using RGB values",
  inputSchema: z.object({
    r: z.number().min(0).max(255).describe("Red value (0-255)"),
    g: z.number().min(0).max(255).describe("Green value (0-255)"),
    b: z.number().min(0).max(255).describe("Blue value (0-255)"),
  }),
}, async ({ r, g, b }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.setColor({ r, g, b });
    return ok(`All panels set to RGB(${r}, ${g}, ${b})`);
  } catch (e) {
    return err(e);
  }
});

// ============================================
// STREAMING TOOLS
// ============================================

server.registerTool("start_streaming", {
  title: "Start Streaming",
  description:
    "Initialize UDP streaming mode for real-time color updates. This enables low-latency per-panel control.",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.initializeStreaming();
    return ok("Streaming mode initialized. Use stream_colors or stream_solid_color for real-time updates.");
  } catch (e) {
    return err(e);
  }
});

server.registerTool("stream_solid_color", {
  title: "Stream Solid Color",
  description:
    "Stream a solid color to all panels using UDP (requires streaming mode)",
  inputSchema: z.object({
    r: z.number().min(0).max(255).describe("Red value (0-255)"),
    g: z.number().min(0).max(255).describe("Green value (0-255)"),
    b: z.number().min(0).max(255).describe("Blue value (0-255)"),
  }),
}, async ({ r, g, b }) => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.streamSolidColor({ r, g, b });
    return ok(`Streamed RGB(${r}, ${g}, ${b}) to all panels`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("stream_panel_colors", {
  title: "Stream Panel Colors",
  description:
    "Stream colors to individual panels using UDP (requires streaming mode)",
  inputSchema: z.object({
    panels: z
      .array(
        z.object({
          panelId: z.number().describe("The panel ID"),
          r: z.number().min(0).max(255).describe("Red (0-255)"),
          g: z.number().min(0).max(255).describe("Green (0-255)"),
          b: z.number().min(0).max(255).describe("Blue (0-255)"),
        })
      )
      .describe("Array of panel colors"),
  }),
}, async ({ panels }) => {
  if (!isConfigured()) return notConfigured();
  try {
    const panelColors = new Map<number, RGBColor>();
    for (const panel of panels) {
      panelColors.set(panel.panelId, { r: panel.r, g: panel.g, b: panel.b });
    }
    await nanoleafClient!.streamColors(panelColors);
    return ok(`Streamed colors to ${panels.length} panels`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("stop_streaming", {
  title: "Stop Streaming",
  description: "Stop UDP streaming mode and close the socket",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.stopStreaming();
    return ok("Streaming mode stopped");
  } catch (e) {
    return err(e);
  }
});

// ============================================
// UTILITY TOOLS
// ============================================

server.registerTool("identify", {
  title: "Identify",
  description: "Flash the Nanoleaf device to help identify it",
}, async () => {
  if (!isConfigured()) return notConfigured();
  try {
    await nanoleafClient!.identify();
    return ok("Device is flashing to identify itself");
  } catch (e) {
    return err(e);
  }
});

// ============================================
// DISCOVERY & SETUP TOOLS
// ============================================

server.registerTool("discover_devices", {
  title: "Discover Devices",
  description:
    "Discover Nanoleaf devices on the local network using mDNS (recommended) or network scan",
  inputSchema: z.object({
    method: z
      .enum(["mdns", "scan"])
      .optional()
      .describe("Discovery method: 'mdns' (recommended, default) or 'scan' (slower, scans IP range)"),
    subnet: z
      .string()
      .optional()
      .describe("For scan method: subnet to scan (e.g., '192.168.1'). Default: 192.168.1"),
  }),
}, async ({ method = "mdns", subnet }) => {
  try {
    if (method === "mdns") {
      const devices = await discoverDevicesMdns();
      if (devices.length === 0) {
        return ok(
          "No Nanoleaf devices found via mDNS. Make sure your device is powered on and connected to the same network. You can also try the 'scan' method."
        );
      }
      return ok(
        `Found ${devices.length} Nanoleaf device(s):\n\n${JSON.stringify(devices, null, 2)}\n\nUse the IP address with create_auth_token to authenticate.`
      );
    } else {
      const devices = await discoverDevicesScan(subnet);
      if (devices.length === 0) {
        return ok(
          `No Nanoleaf devices found on subnet ${subnet || "192.168.1"}. Try a different subnet or use mDNS method.`
        );
      }
      return ok(
        `Found ${devices.length} Nanoleaf device(s):\n\n${JSON.stringify(devices, null, 2)}\n\nUse the IP address with create_auth_token to authenticate.`
      );
    }
  } catch (e) {
    return err(e);
  }
});

server.registerTool("create_auth_token", {
  title: "Create Auth Token",
  description:
    "Create a new auth token for a Nanoleaf device. IMPORTANT: Hold the power button on the device for 5-7 seconds until the LED starts flashing, then call this within 30 seconds!",
  inputSchema: z.object({
    ip: z.string().describe("The IP address of the Nanoleaf device"),
  }),
}, async ({ ip }) => {
  try {
    const authToken = await NanoleafClient.createAuthToken(ip);
    return ok(
      `Auth token created successfully!\n\nYour new auth token: ${authToken}\n\nSet these environment variables:\n  NANOLEAF_IP=${ip}\n  NANOLEAF_AUTH_TOKEN=${authToken}`
    );
  } catch (e: any) {
    if (e.response?.status === 403) {
      return ok(
        "Pairing mode not active!\n\nPlease:\n1. Hold the power button on your Nanoleaf for 5-7 seconds\n2. Wait until the LED starts flashing\n3. Run this tool again within 30 seconds"
      );
    }
    return err(e);
  }
});

server.registerTool("test_connection", {
  title: "Test Connection",
  description: "Test the connection to the Nanoleaf device with current credentials",
}, async () => {
  if (!NANOLEAF_IP || !NANOLEAF_AUTH_TOKEN) {
    return ok(
      `Not configured!\n\nMissing environment variables:\n${!NANOLEAF_IP ? "- NANOLEAF_IP\n" : ""}${!NANOLEAF_AUTH_TOKEN ? "- NANOLEAF_AUTH_TOKEN\n" : ""}\nUse discover_devices and create_auth_token to set up.`
    );
  }
  try {
    const info = await nanoleafClient!.getInfo();
    const layout = await nanoleafClient!.getPanelLayout();
    return ok(
      `Connection successful!\n\nDevice: ${info.name}\nModel: ${info.model}\nFirmware: ${info.firmwareVersion}\nPanels: ${layout.numPanels}\nPower: ${info.state.on.value ? "On" : "Off"}\nBrightness: ${info.state.brightness.value}%`
    );
  } catch (e) {
    return err(e);
  }
});

// ============================================
// SERVER
// ============================================

const transports: Record<string, StreamableHTTPServerTransport> = {};

async function main() {
  const app = createMcpExpressApp({ host: "0.0.0.0" });

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

  app.listen(PORT, () => {
    console.log(`Nanoleaf MCP server running on http://0.0.0.0:${PORT}/mcp`);
    if (isConfigured()) {
      console.log(`Connected to Nanoleaf at ${NANOLEAF_IP}`);
    } else {
      console.log(
        "Not configured. Set NANOLEAF_IP and NANOLEAF_AUTH_TOKEN environment variables."
      );
    }
  });
}

main().catch(console.error);
