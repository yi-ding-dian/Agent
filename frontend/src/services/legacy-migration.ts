/**
 * localStorage 旧 key 迁移（应用更名：piagent → myagent）
 *
 * 应用曾以 `piagent_*` 为 key 持久化 token / 主题 / LLM 配置 / 侧栏宽度 / 头像等，
 * 更名后统一使用 `myagent_*`。为保证升级不丢用户配置，migrateLegacyKeys()
 * 在应用启动时（main.tsx）执行一次：新 key 为空且旧 key 有值 → 取旧值写入新 key，
 * 随后删除旧 key。浏览器存储迁移是幂等的，重复执行无副作用。
 */
export function migrateLegacyKeys(): void {
  // 新 key → 旧 key（旧 key 不存在时自动跳过）
  const LEGACY_MAP: Record<string, string> = {
    myagent_token: 'piagent_token',
    myagent_api_config: 'piagent_api_config',
    myagent_llm_model: 'piagent_llm_model',
    myagent_llm_base_url: 'piagent_llm_base_url',
    myagent_llm_api_key: 'piagent_llm_api_key',
    myagent_llm_presets: 'piagent_llm_presets',
    myagent_llm_active_preset: 'piagent_llm_active_preset',
    myagent_theme: 'piagent_theme',
    'myagent-sidebar-width': 'piagent-sidebar-width',
    myagent_avatar: 'piagent_avatar',
  };

  try {
    for (const [newKey, oldKey] of Object.entries(LEGACY_MAP)) {
      const oldValue = localStorage.getItem(oldKey);
      if (oldValue === null) continue; // 旧 key 无值，无需迁移
      if (localStorage.getItem(newKey) === null) {
        localStorage.setItem(newKey, oldValue);
      }
      localStorage.removeItem(oldKey);
    }
  } catch {
    /* localStorage 不可用（隐私模式等）时静默跳过 */
  }
}
