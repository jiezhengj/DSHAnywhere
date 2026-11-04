export interface PluginConfig {
  relayUrl: string | null;
  enabled: boolean;
}

export const DEFAULT_CONFIG: PluginConfig = { relayUrl: null, enabled: true };

/** 配置解析必须对缺失/多余字段容错：配置来自 profile 补丁层，可能被使用者手改 */
export function parseConfig(raw: unknown): PluginConfig {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_CONFIG };
  const input = raw as Record<string, unknown>;
  const relayUrl = typeof input.relayUrl === "string" && input.relayUrl.trim() ? input.relayUrl.trim() : null;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  return { relayUrl, enabled };
}

export function isConfigured(config: PluginConfig): boolean {
  return config.relayUrl !== null && config.relayUrl.length > 0;
}
