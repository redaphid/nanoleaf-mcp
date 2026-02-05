import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { colord, extend } from "colord";
import names from "colord/plugins/names";
import {
  NanoleafClient,
  discoverDevicesMdns,
  discoverDevicesScan,
  type RGBColor,
} from "./nanoleaf-client.ts";
import { DeviceManager } from "./device-manager.ts";

// Enable CSS color names support (type assertion needed due to CJS/ESM interop)
extend([names as unknown as Parameters<typeof extend>[0][number]]);

// Parse any CSS color string and convert to Nanoleaf HSB format
// Alpha channel controls brightness: rgba(255,0,0,0.5) = red at 50% brightness
function parseColor(color: string): { hue: number; saturation: number; brightness: number } | null {
  const c = colord(color);
  if (!c.isValid()) return null;
  const hsv = c.toHsv();
  return {
    hue: Math.round(hsv.h),           // 0-360
    saturation: Math.round(hsv.s),     // 0-100
    brightness: Math.round(c.alpha() * 100), // alpha → brightness 0-100
  };
}

const PORT = parseInt(process.env.PORT || "3101", 10);

// ============================================
// MULTI-DEVICE SETUP
// ============================================

const deviceManager = new DeviceManager();

const NANOLEAF_DEVICES = process.env.NANOLEAF_DEVICES;
if (NANOLEAF_DEVICES) {
  try {
    const parsed = JSON.parse(NANOLEAF_DEVICES);
    for (const d of parsed) {
      if (d.ip && d.authToken) {
        deviceManager.register(d.ip, d.authToken, d.alias);
      }
    }
  } catch (e) {
    console.error("Failed to parse NANOLEAF_DEVICES:", e);
  }
}

// Accept both string and number panel IDs, always coerce to number
const panelIdParam = (description: string) =>
  z.union([z.string(), z.number()]).transform((v) => Number(v)).describe(description);

const deviceParam = z.string().optional().describe("Device alias or IP. Optional when only one device is registered.");

const server = new McpServer({
  name: "nanoleaf-mcp",
  version: "2.1.0",
});

// Helper for tool responses
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const err = (error: any) => ({
  content: [{ type: "text" as const, text: `Error: ${error.message || error}` }],
  isError: true,
});
const json = (data: unknown) => ok(JSON.stringify(data, null, 2));

function resolveDevice(device?: string) {
  const result = deviceManager.resolve(device);
  if ("error" in result) return { error: ok(result.error) };
  return result;
}

// ============================================
// DEVICE MANAGEMENT TOOLS
// ============================================

server.registerTool("list_devices", {
  title: "List Devices",
  description: "Show all registered Nanoleaf devices with alias, IP, name, model, and power status.",
}, async () => {
  const devices = deviceManager.listAll();
  if (devices.length === 0) {
    return ok("No devices registered. Use add_device or set NANOLEAF_DEVICES env var.");
  }
  const lines: string[] = [];
  for (const d of devices) {
    let status = "unknown";
    try {
      const info = await d.client.getInfo();
      status = info.state.on.value ? "on" : "off";
    } catch {
      status = "unreachable";
    }
    lines.push(
      `${d.alias} — ${d.ip} — ${d.name || "?"} (${d.model || "?"}) — ${status}`
    );
  }
  return ok(`Registered devices:\n${lines.join("\n")}`);
});

server.registerTool("add_device", {
  title: "Add Device",
  description:
    "Register a Nanoleaf device at runtime. Verifies connection first. Alias defaults to hardware name if reachable.",
  inputSchema: z.object({
    ip: z.string().describe("IP address of the Nanoleaf device"),
    authToken: z.string().describe("Auth token for the device"),
    alias: z.string().optional().describe("Friendly name for the device. Defaults to hardware name or IP."),
  }),
}, async ({ ip, authToken, alias }) => {
  // Verify connection
  try {
    const testClient = new NanoleafClient(ip, authToken);
    const info = await testClient.getInfo();
    const finalAlias = alias || info.name || ip;
    if (deviceManager.has(finalAlias)) {
      return ok(`A device with alias "${finalAlias}" is already registered. Use a different alias.`);
    }
    const device = deviceManager.register(ip, authToken, finalAlias);
    device.name = info.name;
    device.model = info.model;
    return ok(
      `Device registered as "${device.alias}" — ${info.name} (${info.model}) at ${ip}`
    );
  } catch (e: any) {
    return err({ message: `Cannot connect to ${ip}: ${e.message || e}` });
  }
});

server.registerTool("remove_device", {
  title: "Remove Device",
  description: "Unregister a Nanoleaf device by alias.",
  inputSchema: z.object({
    alias: z.string().describe("The alias of the device to remove"),
  }),
}, async ({ alias }) => {
  if (deviceManager.remove(alias)) {
    return ok(`Device "${alias}" removed.`);
  }
  return ok(`Device "${alias}" not found.`);
});

// ============================================
// DEVICE INFO TOOLS
// ============================================

server.registerTool("get_device_info", {
  title: "Get Device Info",
  description:
    "Get detailed information about the Nanoleaf device including name, model, firmware version, and current state. Call this first to verify your connection and see device capabilities.",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    return json(await resolved.client.getInfo());
  } catch (e) {
    return err(e);
  }
});

server.registerTool("get_panel_layout", {
  title: "Get Panel Layout",
  description:
    "Get the physical layout of all panels including their positions and IDs. IMPORTANT: You need panel IDs from this response before using set_panel_colors or stream_panel_colors.",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    return json(await resolved.client.getPanelLayout());
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
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.turnOn();
    return ok("Nanoleaf turned on");
  } catch (e) {
    return err(e);
  }
});

server.registerTool("turn_off", {
  title: "Turn Off",
  description: "Turn off the Nanoleaf device",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.turnOff();
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
  description: `Set the brightness of the Nanoleaf device without changing its color.

<example>Set to full brightness: brightness=100</example>
<example>Set to 50% brightness: brightness=50</example>
<example>Set to dim (25%): brightness=25</example>
<example>Set to very dim (10%): brightness=10</example>`,
  inputSchema: z.object({
    device: deviceParam,
    brightness: z.coerce
      .number()
      .min(0)
      .max(100)
      .describe("Brightness value (0-100). <example>100</example> <example>50</example> <example>25</example>"),
  }),
}, async ({ device, brightness }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.setBrightness(brightness);
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
  description: `Set the hue of the Nanoleaf device (0-360 degrees on the color wheel).

<example>Set to red: hue=0</example>
<example>Set to green: hue=120</example>
<example>Set to blue: hue=240</example>
<example>Set to yellow: hue=60</example>`,
  inputSchema: z.object({
    device: deviceParam,
    hue: z.coerce
      .number()
      .min(0)
      .max(360)
      .describe("Hue value (0-360, where 0=red, 120=green, 240=blue). <example>0</example> <example>120</example> <example>240</example>"),
  }),
}, async ({ device, hue }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.setHue(hue);
    return ok(`Hue set to ${hue}`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_saturation", {
  title: "Set Saturation",
  description: `Set the saturation of the Nanoleaf device (0-100).

<example>Set full color saturation: saturation=100</example>
<example>Set pastel (50%): saturation=50</example>
<example>Set near-white: saturation=10</example>`,
  inputSchema: z.object({
    device: deviceParam,
    saturation: z.coerce
      .number()
      .min(0)
      .max(100)
      .describe("Saturation value (0=white, 100=full color). <example>100</example> <example>50</example> <example>0</example>"),
  }),
}, async ({ device, saturation }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.setSaturation(saturation);
    return ok(`Saturation set to ${saturation}%`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_color", {
  title: "Set Color",
  description: `Set the color of the Nanoleaf device using any CSS color string. This is the easiest way to set a color.

Accepts any CSS color format: named colors, hex, rgb(), hsl(), etc. The alpha channel (0-1) controls brightness — use rgba() or hsla() to set both color and brightness at once.

<example>Set to red at full brightness: color="red"</example>
<example>Set to blue: color="#0000ff"</example>
<example>Set to green at 50% brightness: color="rgba(0,255,0,0.5)"</example>
<example>Set to purple at 25% brightness: color="rgba(128,0,128,0.25)"</example>
<example>Set to warm orange: color="rgb(255,165,0)"</example>
<example>Set to cyan at 75% brightness: color="hsla(180,100%,50%,0.75)"</example>
<example>Set to pink: color="pink"</example>
<example>Set to dim red for movie night: color="rgba(255,0,0,0.2)"</example>`,
  inputSchema: z.object({
    device: deviceParam,
    color: z.string().describe('Required. Any CSS color. Use alpha (0-1) to control brightness. <example>"red"</example> <example>"#ff0000"</example> <example>"rgb(255,0,0)"</example> <example>"rgba(255,0,0,0.5)"</example> <example>"hsl(0,100%,50%)"</example> <example>"hsla(240,100%,50%,0.75)"</example> <example>"pink"</example>'),
  }),
}, async ({ device, color }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  const parsed = parseColor(color);
  if (!parsed) return err({ message: `Invalid color: "${color}". Use CSS colors like "red", "#ff0000", "rgb(255,0,0)", or "hsl(0,100%,50%)"` });
  try {
    await resolved.client.setState({
      on: true,
      hue: parsed.hue,
      saturation: parsed.saturation,
      brightness: parsed.brightness,
    });
    return ok(`Color set to ${color}`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_color_rgb", {
  title: "Set Color RGB",
  description: `Set the color using explicit RGB values (0-255 for each channel). Prefer set_color with CSS color strings for simpler usage.

<example>Set to red: r=255, g=0, b=0</example>
<example>Set to green: r=0, g=255, b=0</example>
<example>Set to white: r=255, g=255, b=255</example>`,
  inputSchema: z.object({
    device: deviceParam,
    r: z.coerce.number().min(0).max(255).describe("Red value (0-255). <example>255</example> <example>0</example>"),
    g: z.coerce.number().min(0).max(255).describe("Green value (0-255). <example>255</example> <example>0</example>"),
    b: z.coerce.number().min(0).max(255).describe("Blue value (0-255). <example>255</example> <example>0</example>"),
  }),
}, async ({ device, r, g, b }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.setColor({ r, g, b });
    return ok(`Color set to RGB(${r}, ${g}, ${b})`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_color_temperature", {
  title: "Set Color Temperature",
  description: `Set the color temperature in Kelvin (1200-6500).

<example>Set warm candlelight: ct=1200</example>
<example>Set soft warm white: ct=2700</example>
<example>Set neutral white: ct=4000</example>
<example>Set cool daylight: ct=6500</example>`,
  inputSchema: z.object({
    device: deviceParam,
    ct: z.coerce
      .number()
      .min(1200)
      .max(6500)
      .describe("Color temperature in Kelvin (1200=warm candlelight, 6500=cool daylight). <example>1200</example> <example>2700</example> <example>4000</example> <example>6500</example>"),
  }),
}, async ({ device, ct }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.setColorTemperature(ct);
    return ok(`Color temperature set to ${ct}K`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_state", {
  title: "Set State",
  description: `Set multiple properties at once. Use this for advanced control when you need to change several settings simultaneously.

You can pass a CSS color string via the "color" parameter, or use explicit hue/saturation values. Explicit parameters override parsed color values.

<example>Turn on and set to red: on=true, color="red"</example>
<example>Set warm dim scene: color="rgba(255,180,100,0.3)"</example>
<example>Set brightness and color temp: brightness=80, ct=2700</example>
<example>Turn on at full brightness: on=true, brightness=100</example>`,
  inputSchema: z.object({
    device: deviceParam,
    on: z.boolean().optional().describe("Turn device on or off"),
    color: z.string().optional().describe('Optional CSS color. Alpha controls brightness. <example>"red"</example> <example>"rgba(255,0,0,0.5)"</example>'),
    brightness: z.coerce.number().min(0).max(100).optional().describe("Brightness (0-100). Overrides alpha from color if both provided."),
    hue: z.coerce.number().min(0).max(360).optional().describe("Hue (0-360). Overrides hue from color if both provided."),
    saturation: z.coerce.number().min(0).max(100).optional().describe("Saturation (0-100). Overrides saturation from color if both provided."),
    ct: z.coerce.number().min(1200).max(6500).optional().describe("Color temperature in Kelvin. <example>2700</example> <example>6500</example>"),
  }),
}, async ({ device, on, color, brightness, hue, saturation, ct }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    // Start with parsed CSS color if provided
    let parsedHue = hue;
    let parsedSat = saturation;
    let parsedBri = brightness;
    if (color) {
      const parsed = parseColor(color);
      if (!parsed) return err({ message: `Invalid color: "${color}"` });
      if (parsedHue === undefined) parsedHue = parsed.hue;
      if (parsedSat === undefined) parsedSat = parsed.saturation;
      if (parsedBri === undefined) parsedBri = parsed.brightness;
    }
    await resolved.client.setState({
      on,
      brightness: parsedBri,
      hue: parsedHue,
      saturation: parsedSat,
      ct,
    });
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
  description: "Get a list of all available effects on the device. Call this first to get effect names before using set_effect.",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    const effects = await resolved.client.listEffects();
    return ok(`Available effects:\n${effects.join("\n")}`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("get_current_effect", {
  title: "Get Current Effect",
  description: "Get the name of the currently active effect",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    const effect = await resolved.client.getCurrentEffect();
    return ok(`Current effect: ${effect}`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_effect", {
  title: "Set Effect",
  description: `Activate a specific effect by name. Get available effect names from list_effects first.

<example>Activate an effect: effectName="Northern Lights"</example>
<example>Activate an effect: effectName="Flames"</example>`,
  inputSchema: z.object({
    device: deviceParam,
    effectName: z.string().describe('The name of the effect to activate. Get names from list_effects. <example>"Northern Lights"</example> <example>"Flames"</example>'),
  }),
}, async ({ device, effectName }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.setEffect(effectName);
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
  description: `Set colors for individual panels. Get panel IDs from get_panel_layout first.

<example>Set panel 1 to red and panel 2 to blue: panels=[{panelId: 1, r: 255, g: 0, b: 0}, {panelId: 2, r: 0, g: 0, b: 255}]</example>`,
  inputSchema: z.object({
    device: deviceParam,
    panels: z
      .array(
        z.object({
          panelId: panelIdParam("The panel ID from get_panel_layout"),
          r: z.coerce.number().min(0).max(255).describe("Red (0-255)"),
          g: z.coerce.number().min(0).max(255).describe("Green (0-255)"),
          b: z.coerce.number().min(0).max(255).describe("Blue (0-255)"),
        })
      )
      .describe("Array of panel colors"),
  }),
}, async ({ device, panels }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    const panelColors = new Map<number, RGBColor>();
    for (const panel of panels) {
      panelColors.set(panel.panelId, { r: panel.r, g: panel.g, b: panel.b });
    }
    await resolved.client.setPanelColors(panelColors);
    return ok(`Set colors for ${panels.length} panels`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("set_solid_color", {
  title: "Set Solid Color",
  description: `Set all panels to the same color using RGB values. Prefer set_color with CSS color strings for simpler usage.

<example>Set all panels to red: r=255, g=0, b=0</example>
<example>Set all panels to warm white: r=255, g=244, b=229</example>`,
  inputSchema: z.object({
    device: deviceParam,
    r: z.coerce.number().min(0).max(255).describe("Red value (0-255). <example>255</example> <example>0</example>"),
    g: z.coerce.number().min(0).max(255).describe("Green value (0-255). <example>255</example> <example>0</example>"),
    b: z.coerce.number().min(0).max(255).describe("Blue value (0-255). <example>255</example> <example>0</example>"),
  }),
}, async ({ device, r, g, b }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.setColor({ r, g, b });
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
    "Initialize UDP streaming mode for real-time color updates. This enables low-latency per-panel control. Call this before using stream_solid_color or stream_panel_colors.",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.initializeStreaming();
    return ok("Streaming mode initialized. Use stream_panel_colors or stream_solid_color for real-time updates.");
  } catch (e) {
    return err(e);
  }
});

server.registerTool("stream_solid_color", {
  title: "Stream Solid Color",
  description: `Stream a solid color to all panels using UDP (requires streaming mode via start_streaming).

<example>Stream red: r=255, g=0, b=0</example>
<example>Stream blue: r=0, g=0, b=255</example>`,
  inputSchema: z.object({
    device: deviceParam,
    r: z.coerce.number().min(0).max(255).describe("Red value (0-255)"),
    g: z.coerce.number().min(0).max(255).describe("Green value (0-255)"),
    b: z.coerce.number().min(0).max(255).describe("Blue value (0-255)"),
  }),
}, async ({ device, r, g, b }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.streamSolidColor({ r, g, b });
    return ok(`Streamed RGB(${r}, ${g}, ${b}) to all panels`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("stream_panel_colors", {
  title: "Stream Panel Colors",
  description: `Stream colors to individual panels using UDP (requires streaming mode via start_streaming). Get panel IDs from get_panel_layout first.

<example>Stream red to panel 1: panels=[{panelId: 1, r: 255, g: 0, b: 0}]</example>`,
  inputSchema: z.object({
    device: deviceParam,
    panels: z
      .array(
        z.object({
          panelId: panelIdParam("The panel ID from get_panel_layout"),
          r: z.coerce.number().min(0).max(255).describe("Red (0-255)"),
          g: z.coerce.number().min(0).max(255).describe("Green (0-255)"),
          b: z.coerce.number().min(0).max(255).describe("Blue (0-255)"),
        })
      )
      .describe("Array of panel colors"),
  }),
}, async ({ device, panels }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    const panelColors = new Map<number, RGBColor>();
    for (const panel of panels) {
      panelColors.set(panel.panelId, { r: panel.r, g: panel.g, b: panel.b });
    }
    await resolved.client.streamColors(panelColors);
    return ok(`Streamed colors to ${panels.length} panels`);
  } catch (e) {
    return err(e);
  }
});

server.registerTool("stop_streaming", {
  title: "Stop Streaming",
  description: "Stop UDP streaming mode and close the socket",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.stopStreaming();
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
  description: "Flash the Nanoleaf device to help identify it physically",
  inputSchema: z.object({ device: deviceParam }),
}, async ({ device }) => {
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    await resolved.client.identify();
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
    "Discover Nanoleaf devices on the local network using mDNS (recommended) or network scan. Use the IP address from the results with create_auth_token to authenticate.",
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
        `Found ${devices.length} Nanoleaf device(s):\n\n${JSON.stringify(devices, null, 2)}\n\nUse the IP address with create_auth_token to authenticate, then add_device to register.`
      );
    } else {
      const devices = await discoverDevicesScan(subnet);
      if (devices.length === 0) {
        return ok(
          `No Nanoleaf devices found on subnet ${subnet || "192.168.1"}. Try a different subnet or use mDNS method.`
        );
      }
      return ok(
        `Found ${devices.length} Nanoleaf device(s):\n\n${JSON.stringify(devices, null, 2)}\n\nUse the IP address with create_auth_token to authenticate, then add_device to register.`
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
      `Auth token created successfully!\n\nYour new auth token: ${authToken}\n\nTo use this device:\n  1. Call add_device with ip="${ip}" and authToken="${authToken}"\n  2. Or add to NANOLEAF_DEVICES env var:\n     [{"ip":"${ip}","authToken":"${authToken}","alias":"my-light"}]`
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
  description: "Test the connection to a Nanoleaf device. Specify a registered device by alias, or provide raw ip + authToken to test an unregistered device.",
  inputSchema: z.object({
    device: deviceParam,
    ip: z.string().optional().describe("IP address to test (for unregistered devices)"),
    authToken: z.string().optional().describe("Auth token to test (for unregistered devices)"),
  }),
}, async ({ device, ip, authToken }) => {
  // If raw ip+authToken provided, test that directly
  if (ip && authToken) {
    try {
      const testClient = new NanoleafClient(ip, authToken);
      const info = await testClient.getInfo();
      const layout = await testClient.getPanelLayout();
      return ok(
        `Connection successful!\n\nDevice: ${info.name}\nModel: ${info.model}\nFirmware: ${info.firmwareVersion}\nPanels: ${layout.numPanels}\nPower: ${info.state.on.value ? "On" : "Off"}\nBrightness: ${info.state.brightness.value}%\n\nUse add_device to register this device.`
      );
    } catch (e) {
      return err(e);
    }
  }

  // Otherwise resolve a registered device
  const resolved = resolveDevice(device);
  if ("error" in resolved) return resolved.error;
  try {
    const info = await resolved.client.getInfo();
    const layout = await resolved.client.getPanelLayout();
    return ok(
      `Connection successful!\n\nAlias: ${resolved.device.alias}\nDevice: ${info.name}\nModel: ${info.model}\nFirmware: ${info.firmwareVersion}\nPanels: ${layout.numPanels}\nPower: ${info.state.on.value ? "On" : "Off"}\nBrightness: ${info.state.brightness.value}%`
    );
  } catch (e) {
    return err(e);
  }
});

// ============================================
// START
// ============================================

async function main() {
  // Fetch hardware names for devices loaded from env
  if (deviceManager.size > 0) {
    await deviceManager.refreshNames();
  }

  if (process.argv.includes("--stdio")) {
    const { startStdio } = await import("./stdio.ts");
    await startStdio(server);
  } else {
    const { startHttp } = await import("./http.ts");
    await startHttp(server, deviceManager, parseColor, PORT);
  }
}

main().catch(console.error);
