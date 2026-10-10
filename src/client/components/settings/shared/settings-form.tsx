/**
 * 设置表单基础设施（设置弹窗内多域共享）
 *
 * 背景：常规 / Agent 限流 / 工具权限 / 高级 四个域共享同一个 ConfigData 表单对象，
 * 并由底部保存栏一次性 POST /api/config 提交。此前该 state 及配套逻辑内联在
 * SettingsModal.tsx（1665 行）中，与壳的导航逻辑混在一起。
 *
 * 抽出后：
 *  - form / setField / 保存 / 各域便捷 setter 由本 Provider 统一持有；
 *  - 需要保存栏的域从 useSettingsForm() 取 save + saving，自行渲染保存按钮；
 *  - 「思考级别归一化」effect 特意放在 Provider（而非某个面板内）：它原先无条件运行，
 *    若跟随面板挂载，切到别的 tab 时归一化会停摆、保存出与当前模型不匹配的级别。
 */
import { createContext, useContext, useEffect, useLayoutEffect, useState, type DependencyList, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { useChatStore } from '../../../store/chat-store';
import type { AdvancedConfig, ConfigData, ToolPermissionValue } from '../../../types/api';
import { DEFAULT_ADVANCED_CONFIG } from '../../../../shared/types.js';
import { DEFAULT_PERMISSIONS } from './defaults';

/** 限流字段的取值范围（blur 时越界则回落到默认值） */
export const RATE_FIELDS: Record<string, { min: number; max: number; def: number; label: string }> = {
  tool_rate_limit_per_minute: { min: 10, max: 50, def: 50, label: '每分钟最多工具调用' },
  agent_max_tool_calls_per_turn: { min: 20, max: 100, def: 100, label: '单轮最多工具调用' },
  agent_max_consecutive_errors: { min: 5, max: 20, def: 5, label: '连续错误上限' },
  agent_max_turns: { min: 10, max: 100, def: 100, label: '最大对话轮数' },
};

export interface SettingsFormContextValue {
  form: ConfigData;
  /**
   * 原始 setState —— 仅供设置壳在**过渡期**使用（各域面板尚未完全拆出时）。
   * 域组件请优先用下方语义化 setter，避免把整表结构暴露给消费方。
   */
  setForm: Dispatch<SetStateAction<ConfigData>>;
  /** 更新单个字段 */
  setField: <K extends keyof ConfigData>(field: K, value: ConfigData[K]) => void;
  /** 更新某个工具的权限（工具权限域） */
  setToolPermission: (name: string, value: ToolPermissionValue) => void;
  /** 更新 advanced 顶层字段（高级域） */
  setAdvanced: (patch: Partial<AdvancedConfig>) => void;
  /** 更新 advanced 嵌套分组的数值字段（高级域） */
  setAdvancedNested: <K extends 'compaction' | 'subagent' | 'memory' | 'search'>(
    group: K,
    field: keyof AdvancedConfig[K],
    value: number,
  ) => void;
  /** 限流字段 blur 时越界回落 */
  handleRateLimitBlur: (field: string) => void;
  /** 权限工具清单：固定工具 + 后端返回的额外工具键（扩展/MCP 工具） */
  permissionTools: string[];
  /** 全量保存（POST /api/config）并在成功后关闭弹窗 —— 供「常规 / Agent 限流 / 工具权限」三域使用 */
  save: () => Promise<void>;
  saving: boolean;
  /**
   * 底部保存栏内容。由**当前激活的域**自行声明：
   *  - 有保存语义的域（memory / advanced / external，或共用一个 save 的前三个域）设置自己的按钮；
   *  - 无保存语义的域（账户 / 模型设置 / MCP / 扩展 —— 操作即时生效）不设置，保存栏整体不渲染。
   * 这样壳不再需要「按 tab 分派保存动作」和「排除若干 tab」两处硬编码（2026-10 架构改造）。
   */
  footer: ReactNode;
  setFooter: (node: ReactNode) => void;
}

const SettingsFormContext = createContext<SettingsFormContextValue | null>(null);

export function SettingsFormProvider({
  onClose,
  children,
}: {
  onClose: () => void;
  children: ReactNode;
}) {
  const config = useChatStore((s) => s.config);
  const saveConfig = useChatStore((s) => s.saveConfig);

  const [form, setForm] = useState<ConfigData>({
    // 不再有出厂默认模型：base_url/model/api_key 初始为空（真实值由 GET /api/config 覆盖）
    base_url: '',
    api_key: '',
    model: '',
    system_prompt: '你是一个智能助手，可以帮助用户解决各种问题。',
    temperature: 0.7,
    // maxTokens 已移至「模型设置」（按模型预设生效）。此处固定 65535 与后端
    // config.defaultMaxTokens 兜底一致，避免常规设置保存时误覆盖后端全局默认。
    max_tokens: 65535,
    thinking_level: 'high',
    enable_thinking: true,
    thinking_budget: 1024,
    preserve_thinking: false,
    work_dir: '/home/user/my-Agent',
    chat_base_url: '',
    chat_api_key: '',
    chat_model: '',
    agent_base_url: '',
    agent_api_key: '',
    agent_model: '',
    tool_rate_limit_per_minute: 50,
    agent_max_tool_calls_per_turn: 100,
    agent_max_consecutive_errors: 5,
    agent_max_turns: 100,
    llm_timeout_ms: 300000,
    tool_permissions: { ...DEFAULT_PERMISSIONS },
    advanced: { ...DEFAULT_ADVANCED_CONFIG },
  });
  const [saving, setSaving] = useState(false);
  const [footer, setFooter] = useState<ReactNode>(null);

  // 服务端配置到达后并入表单
  useEffect(() => {
    if (config) {
      setForm((prev) => ({ ...prev, ...config }));
    }
  }, [config]);

  // 当前模型能力（levels）变化时，若 form.thinking_level 不在其级别列表（切换模型残留旧级别，
  // 或旧配置遗留 'off'）→ 归一化到模型默认级别（优先 high，回退首档），保证保存值始终合法
  // （滑杆渲染另有 effectiveThinkingLevel 兜底）
  useEffect(() => {
    const cap = form.thinking_capability;
    const levels = cap?.mode === 'levels' ? (cap.levels || []) : [];
    if (!levels.length || levels.some((l) => l.value === form.thinking_level)) return;
    setForm((prev) => ({
      ...prev,
      thinking_level: levels.find((l) => l.value === 'high')?.value || levels[0]?.value || 'high',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.thinking_capability, form.thinking_level]);

  const setField: SettingsFormContextValue['setField'] = (field, value) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const setToolPermission: SettingsFormContextValue['setToolPermission'] = (name, value) => {
    setForm((prev) => ({
      ...prev,
      tool_permissions: { ...(prev.tool_permissions || {}), [name]: value },
    }));
  };

  const setAdvanced: SettingsFormContextValue['setAdvanced'] = (patch) => {
    setForm((prev) => ({
      ...prev,
      advanced: { ...DEFAULT_ADVANCED_CONFIG, ...(prev.advanced ?? {}), ...patch },
    }));
  };

  const setAdvancedNested: SettingsFormContextValue['setAdvancedNested'] = (group, field, value) => {
    setForm((prev) => {
      const cur = prev.advanced ?? DEFAULT_ADVANCED_CONFIG;
      return {
        ...prev,
        advanced: { ...cur, [group]: { ...cur[group], [field]: value } },
      };
    });
  };

  const handleRateLimitBlur = (field: string) => {
    const range = RATE_FIELDS[field];
    const val = form[field as keyof ConfigData] as number;
    if (val < range.min || val > range.max) {
      setForm((prev) => ({ ...prev, [field]: range.def }));
    }
  };

  // 固定工具列表 + 后端返回的额外工具键（扩展工具/MCP 工具）
  const permissionTools = Array.from(new Set([
    ...Object.keys(DEFAULT_PERMISSIONS),
    ...Object.keys(form.tool_permissions || {}),
  ]));

  const save = async () => {
    setSaving(true);
    try {
      await saveConfig(form);
      onClose();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  };

  const value: SettingsFormContextValue = {
    form,
    setForm,
    setField,
    setToolPermission,
    setAdvanced,
    setAdvancedNested,
    handleRateLimitBlur,
    permissionTools,
    save,
    saving,
    footer,
    setFooter,
  };

  return <SettingsFormContext.Provider value={value}>{children}</SettingsFormContext.Provider>;
}

export function useSettingsForm(): SettingsFormContextValue {
  const ctx = useContext(SettingsFormContext);
  if (!ctx) throw new Error('useSettingsForm 必须在 SettingsFormProvider 内使用');
  return ctx;
}

/**
 * 域组件用它声明自己的底部保存栏内容（不调用 = 该域无保存语义，保存栏不渲染）。
 *
 * 用 useLayoutEffect 而非 useEffect：切 tab 时要在浏览器绘制前把 footer 换好，
 * 否则会先闪一帧空的保存栏。
 */
export function useSettingsFooter(node: ReactNode, deps: DependencyList = []): void {
  const { setFooter } = useSettingsForm();
  useLayoutEffect(() => {
    setFooter(node);
    return () => setFooter(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
