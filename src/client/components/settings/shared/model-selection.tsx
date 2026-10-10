/**
 * 模型选中状态（设置弹窗内跨域共享）
 *
 * 耦合点：presets 域维护「预设列表 / 当前选中 / 服务端全局默认」，而**常规域的
 * 「当前模型」展示**需要读它。此前两者同处一个组件故可直接读；域拆分后必须上提。
 *
 * 因此这三个 state 及其派生值 currentModelLabel 放在本 Provider：
 *  - presets 域：读写（编辑预设列表、选中、删除）
 *  - 常规域：只读 currentModelLabel
 *
 * 恢复服务端全局默认的 effect 也在此（**必须始终挂载**：它决定打开设置时的初始选中态，
 * 若跟随 presets 域面板挂载，用户不点进模型设置页就不会恢复）。
 */
import { createContext, useContext, useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import * as api from '../../../services/api';
import {
  getModelPresets,
  saveModelPresets,
  getActivePresetName,
  setActivePresetName,
  getLlmOverrides,
  type ModelPreset,
} from '../../../services/api-config';

/** 服务端全局默认模型（GET /api/global-model） */
export interface GlobalModel {
  id: string;
  baseUrl: string;
  apiKey: string;
}

export interface ModelSelectionContextValue {
  presets: ModelPreset[];
  setPresets: Dispatch<SetStateAction<ModelPreset[]>>;
  /** 更新预设列表并落 localStorage（编辑/新增/删除预设后用） */
  commitPresets: (next: ModelPreset[]) => void;
  activePreset: string | null;
  /** 更新当前选中并落 localStorage（传 null = 取消选中） */
  applyActivePreset: (name: string | null) => void;
  globalModel: GlobalModel | null;
  setGlobalModel: Dispatch<SetStateAction<GlobalModel | null>>;
  /** 选中某预设，并同步保存为该用户的服务端全局默认模型 */
  selectPreset: (name: string) => void;
  /** 「当前模型」展示文案：选中预设名 → 服务端全局默认 id → 未配置提示 */
  currentModelLabel: string;
}

const ModelSelectionContext = createContext<ModelSelectionContextValue | null>(null);

export function ModelSelectionProvider({ children }: { children: ReactNode }) {
  const [presets, setPresets] = useState<ModelPreset[]>(() => getModelPresets());
  const [activePreset, setActivePreset] = useState<string | null>(() => getActivePresetName());
  const [globalModel, setGlobalModel] = useState<GlobalModel | null>(null);

  const commitPresets = (next: ModelPreset[]) => {
    setPresets(next);
    saveModelPresets(next);
  };

  const applyActivePreset = (name: string | null) => {
    setActivePresetName(name);
    setActivePreset(name);
  };

  const selectPreset = (name: string) => {
    const preset = presets.find((p) => p.name === name);
    applyActivePreset(name);
    // 同步保存该预设为该用户的全局默认模型（后端创建会话时无 overrides 则使用它）。
    // 失败静默：不影响本地选中，本地选中本身已随请求经 modelOverrides 生效。
    // 注：不再携带 thinkingLevel —— 思考强度统一在「常规」设置按当前模型能力配置。
    if (preset) {
      api.saveGlobalModel({ id: preset.model, baseUrl: preset.baseUrl, apiKey: preset.apiKey, maxTokens: preset.maxTokens ?? 65535 })
        .then(() => setGlobalModel({ id: preset.model, baseUrl: preset.baseUrl, apiKey: preset.apiKey }))
        .catch(() => {});
    }
  };

  // 打开设置时恢复服务端全局默认：本地无选中预设且后端有全局默认 → 恢复选中。
  // 后端为权威来源（服务端会话不带 modelOverrides 时使用它）；若该模型不在预设列表，
  // 自动补一个临时预设显示并选中（写入 localStorage presets），保证本地与后端一致。
  // 同时记录全局默认模型（常规 tab「当前模型」展示用，本地已有选中时仅记录不覆盖），
  // 并兼容旧版本：localStorage 手动配置（三个 key）且未选中预设 → 一并同步到服务端。
  useEffect(() => {
    api.getGlobalModel()
      .then((gm) => {
        if (!gm?.id || !gm?.baseUrl) return;
        setGlobalModel({ id: gm.id, baseUrl: gm.baseUrl, apiKey: gm.apiKey || '' });
        // 本地已有选中预设 → 不覆盖（该选中项此前已同步过服务端，后端全局默认即此项）
        if (getActivePresetName()) return;
        const match = presets.find((p) => p.model === gm.id && p.baseUrl === gm.baseUrl);
        if (match) {
          applyActivePreset(match.name);
          return;
        }
        // 后端默认模型不在预设列表 → 补一个临时预设显示并选中
        const tmp: ModelPreset = {
          name: `${gm.id}（当前默认）`,
          baseUrl: gm.baseUrl,
          model: gm.id,
          apiKey: gm.apiKey || '',
          apiFormat: 'openai-completions',
          maxTokens: gm.maxTokens ?? 65535,
        };
        setPresets((prev) => {
          const next = [...prev, tmp];
          saveModelPresets(next);
          return next;
        });
        applyActivePreset(tmp.name);
      })
      .catch(() => {});
    // 旧版本手动配置（三个 key，无选中预设时 getLlmOverrides 返回它们）→ 同步到服务端，逻辑一致
    const manual = getLlmOverrides();
    if (manual.id && manual.baseUrl && !getActivePresetName()) {
      api.saveGlobalModel({ id: manual.id, baseUrl: manual.baseUrl, apiKey: manual.apiKey || '' })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 当前模型显示：模型设置选中的预设名 → 服务端全局默认模型 id → 未配置提示
  const currentModelLabel = (() => {
    if (activePreset) {
      const p = presets.find((x) => x.name === activePreset);
      if (p) return p.name;
    }
    if (globalModel?.id) return globalModel.id;
    return '未配置（请到模型设置选择）';
  })();

  const value: ModelSelectionContextValue = {
    presets,
    setPresets,
    commitPresets,
    activePreset,
    applyActivePreset,
    globalModel,
    setGlobalModel,
    selectPreset,
    currentModelLabel,
  };

  return <ModelSelectionContext.Provider value={value}>{children}</ModelSelectionContext.Provider>;
}

export function useModelSelection(): ModelSelectionContextValue {
  const ctx = useContext(ModelSelectionContext);
  if (!ctx) throw new Error('useModelSelection 必须在 ModelSelectionProvider 内使用');
  return ctx;
}
