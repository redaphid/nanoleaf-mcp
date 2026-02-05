import { NanoleafClient } from "./nanoleaf-client.ts";

export interface RegisteredDevice {
  alias: string;
  ip: string;
  authToken: string;
  client: NanoleafClient;
  name?: string;
  model?: string;
}

export type ResolveResult =
  | { client: NanoleafClient; device: RegisteredDevice }
  | { error: string };

export class DeviceManager {
  private devices = new Map<string, RegisteredDevice>();

  register(ip: string, authToken: string, alias?: string): RegisteredDevice {
    const key = (alias || ip).toLowerCase();
    const client = new NanoleafClient(ip, authToken);
    const device: RegisteredDevice = {
      alias: alias || ip,
      ip,
      authToken,
      client,
    };
    this.devices.set(key, device);
    return device;
  }

  remove(alias: string): boolean {
    return this.devices.delete(alias.toLowerCase());
  }

  resolve(deviceParam?: string): ResolveResult {
    if (this.devices.size === 0) {
      return {
        error:
          "No devices registered. Set NANOLEAF_DEVICES env var or use add_device / discover_devices + create_auth_token to set up.",
      };
    }

    if (!deviceParam) {
      if (this.devices.size === 1) {
        const device = [...this.devices.values()][0];
        return { client: device.client, device };
      }
      const aliases = [...this.devices.values()].map((d) => d.alias);
      return {
        error: `Multiple devices registered. Specify which device: ${aliases.join(", ")}`,
      };
    }

    const lower = deviceParam.toLowerCase();

    // Match by alias
    const byAlias = this.devices.get(lower);
    if (byAlias) return { client: byAlias.client, device: byAlias };

    // Fall back to IP match
    for (const device of this.devices.values()) {
      if (device.ip === deviceParam) {
        return { client: device.client, device };
      }
    }

    const aliases = [...this.devices.values()].map((d) => d.alias);
    return {
      error: `Device "${deviceParam}" not found. Available: ${aliases.join(", ")}`,
    };
  }

  listAll(): RegisteredDevice[] {
    return [...this.devices.values()];
  }

  has(alias: string): boolean {
    return this.devices.has(alias.toLowerCase());
  }

  get size(): number {
    return this.devices.size;
  }

  async refreshNames(): Promise<void> {
    for (const device of this.devices.values()) {
      try {
        const info = await device.client.getInfo();
        device.name = info.name;
        device.model = info.model;

        // Upgrade IP-based alias to hardware name if alias is still the IP
        if (device.alias === device.ip && info.name) {
          const oldKey = device.ip.toLowerCase();
          const newAlias = info.name;
          const newKey = newAlias.toLowerCase();
          if (!this.devices.has(newKey)) {
            this.devices.delete(oldKey);
            device.alias = newAlias;
            this.devices.set(newKey, device);
          }
        }
      } catch {
        // Non-fatal: device may be unreachable at startup
      }
    }
  }
}
