import { Router, json, type Request, type Response } from "express";
import { DeviceManager } from "./device-manager.ts";
import {
  NanoleafClient,
  discoverDevicesMdns,
  discoverDevicesScan,
  type RGBColor,
} from "./nanoleaf-client.ts";

type ParseColor = (
  color: string
) => { hue: number; saturation: number; brightness: number } | null;

export function createRestApi(
  deviceManager: DeviceManager,
  parseColor: ParseColor
): Router {
  const router = Router();
  router.use(json());

  function resolve(req: Request, res: Response) {
    const device = req.query.device as string | undefined;
    const result = deviceManager.resolve(device);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return null;
    }
    return result;
  }

  // Fire-and-forget: dispatch device command without waiting, log errors to stderr
  function fire(promise: Promise<unknown>) {
    promise.catch((e: any) => console.error("[nanoleaf]", e.message || e));
  }

  // ==========================================
  // DEVICE MANAGEMENT
  // ==========================================

  router.get("/devices", async (_req, res) => {
    const devices = deviceManager.listAll();
    const results = [];
    for (const d of devices) {
      let status = "unknown";
      try {
        const info = await d.client.getInfo();
        status = info.state.on.value ? "on" : "off";
      } catch {
        status = "unreachable";
      }
      results.push({
        alias: d.alias,
        ip: d.ip,
        name: d.name || null,
        model: d.model || null,
        status,
      });
    }
    res.json({ devices: results });
  });

  router.post("/devices", async (req, res) => {
    const { ip, authToken, alias } = req.body ?? {};
    if (!ip || !authToken) {
      res.status(400).json({ error: "ip and authToken are required" });
      return;
    }
    try {
      const testClient = new NanoleafClient(ip, authToken);
      const info = await testClient.getInfo();
      const finalAlias = alias || info.name || ip;
      if (deviceManager.has(finalAlias)) {
        res.status(409).json({ error: `Device "${finalAlias}" already registered` });
        return;
      }
      const device = deviceManager.register(ip, authToken, finalAlias);
      device.name = info.name;
      device.model = info.model;
      res.status(201).json({
        alias: device.alias,
        ip,
        name: info.name,
        model: info.model,
      });
    } catch (e: any) {
      res.status(502).json({ error: `Cannot connect to ${ip}: ${e.message || e}` });
    }
  });

  router.delete("/devices/:alias", async (req, res) => {
    const { alias } = req.params;
    if (deviceManager.remove(alias)) {
      res.json({ message: `Device "${alias}" removed` });
    } else {
      res.status(404).json({ error: `Device "${alias}" not found` });
    }
  });

  // ==========================================
  // DEVICE INFO
  // ==========================================

  router.get("/device", async (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    try {
      res.json(await r.client.getInfo());
    } catch (e: any) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  router.get("/device/panels", async (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    try {
      res.json(await r.client.getPanelLayout());
    } catch (e: any) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  // ==========================================
  // POWER CONTROL
  // ==========================================

  router.post("/device/on", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    fire(r.client.turnOn());
    res.status(202).json({ message: "Device turning on" });
  });

  router.post("/device/off", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    fire(r.client.turnOff());
    res.status(202).json({ message: "Device turning off" });
  });

  // ==========================================
  // BRIGHTNESS & COLOR
  // ==========================================

  router.put("/device/brightness", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { brightness } = req.body ?? {};
    if (brightness === undefined) {
      res.status(400).json({ error: "brightness is required (0-100)" });
      return;
    }
    fire(r.client.setBrightness(Number(brightness)));
    res.status(202).json({ message: `Brightness set to ${brightness}%` });
  });

  router.put("/device/hue", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { hue } = req.body ?? {};
    if (hue === undefined) {
      res.status(400).json({ error: "hue is required (0-360)" });
      return;
    }
    fire(r.client.setHue(Number(hue)));
    res.status(202).json({ message: `Hue set to ${hue}` });
  });

  router.put("/device/saturation", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { saturation } = req.body ?? {};
    if (saturation === undefined) {
      res.status(400).json({ error: "saturation is required (0-100)" });
      return;
    }
    fire(r.client.setSaturation(Number(saturation)));
    res.status(202).json({ message: `Saturation set to ${saturation}%` });
  });

  router.put("/device/color", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { color } = req.body ?? {};
    if (!color) {
      res.status(400).json({ error: "color is required (any CSS color string)" });
      return;
    }
    const parsed = parseColor(color);
    if (!parsed) {
      res.status(400).json({ error: `Invalid color: "${color}"` });
      return;
    }
    fire(r.client.setState({
      on: true,
      hue: parsed.hue,
      saturation: parsed.saturation,
      brightness: parsed.brightness,
    }));
    res.status(202).json({ message: `Color set to ${color}` });
  });

  router.put("/device/color/rgb", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { r: red, g, b } = req.body ?? {};
    if (red === undefined || g === undefined || b === undefined) {
      res.status(400).json({ error: "r, g, and b are required (0-255)" });
      return;
    }
    fire(r.client.setColor({ r: Number(red), g: Number(g), b: Number(b) }));
    res.status(202).json({ message: `Color set to RGB(${red}, ${g}, ${b})` });
  });

  router.put("/device/color/temperature", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { ct } = req.body ?? {};
    if (ct === undefined) {
      res.status(400).json({ error: "ct is required (1200-6500)" });
      return;
    }
    fire(r.client.setColorTemperature(Number(ct)));
    res.status(202).json({ message: `Color temperature set to ${ct}K` });
  });

  router.put("/device/state", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { on, color, brightness, hue, saturation, ct } = req.body ?? {};
    let parsedHue = hue !== undefined ? Number(hue) : undefined;
    let parsedSat = saturation !== undefined ? Number(saturation) : undefined;
    let parsedBri = brightness !== undefined ? Number(brightness) : undefined;
    if (color) {
      const parsed = parseColor(color);
      if (!parsed) {
        res.status(400).json({ error: `Invalid color: "${color}"` });
        return;
      }
      if (parsedHue === undefined) parsedHue = parsed.hue;
      if (parsedSat === undefined) parsedSat = parsed.saturation;
      if (parsedBri === undefined) parsedBri = parsed.brightness;
    }
    fire(r.client.setState({
      on,
      brightness: parsedBri,
      hue: parsedHue,
      saturation: parsedSat,
      ct: ct !== undefined ? Number(ct) : undefined,
    }));
    res.status(202).json({ message: "State updated" });
  });

  // ==========================================
  // EFFECTS
  // ==========================================

  router.get("/device/effects", async (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    try {
      res.json({ effects: await r.client.listEffects() });
    } catch (e: any) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  router.get("/device/effects/current", async (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    try {
      res.json({ effect: await r.client.getCurrentEffect() });
    } catch (e: any) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  router.put("/device/effects", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { effectName } = req.body ?? {};
    if (!effectName) {
      res.status(400).json({ error: "effectName is required" });
      return;
    }
    fire(r.client.setEffect(effectName));
    res.status(202).json({ message: `Effect "${effectName}" activated` });
  });

  // ==========================================
  // PANEL CONTROL
  // ==========================================

  router.put("/device/panels/colors", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { panels } = req.body ?? {};
    if (!Array.isArray(panels) || panels.length === 0) {
      res.status(400).json({ error: "panels array is required" });
      return;
    }
    const panelColors = new Map<number, RGBColor>();
    for (const p of panels) {
      panelColors.set(Number(p.panelId), {
        r: Number(p.r),
        g: Number(p.g),
        b: Number(p.b),
      });
    }
    fire(r.client.setPanelColors(panelColors));
    res.status(202).json({ message: `Set colors for ${panels.length} panels` });
  });

  router.put("/device/panels/solid", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { r: red, g, b } = req.body ?? {};
    if (red === undefined || g === undefined || b === undefined) {
      res.status(400).json({ error: "r, g, and b are required (0-255)" });
      return;
    }
    fire(r.client.setColor({ r: Number(red), g: Number(g), b: Number(b) }));
    res.status(202).json({ message: `All panels set to RGB(${red}, ${g}, ${b})` });
  });

  // ==========================================
  // STREAMING
  // ==========================================

  router.post("/device/streaming/start", async (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    try {
      await r.client.initializeStreaming();
      res.json({ message: "Streaming mode initialized" });
    } catch (e: any) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  router.post("/device/streaming/stop", async (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    try {
      await r.client.stopStreaming();
      res.json({ message: "Streaming mode stopped" });
    } catch (e: any) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  router.post("/device/streaming/solid", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { r: red, g, b } = req.body ?? {};
    if (red === undefined || g === undefined || b === undefined) {
      res.status(400).json({ error: "r, g, and b are required (0-255)" });
      return;
    }
    fire(r.client.streamSolidColor({
      r: Number(red),
      g: Number(g),
      b: Number(b),
    }));
    res.status(202).json({ message: `Streamed RGB(${red}, ${g}, ${b}) to all panels` });
  });

  router.post("/device/streaming/panels", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    const { panels } = req.body ?? {};
    if (!Array.isArray(panels) || panels.length === 0) {
      res.status(400).json({ error: "panels array is required" });
      return;
    }
    const panelColors = new Map<number, RGBColor>();
    for (const p of panels) {
      panelColors.set(Number(p.panelId), {
        r: Number(p.r),
        g: Number(p.g),
        b: Number(p.b),
      });
    }
    fire(r.client.streamColors(panelColors));
    res.status(202).json({ message: `Streamed colors to ${panels.length} panels` });
  });

  // ==========================================
  // UTILITY
  // ==========================================

  router.post("/device/identify", (req, res) => {
    const r = resolve(req, res);
    if (!r) return;
    fire(r.client.identify());
    res.status(202).json({ message: "Device is flashing to identify itself" });
  });

  // ==========================================
  // DISCOVERY & SETUP
  // ==========================================

  router.post("/discover", async (req, res) => {
    const { method = "mdns", subnet } = req.body ?? {};
    try {
      if (method === "scan") {
        res.json({ devices: await discoverDevicesScan(subnet) });
      } else {
        res.json({ devices: await discoverDevicesMdns() });
      }
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  });

  router.post("/auth-token", async (req, res) => {
    const { ip } = req.body ?? {};
    if (!ip) {
      res.status(400).json({ error: "ip is required" });
      return;
    }
    try {
      const authToken = await NanoleafClient.createAuthToken(ip);
      res.json({ authToken });
    } catch (e: any) {
      if (e.response?.status === 403) {
        res
          .status(403)
          .json({ error: "Pairing mode not active. Hold the power button for 5-7 seconds, then retry." });
        return;
      }
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  router.post("/test-connection", async (req, res) => {
    const { device, ip, authToken } = req.body ?? {};
    if (ip && authToken) {
      try {
        const client = new NanoleafClient(ip, authToken);
        const info = await client.getInfo();
        const layout = await client.getPanelLayout();
        res.json({
          name: info.name,
          model: info.model,
          firmwareVersion: info.firmwareVersion,
          panels: layout.numPanels,
          power: info.state.on.value ? "on" : "off",
          brightness: info.state.brightness.value,
        });
      } catch (e: any) {
        res.status(502).json({ error: e.message || String(e) });
      }
      return;
    }
    const result = deviceManager.resolve(device);
    if ("error" in result) {
      res.status(400).json({ error: result.error });
      return;
    }
    try {
      const info = await result.client.getInfo();
      const layout = await result.client.getPanelLayout();
      res.json({
        alias: result.device.alias,
        name: info.name,
        model: info.model,
        firmwareVersion: info.firmwareVersion,
        panels: layout.numPanels,
        power: info.state.on.value ? "on" : "off",
        brightness: info.state.brightness.value,
      });
    } catch (e: any) {
      res.status(502).json({ error: e.message || String(e) });
    }
  });

  // ==========================================
  // OPENAPI SPEC & DOCS
  // ==========================================

  router.get("/openapi.json", (_req, res) => {
    res.json(openApiSpec);
  });

  router.get("/docs", (_req, res) => {
    res.type("html").send(SWAGGER_HTML);
  });

  return router;
}

// ==========================================
// OpenAPI 3.1 Specification
// ==========================================

const deviceQuery = {
  name: "device",
  in: "query",
  required: false,
  schema: { type: "string" },
  description: "Device alias or IP. Optional when only one device is registered.",
};

const errRef = { $ref: "#/components/schemas/Error" };
const msgRef = { $ref: "#/components/schemas/Message" };
const err400 = { description: "Bad request", content: { "application/json": { schema: errRef } } };
const err502 = { description: "Device unreachable", content: { "application/json": { schema: errRef } } };
const okMsg = { description: "Success", content: { "application/json": { schema: msgRef } } };
const accepted = { description: "Accepted (fire-and-forget)", content: { "application/json": { schema: msgRef } } };

const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "Nanoleaf REST API",
    version: "2.1.0",
    description:
      "REST API for controlling Nanoleaf light panels. Mirrors all capabilities of the MCP server.",
  },
  servers: [{ url: "/api" }],
  tags: [
    { name: "Devices", description: "Device registration and listing" },
    { name: "Info", description: "Device information and panel layout" },
    { name: "Power", description: "Power on/off control" },
    { name: "Color", description: "Brightness, hue, saturation, color, and color temperature" },
    { name: "State", description: "Set multiple properties at once" },
    { name: "Effects", description: "List and activate effects" },
    { name: "Panels", description: "Per-panel color control" },
    { name: "Streaming", description: "Low-latency UDP streaming mode" },
    { name: "Utility", description: "Identify device" },
    { name: "Discovery", description: "Network discovery and auth token creation" },
  ],
  components: {
    parameters: { DeviceQuery: deviceQuery },
    schemas: {
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
        required: ["error"],
      },
      Message: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      RGBColor: {
        type: "object",
        required: ["r", "g", "b"],
        properties: {
          r: { type: "integer", minimum: 0, maximum: 255 },
          g: { type: "integer", minimum: 0, maximum: 255 },
          b: { type: "integer", minimum: 0, maximum: 255 },
        },
      },
      PanelColor: {
        type: "object",
        required: ["panelId", "r", "g", "b"],
        properties: {
          panelId: { type: "integer", description: "Panel ID from GET /device/panels" },
          r: { type: "integer", minimum: 0, maximum: 255 },
          g: { type: "integer", minimum: 0, maximum: 255 },
          b: { type: "integer", minimum: 0, maximum: 255 },
        },
      },
      DeviceSummary: {
        type: "object",
        properties: {
          alias: { type: "string" },
          ip: { type: "string" },
          name: { type: ["string", "null"] },
          model: { type: ["string", "null"] },
          status: { type: "string", enum: ["on", "off", "unreachable", "unknown"] },
        },
      },
    },
  },
  paths: {
    // ---------- Devices ----------
    "/devices": {
      get: {
        tags: ["Devices"],
        summary: "List registered devices",
        operationId: "listDevices",
        responses: {
          "200": {
            description: "Device list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    devices: { type: "array", items: { $ref: "#/components/schemas/DeviceSummary" } },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        tags: ["Devices"],
        summary: "Register a new device",
        operationId: "addDevice",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ip", "authToken"],
                properties: {
                  ip: { type: "string", description: "Device IP address" },
                  authToken: { type: "string", description: "Auth token" },
                  alias: { type: "string", description: "Friendly name (defaults to hardware name)" },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Device registered",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    alias: { type: "string" },
                    ip: { type: "string" },
                    name: { type: "string" },
                    model: { type: "string" },
                  },
                },
              },
            },
          },
          "400": err400,
          "409": { description: "Alias already registered", content: { "application/json": { schema: errRef } } },
          "502": err502,
        },
      },
    },
    "/devices/{alias}": {
      delete: {
        tags: ["Devices"],
        summary: "Remove a registered device",
        operationId: "removeDevice",
        parameters: [{ name: "alias", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": okMsg,
          "404": { description: "Not found", content: { "application/json": { schema: errRef } } },
        },
      },
    },
    // ---------- Info ----------
    "/device": {
      get: {
        tags: ["Info"],
        summary: "Get device info",
        operationId: "getDeviceInfo",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: { "200": { description: "Full device info including state, effects, layout" }, "400": err400, "502": err502 },
      },
    },
    "/device/panels": {
      get: {
        tags: ["Info"],
        summary: "Get panel layout",
        operationId: "getPanelLayout",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: { "200": { description: "Panel positions and IDs" }, "400": err400, "502": err502 },
      },
    },
    // ---------- Power ----------
    "/device/on": {
      post: {
        tags: ["Power"],
        summary: "Turn on",
        operationId: "turnOn",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/off": {
      post: {
        tags: ["Power"],
        summary: "Turn off",
        operationId: "turnOff",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: { "202": accepted, "400": err400 },
      },
    },
    // ---------- Color ----------
    "/device/brightness": {
      put: {
        tags: ["Color"],
        summary: "Set brightness",
        operationId: "setBrightness",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["brightness"],
                properties: { brightness: { type: "number", minimum: 0, maximum: 100 } },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/hue": {
      put: {
        tags: ["Color"],
        summary: "Set hue",
        operationId: "setHue",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["hue"],
                properties: { hue: { type: "number", minimum: 0, maximum: 360 } },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/saturation": {
      put: {
        tags: ["Color"],
        summary: "Set saturation",
        operationId: "setSaturation",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["saturation"],
                properties: { saturation: { type: "number", minimum: 0, maximum: 100 } },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/color": {
      put: {
        tags: ["Color"],
        summary: "Set color (CSS string)",
        operationId: "setColor",
        description:
          'Accepts any CSS color format: named colors, hex, rgb(), hsl(), rgba(), hsla(). Alpha channel controls brightness.',
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["color"],
                properties: {
                  color: { type: "string", examples: ["red", "#ff0000", "rgb(255,0,0)", "rgba(255,0,0,0.5)", "hsl(240,100%,50%)"] },
                },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/color/rgb": {
      put: {
        tags: ["Color"],
        summary: "Set color (RGB values)",
        operationId: "setColorRgb",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RGBColor" } } },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/color/temperature": {
      put: {
        tags: ["Color"],
        summary: "Set color temperature",
        operationId: "setColorTemperature",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["ct"],
                properties: { ct: { type: "number", minimum: 1200, maximum: 6500, description: "Color temperature in Kelvin" } },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    // ---------- State ----------
    "/device/state": {
      put: {
        tags: ["State"],
        summary: "Set multiple properties at once",
        operationId: "setState",
        description:
          "Set any combination of on/off, color, brightness, hue, saturation, color temperature. CSS color string is parsed; explicit values override parsed ones.",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  on: { type: "boolean" },
                  color: { type: "string", description: "CSS color string (alpha controls brightness)" },
                  brightness: { type: "number", minimum: 0, maximum: 100 },
                  hue: { type: "number", minimum: 0, maximum: 360 },
                  saturation: { type: "number", minimum: 0, maximum: 100 },
                  ct: { type: "number", minimum: 1200, maximum: 6500 },
                },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    // ---------- Effects ----------
    "/device/effects": {
      get: {
        tags: ["Effects"],
        summary: "List available effects",
        operationId: "listEffects",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: {
          "200": {
            description: "Effects list",
            content: {
              "application/json": {
                schema: { type: "object", properties: { effects: { type: "array", items: { type: "string" } } } },
              },
            },
          },
          "400": err400,
          "502": err502,
        },
      },
      put: {
        tags: ["Effects"],
        summary: "Activate an effect",
        operationId: "setEffect",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["effectName"], properties: { effectName: { type: "string" } } },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/effects/current": {
      get: {
        tags: ["Effects"],
        summary: "Get current effect",
        operationId: "getCurrentEffect",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: {
          "200": {
            description: "Current effect",
            content: {
              "application/json": {
                schema: { type: "object", properties: { effect: { type: "string" } } },
              },
            },
          },
          "400": err400,
          "502": err502,
        },
      },
    },
    // ---------- Panels ----------
    "/device/panels/colors": {
      put: {
        tags: ["Panels"],
        summary: "Set individual panel colors",
        operationId: "setPanelColors",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["panels"],
                properties: { panels: { type: "array", items: { $ref: "#/components/schemas/PanelColor" } } },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/panels/solid": {
      put: {
        tags: ["Panels"],
        summary: "Set all panels to one color",
        operationId: "setSolidColor",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RGBColor" } } },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    // ---------- Streaming ----------
    "/device/streaming/start": {
      post: {
        tags: ["Streaming"],
        summary: "Start UDP streaming mode",
        operationId: "startStreaming",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/streaming/stop": {
      post: {
        tags: ["Streaming"],
        summary: "Stop UDP streaming mode",
        operationId: "stopStreaming",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/streaming/solid": {
      post: {
        tags: ["Streaming"],
        summary: "Stream solid color via UDP",
        operationId: "streamSolidColor",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/RGBColor" } } },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    "/device/streaming/panels": {
      post: {
        tags: ["Streaming"],
        summary: "Stream per-panel colors via UDP",
        operationId: "streamPanelColors",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["panels"],
                properties: { panels: { type: "array", items: { $ref: "#/components/schemas/PanelColor" } } },
              },
            },
          },
        },
        responses: { "202": accepted, "400": err400 },
      },
    },
    // ---------- Utility ----------
    "/device/identify": {
      post: {
        tags: ["Utility"],
        summary: "Flash device to identify it",
        operationId: "identify",
        parameters: [{ $ref: "#/components/parameters/DeviceQuery" }],
        responses: { "202": accepted, "400": err400 },
      },
    },
    // ---------- Discovery ----------
    "/discover": {
      post: {
        tags: ["Discovery"],
        summary: "Discover Nanoleaf devices on the network",
        operationId: "discoverDevices",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  method: { type: "string", enum: ["mdns", "scan"], default: "mdns" },
                  subnet: { type: "string", description: "For scan method (e.g. '192.168.1')" },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "Discovered devices",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { devices: { type: "array", items: { type: "object" } } },
                },
              },
            },
          },
          "500": { description: "Discovery failed", content: { "application/json": { schema: errRef } } },
        },
      },
    },
    "/auth-token": {
      post: {
        tags: ["Discovery"],
        summary: "Create auth token",
        operationId: "createAuthToken",
        description: "Hold the power button on the device for 5-7 seconds until the LED flashes, then call this within 30 seconds.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["ip"], properties: { ip: { type: "string" } } },
            },
          },
        },
        responses: {
          "200": {
            description: "Token created",
            content: {
              "application/json": {
                schema: { type: "object", properties: { authToken: { type: "string" } } },
              },
            },
          },
          "400": err400,
          "403": { description: "Pairing mode not active", content: { "application/json": { schema: errRef } } },
          "502": err502,
        },
      },
    },
    "/test-connection": {
      post: {
        tags: ["Discovery"],
        summary: "Test connection to a device",
        operationId: "testConnection",
        description: "Provide device alias OR raw ip + authToken for an unregistered device.",
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  device: { type: "string", description: "Registered device alias" },
                  ip: { type: "string", description: "IP for unregistered device" },
                  authToken: { type: "string", description: "Token for unregistered device" },
                },
              },
            },
          },
        },
        responses: { "200": { description: "Connection info" }, "400": err400, "502": err502 },
      },
    },
  },
};

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nanoleaf API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css">
  <style>body{margin:0}</style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>SwaggerUIBundle({url:'./openapi.json',dom_id:'#swagger-ui',deepLinking:true})</script>
</body>
</html>`;
