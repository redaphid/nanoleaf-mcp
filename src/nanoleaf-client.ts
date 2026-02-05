import axios, { type AxiosInstance } from "axios";
import dgram from "dgram";

const NANOLEAF_PORT = 16021;
const STREAMING_PORT_V1 = 60221;
const STREAMING_PORT_V2 = 60222;

export interface NanoleafDevice {
  ip: string;
  authToken: string;
  name?: string;
}

export interface DeviceInfo {
  name: string;
  serialNo: string;
  manufacturer: string;
  firmwareVersion: string;
  hardwareVersion: string;
  model: string;
  state: {
    on: { value: boolean };
    brightness: { value: number; max: number; min: number };
    hue: { value: number; max: number; min: number };
    sat: { value: number; max: number; min: number };
    ct: { value: number; max: number; min: number };
    colorMode: string;
  };
  effects: {
    effectsList: string[];
    select: string;
  };
  panelLayout: {
    layout: {
      numPanels: number;
      sideLength: number;
      positionData: PanelPosition[];
    };
  };
  rhythm?: {
    rhythmConnected: boolean;
    rhythmActive: boolean;
  };
}

export interface PanelPosition {
  panelId: number;
  x: number;
  y: number;
  o: number;
  shapeType: number;
}

export interface PanelLayout {
  numPanels: number;
  sideLength: number;
  positions: PanelPosition[];
  bounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
    width: number;
    height: number;
  };
}

export interface RGBColor {
  r: number;
  g: number;
  b: number;
}

export interface HSBColor {
  hue: number;
  saturation: number;
  brightness: number;
}

// Plugin UUIDs for built-in animation styles
export const PLUGIN_UUIDS = {
  flow: "027842e4-e1d6-4a4c-a731-be74a1ebd4cf",
  wheel: "6970681a-20b5-4c5e-8813-bdaebc4ee4fa",
  fade: "b3fd723a-aae8-4c99-bf2b-087159e0ef53",
  highlight: "70b7c636-6bf8-491f-89c1-f4103508d642",
  random: "ba632d3e-9c2b-4413-a965-510c839b3f71",
  explode: "713518c1-d560-47db-8991-de780af71d1e",
} as const;

export type AnimationStyle = keyof typeof PLUGIN_UUIDS;
export type AnimationSpeed = "very_slow" | "slow" | "medium" | "fast" | "very_fast";
export type AnimationDirection = "left" | "right";

export interface AnimationOptions {
  name: string;
  style: AnimationStyle;
  palette: HSBColor[];
  speed?: AnimationSpeed;
  direction?: AnimationDirection;
  brightness?: number;
  loop?: boolean;
}

// Speed mappings: transTime and delayTime in tenths of a second
const SPEED_MAPPINGS: Record<AnimationSpeed, { transTime: number; delayTime: number }> = {
  very_slow: { transTime: 100, delayTime: 100 },  // 10s transitions
  slow: { transTime: 50, delayTime: 50 },          // 5s transitions
  medium: { transTime: 25, delayTime: 25 },        // 2.5s transitions
  fast: { transTime: 10, delayTime: 10 },          // 1s transitions
  very_fast: { transTime: 3, delayTime: 3 },       // 0.3s transitions
};

export class NanoleafClient {
  private ip: string;
  private authToken: string;
  private client: AxiosInstance;
  private streamingSocket: dgram.Socket | null = null;
  private protocolVersion: 1 | 2 = 2;
  private panelIds: number[] = [];
  private cachedLightPanelIds: number[] | null = null;

  constructor(ip: string, authToken: string) {
    this.ip = ip;
    this.authToken = authToken;
    this.client = axios.create({
      baseURL: `http://${ip}:${NANOLEAF_PORT}/api/v1/${authToken}`,
      timeout: 10000,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }

  static async createAuthToken(ip: string): Promise<string> {
    const response = await axios.post(
      `http://${ip}:${NANOLEAF_PORT}/api/v1/new`,
      {},
      { timeout: 10000 }
    );
    return response.data.auth_token;
  }

  static async testConnection(ip: string, authToken: string): Promise<boolean> {
    try {
      const client = new NanoleafClient(ip, authToken);
      await client.getInfo();
      return true;
    } catch {
      return false;
    }
  }

  async getInfo(): Promise<DeviceInfo> {
    const response = await this.client.get<DeviceInfo>("/");
    return response.data;
  }

  async getPanelLayout(): Promise<PanelLayout> {
    const info = await this.getInfo();
    const layout = info.panelLayout.layout;
    const positions = layout.positionData;

    if (positions.length === 0) {
      return {
        numPanels: 0,
        sideLength: layout.sideLength,
        positions: [],
        bounds: { minX: 0, maxX: 0, minY: 0, maxY: 0, width: 0, height: 0 },
      };
    }

    const xs = positions.map((p) => p.x);
    const ys = positions.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
      numPanels: layout.numPanels,
      sideLength: layout.sideLength,
      positions,
      bounds: {
        minX,
        maxX,
        minY,
        maxY,
        width: maxX - minX,
        height: maxY - minY,
      },
    };
  }

  // Get light panel IDs (cached, excludes controller panels with shapeType 12)
  private async getLightPanelIds(): Promise<number[]> {
    if (this.cachedLightPanelIds) return this.cachedLightPanelIds;
    const layout = await this.getPanelLayout();
    this.cachedLightPanelIds = layout.positions
      .filter((p) => p.shapeType !== 12)
      .map((p) => p.panelId);
    return this.cachedLightPanelIds;
  }

  // Ensure the device is in static mode so state API calls are visible.
  // If an animated effect is active, reads the current color and writes
  // it as a static effect to all panels, preserving the visual state.
  private async ensureStaticMode(): Promise<void> {
    const info = await this.getInfo();
    const effect = info.effects.select;
    if (effect === "*Solid*" || effect === "*Static*") return;
    // An animated effect is active — write current color as static to override it
    const hsb: HSBColor = {
      hue: info.state.hue.value,
      saturation: info.state.sat.value,
      brightness: info.state.brightness.value,
    };
    const rgb = this.hsbToRgb(hsb);
    await this.setAllPanelsColor(rgb);
  }

  // Set all light panels to a single color via the effects write API
  async setAllPanelsColor(color: RGBColor): Promise<void> {
    const ids = await this.getLightPanelIds();
    const panelColors = new Map<number, RGBColor>();
    for (const id of ids) {
      panelColors.set(id, color);
    }
    await this.setPanelColors(panelColors);
  }

  async turnOn(): Promise<void> {
    await this.client.put("/state", { on: { value: true } });
  }

  async turnOff(): Promise<void> {
    await this.client.put("/state", { on: { value: false } });
  }

  async setBrightness(brightness: number): Promise<void> {
    await this.ensureStaticMode();
    const value = Math.max(0, Math.min(100, brightness));
    await this.client.put("/state", { brightness: { value } });
  }

  async setHue(hue: number): Promise<void> {
    await this.ensureStaticMode();
    const value = Math.max(0, Math.min(360, hue));
    await this.client.put("/state", { hue: { value } });
  }

  async setSaturation(saturation: number): Promise<void> {
    await this.ensureStaticMode();
    const value = Math.max(0, Math.min(100, saturation));
    await this.client.put("/state", { sat: { value } });
  }

  async setColorTemperature(ct: number): Promise<void> {
    await this.ensureStaticMode();
    const value = Math.max(1200, Math.min(6500, ct));
    await this.client.put("/state", { ct: { value } });
  }

  async setColor(color: RGBColor): Promise<void> {
    await this.setAllPanelsColor(color);
  }

  async setState(state: {
    on?: boolean;
    brightness?: number;
    hue?: number;
    saturation?: number;
    ct?: number;
  }): Promise<void> {
    await this.ensureStaticMode();
    const payload: Record<string, { value: number | boolean }> = {};
    if (state.on !== undefined) payload.on = { value: state.on };
    if (state.brightness !== undefined)
      payload.brightness = { value: Math.max(0, Math.min(100, state.brightness)) };
    if (state.hue !== undefined)
      payload.hue = { value: Math.max(0, Math.min(360, state.hue)) };
    if (state.saturation !== undefined)
      payload.sat = { value: Math.max(0, Math.min(100, state.saturation)) };
    if (state.ct !== undefined)
      payload.ct = { value: Math.max(1200, Math.min(6500, state.ct)) };
    await this.client.put("/state", payload);
  }

  async listEffects(): Promise<string[]> {
    const response = await this.client.get<string[]>("/effects/effectsList");
    return response.data;
  }

  async getCurrentEffect(): Promise<string> {
    const response = await this.client.get<string>("/effects/select");
    return response.data;
  }

  async setEffect(effectName: string): Promise<void> {
    await this.client.put("/effects", { select: effectName });
  }

  // Create and activate a custom animation using plugin-based effects
  async createAnimation(options: AnimationOptions): Promise<void> {
    const { name, style, palette, speed = "medium", direction = "right", brightness = 100, loop = true } = options;
    const pluginUuid = PLUGIN_UUIDS[style];
    const timing = SPEED_MAPPINGS[speed];

    // Build palette with probability (even distribution)
    const paletteWithProb = palette.map((color) => ({
      hue: color.hue,
      saturation: color.saturation,
      brightness: Math.round((color.brightness * brightness) / 100),
      probability: Math.round(100 / palette.length),
    }));

    // Build plugin options based on style
    const pluginOptions: Array<{ name: string; value: number | string | boolean }> = [];

    // Direction options vary by plugin type
    if (style === "flow" || style === "wheel") {
      // Flow uses linDirection, wheel uses rotDirection
      if (style === "flow") {
        pluginOptions.push({ name: "linDirection", value: direction });
      } else {
        pluginOptions.push({ name: "rotDirection", value: direction === "right" ? "cw" : "ccw" });
      }
      // These plugins use single transTime value
      pluginOptions.push({ name: "transTime", value: timing.transTime });
    } else {
      // Fade, highlight, random, explode use transTime and delayTime ranges
      pluginOptions.push({ name: "transTime", value: timing.transTime });
      pluginOptions.push({ name: "delayTime", value: timing.delayTime });
    }

    // Write the animation
    await this.client.put("/effects", {
      write: {
        command: "add",
        animName: name,
        animType: "plugin",
        pluginType: "color",
        pluginUuid,
        colorType: "HSB",
        palette: paletteWithProb,
        pluginOptions,
        loop,
      },
    });

    // Activate the animation
    await this.setEffect(name);
  }

  // Display a temporary animation without saving it
  async displayAnimation(options: Omit<AnimationOptions, "name">): Promise<void> {
    const { style, palette, speed = "medium", direction = "right", brightness = 100 } = options;
    const pluginUuid = PLUGIN_UUIDS[style];
    const timing = SPEED_MAPPINGS[speed];

    const paletteWithProb = palette.map((color) => ({
      hue: color.hue,
      saturation: color.saturation,
      brightness: Math.round((color.brightness * brightness) / 100),
      probability: Math.round(100 / palette.length),
    }));

    const pluginOptions: Array<{ name: string; value: number | string | boolean }> = [];

    if (style === "flow" || style === "wheel") {
      if (style === "flow") {
        pluginOptions.push({ name: "linDirection", value: direction });
      } else {
        pluginOptions.push({ name: "rotDirection", value: direction === "right" ? "cw" : "ccw" });
      }
      pluginOptions.push({ name: "transTime", value: timing.transTime });
    } else {
      pluginOptions.push({ name: "transTime", value: timing.transTime });
      pluginOptions.push({ name: "delayTime", value: timing.delayTime });
    }

    await this.client.put("/effects", {
      write: {
        command: "display",
        animType: "plugin",
        pluginType: "color",
        pluginUuid,
        colorType: "HSB",
        palette: paletteWithProb,
        pluginOptions,
        loop: true,
      },
    });
  }


  // Delete a custom animation by name
  async deleteAnimation(name: string): Promise<void> {
    await this.client.put("/effects", {
      write: {
        command: "delete",
        animName: name,
      },
    });
  }

  async setPanelColors(panelColors: Map<number, RGBColor>): Promise<void> {
    const panels = Array.from(panelColors.entries());
    const numPanels = panels.length;

    let animData = `${numPanels}`;
    for (const [panelId, color] of panels) {
      animData += ` ${panelId} 1 ${color.r} ${color.g} ${color.b} 0 1`;
    }

    await this.client.put("/effects", {
      write: {
        command: "display",
        animType: "static",
        animData,
        loop: false,
        palette: [],
      },
    });
  }

  async identify(): Promise<void> {
    await this.client.put("/identify", {});
  }

  // UDP Streaming methods
  async initializeStreaming(): Promise<void> {
    const info = await this.getInfo();
    const model = info.model;

    // Determine protocol version based on model
    // NL22 uses V1, newer models (Shapes, Elements, Canvas) use V2
    this.protocolVersion = model === "NL22" ? 1 : 2;

    // Get panel IDs
    const layout = await this.getPanelLayout();
    this.panelIds = layout.positions.map((p) => p.panelId);

    // Enable external control mode
    await this.client.put("/effects", {
      write: {
        command: "display",
        animType: "extControl",
        extControlVersion: this.protocolVersion === 1 ? "v1" : "v2",
      },
    });

    // Create UDP socket
    this.streamingSocket = dgram.createSocket("udp4");
  }

  async streamColors(panelColors: Map<number, RGBColor>): Promise<void> {
    if (!this.streamingSocket) {
      await this.initializeStreaming();
    }

    const packet =
      this.protocolVersion === 1
        ? this.buildV1Packet(panelColors)
        : this.buildV2Packet(panelColors);

    const port =
      this.protocolVersion === 1 ? STREAMING_PORT_V1 : STREAMING_PORT_V2;

    return new Promise((resolve, reject) => {
      this.streamingSocket!.send(packet, port, this.ip, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async streamSolidColor(color: RGBColor): Promise<void> {
    if (this.panelIds.length === 0) {
      const layout = await this.getPanelLayout();
      this.panelIds = layout.positions.map((p) => p.panelId);
    }

    const panelColors = new Map<number, RGBColor>();
    for (const panelId of this.panelIds) {
      panelColors.set(panelId, color);
    }
    await this.streamColors(panelColors);
  }

  private buildV1Packet(panelColors: Map<number, RGBColor>): Buffer {
    const panels = Array.from(panelColors.entries());
    const buffer = Buffer.alloc(1 + panels.length * 7);

    buffer.writeUInt8(panels.length, 0);
    let offset = 1;

    for (const [panelId, color] of panels) {
      buffer.writeUInt8(panelId, offset);
      buffer.writeUInt8(1, offset + 1); // Number of frames
      buffer.writeUInt8(color.r, offset + 2);
      buffer.writeUInt8(color.g, offset + 3);
      buffer.writeUInt8(color.b, offset + 4);
      buffer.writeUInt8(0, offset + 5); // White channel
      buffer.writeUInt8(1, offset + 6); // Transition time
      offset += 7;
    }

    return buffer;
  }

  private buildV2Packet(panelColors: Map<number, RGBColor>): Buffer {
    const panels = Array.from(panelColors.entries());
    const buffer = Buffer.alloc(2 + panels.length * 8);

    buffer.writeUInt16BE(panels.length, 0);
    let offset = 2;

    for (const [panelId, color] of panels) {
      buffer.writeUInt16BE(panelId, offset);
      buffer.writeUInt8(color.r, offset + 2);
      buffer.writeUInt8(color.g, offset + 3);
      buffer.writeUInt8(color.b, offset + 4);
      buffer.writeUInt8(0, offset + 5); // White channel
      buffer.writeUInt16BE(1, offset + 6); // Transition time
      offset += 8;
    }

    return buffer;
  }

  async stopStreaming(): Promise<void> {
    if (this.streamingSocket) {
      this.streamingSocket.close();
      this.streamingSocket = null;
    }
  }

  private hsbToRgb(color: HSBColor): RGBColor {
    const h = color.hue / 360;
    const s = color.saturation / 100;
    const v = color.brightness / 100;

    let r = 0, g = 0, b = 0;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      case 5: r = v; g = p; b = q; break;
    }

    return {
      r: Math.round(r * 255),
      g: Math.round(g * 255),
      b: Math.round(b * 255),
    };
  }

  private rgbToHsb(color: RGBColor): HSBColor {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;

    let hue = 0;
    if (delta !== 0) {
      if (max === r) {
        hue = ((g - b) / delta) % 6;
      } else if (max === g) {
        hue = (b - r) / delta + 2;
      } else {
        hue = (r - g) / delta + 4;
      }
      hue *= 60;
      if (hue < 0) hue += 360;
    }

    const saturation = max === 0 ? 0 : (delta / max) * 100;
    const brightness = max * 100;

    return {
      hue: Math.round(hue),
      saturation: Math.round(saturation),
      brightness: Math.round(brightness),
    };
  }

  getIp(): string {
    return this.ip;
  }

  getAuthToken(): string {
    return this.authToken;
  }
}

// Discovery functions
export async function discoverDevicesMdns(): Promise<
  Array<{ ip: string; name: string; id: string }>
> {
  const { Bonjour } = await import("bonjour-service");
  const bonjour = new Bonjour();

  return new Promise((resolve) => {
    const devices: Array<{ ip: string; name: string; id: string }> = [];
    const timeout = setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve(devices);
    }, 10000);

    const browser = bonjour.find({ type: "nanoleafapi" }, (service) => {
      if (service.addresses && service.addresses.length > 0) {
        const ipv4 = service.addresses.find(
          (addr) => !addr.includes(":") && addr !== "127.0.0.1"
        );
        if (ipv4) {
          devices.push({
            ip: ipv4,
            name: service.name,
            id: service.txt?.id || service.name,
          });
        }
      }
    });

    browser.start();
  });
}

export async function discoverDevicesScan(
  subnet?: string
): Promise<Array<{ ip: string }>> {
  const devices: Array<{ ip: string }> = [];
  const baseSubnet = subnet || "192.168.1";

  const checkPromises: Promise<void>[] = [];

  for (let i = 1; i <= 254; i++) {
    const ip = `${baseSubnet}.${i}`;
    checkPromises.push(
      axios
        .get(`http://${ip}:${NANOLEAF_PORT}/api/v1/`, { timeout: 500 })
        .then(() => {
          devices.push({ ip });
        })
        .catch(() => {
          // Not a Nanoleaf device
        })
    );
  }

  await Promise.all(checkPromises);
  return devices;
}
