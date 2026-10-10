import { useState, useEffect, useCallback } from 'react';
import { useChatStore } from '../../store/chat-store';
import { toast } from '../../store/toast-store';
import { confirmDialog } from '../../store/confirm-dialog';
import { ResizableModal } from '../common/ResizableModal';
import { DirBrowser } from '../common/DirBrowser';
import type { AdvancedConfig, ConfigData, McpServerConfig, ToolPermissionValue } from '../../types/api';
import * as api from '../../services/api';
import { isElectron } from '../../services/api-config';
// 共享默认值（真实值导入，非类型擦除）—— 与后端 advanced-config.ts 是同一份
import { DEFAULT_ADVANCED_CONFIG } from '../../../shared/types.js';
// 设置面板模块级常量（2026-10 架构改造：由本文件顶部抽出）
import { TOOL_LABELS, DEFAULT_PERMISSIONS } from '../settings/shared/defaults';
import {
  getModelPresets,
  saveModelPresets,
  getActivePresetName,
  setActivePresetName,
  getLlmOverrides,
  type ModelPreset,
} from '../../services/api-config';
// 设置表单基础设施（2026-10 架构改造：form/保存逻辑由本文件抽出，见 settings/shared/）
import { SettingsFormProvider, useSettingsForm } from '../settings/shared/settings-form';
// 已拆出的域组件（2026-10 架构改造：逐个从本文件搬出）
import { PermissionsPanel } from '../settings/panels/PermissionsPanel';
import { AgentLimitPanel } from '../settings/panels/AgentLimitPanel';
import { MemoryPanel } from '../settings/panels/MemoryPanel';
import { ExtensionsPanel } from '../settings/panels/ExtensionsPanel';
import { UserPanel } from '../settings/panels/UserPanel';
import { ExternalPanel } from '../settings/panels/ExternalPanel';

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsTab = 'common' | 'agent' | 'presets' | 'permissions' | 'memory' | 'user' | 'advanced' | 'mcp' | 'extensions' | 'external';

// 高级设置默认值：定义在 src/shared/types.ts，与后端 advanced-config.ts 共用同一份。
// 此前此处另存一份、仅靠注释声明"与后端默认一致"，已收敛为单一事实源（见该文件首部说明）。

// TOOL_LABELS / DEFAULT_PERMISSIONS 已抽至 settings/shared/defaults.ts（见上方 import）

export function SettingsModal({ onClose }: SettingsModalProps) {
  return (
    <SettingsFormProvider onClose={onClose}>
      <SettingsShell onClose={onClose} />
    </SettingsFormProvider>
  );
}

/**
 * 设置壳：两栏布局 + 左侧导航 + 右侧内容。
 *
 * 表单基础设施（form / setForm / permissionTools / save / saving）由 SettingsFormProvider 提供 ——
 * 该表单被 常规 / Agent 限流 / 工具权限 / 高级 四个域共享，且由底部保存栏一次性提交，
 * 故上提到 shared 层而不是留在壳里（2026-10 架构改造）。
 */
function SettingsShell({ onClose }: SettingsModalProps) {
  const { form, setForm, setField, setToolPermission, setAdvanced, setAdvancedNested, permissionTools, handleRateLimitBlur, save, saving, footer } = useSettingsForm();

  const [tab, setTab] = useState<SettingsTab>('common');
  const [browsing, setBrowsing] = useState(false);
  // 跨会话记忆的 state / 加载 / 保存已随「记忆管理」域迁至 settings/panels/MemoryPanel.tsx
  // MCP 外部 server（第 9 个 tab：MCP 服务）
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '', description: '' });
  const [mcpSaving, setMcpSaving] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);
  // 扩展列表的 state / 加载 / 启停已随「扩展」域迁至 settings/panels/ExtensionsPanel.tsx
  // 外部服务的 state / 加载 / 增删改 / 弹窗已随「外部服务」域迁至 settings/panels/ExternalPanel.tsx
  // 模型预设（localStorage；选中项会同步 POST /api/global-model 持久化到服务端作为该用户的
  // 全局默认模型 —— 后端创建会话时 modelOverrides 与全局默认都无才报错）
  const [presets, setPresets] = useState<ModelPreset[]>(() => getModelPresets());
  const [activePreset, setActivePreset] = useState<string | null>(() => getActivePresetName());
  const [editingPreset, setEditingPreset] = useState<{ index: number | 'new'; name: string; baseUrl: string; model: string; apiKey: string; maxTokens: number } | null>(null);
  const [presetTesting, setPresetTesting] = useState(false);
  // 账户域（头像 / 用户信息）的 state 已迁至 settings/panels/UserPanel.tsx
  // 服务端全局默认模型（模型设置选中项同步而来；常规 tab「当前模型」展示用）
  const [globalModel, setGlobalModel] = useState<{ id: string; baseUrl: string; apiKey: string } | null>(null);

  // RATE_FIELDS / handleRateLimitBlur / 服务端配置同步 / 思考级别归一化
  // 均已移入 SettingsFormProvider（见 settings/shared/settings-form.tsx）

  // 切换到 MCP 服务 tab 时加载 server 列表
  useEffect(() => {
    if (tab === 'mcp') {
      api.listMcpServers()
        .then((d) => setMcpServers(d.servers || []))
        .catch((e: any) => toast.error(e.message));
    }
  }, [tab]);

  // 切换到外部服务 tab 时加载当前配置

  /** 「浏览」工作目录：Electron 桌面端走系统目录选择对话框；Web 模式走定制目录浏览器 */
  const handleBrowse = async () => {
    if (isElectron() && window.myagent?.selectDirectory) {
      const dir = await window.myagent.selectDirectory();
      if (dir) setForm((prev) => ({ ...prev, work_dir: dir }));
      return;
    }
    setBrowsing(true);
  };

  // ─── 工具权限 ───────────────────────
  // handleToolPermissionChange / permissionTools 已移入 SettingsFormProvider
  // （工具权限域与壳共享同一份工具清单与权限 setter）

  // 底部保存栏内容由各域通过 useSettingsForm().setFooter 声明，壳不再按 tab 分派

  // 头像更换已迁至 settings/panels/UserPanel.tsx

  // ─── 模型预设操作（即时写入 localStorage，并同步 POST /api/global-model 持久化到服务端） ───

  const handleSelectPreset = (name: string) => {
    const preset = presets.find((p) => p.name === name);
    setActivePresetName(name);
    setActivePreset(name);
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
          setActivePresetName(match.name);
          setActivePreset(match.name);
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
        setActivePresetName(tmp.name);
        setActivePreset(tmp.name);
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

  /** 测试当前编辑中的模型配置连通性（后端代理 /api/test-model-connection，无状态，超时 8 秒） */
  const handlePresetTest = async () => {
    if (!editingPreset) return;
    const baseUrl = editingPreset.baseUrl.trim();
    const model = editingPreset.model.trim();
    if (!baseUrl || !model) {
      toast.error('请先填写 Base URL 和模型 ID');
      return;
    }
    setPresetTesting(true);
    try {
      const r = await api.testModelConnection(baseUrl, model, editingPreset.apiKey.trim());
      if (r.ok) {
        toast.success(`连接正常（${r.latencyMs}ms）`);
      } else {
        toast.error(r.error || '连接失败');
      }
    } catch (e: any) {
      toast.error(e.message || '连接失败');
    } finally {
      setPresetTesting(false);
    }
  };

  const handleStartAddPreset = () => {
    setEditingPreset({ index: 'new', name: '', baseUrl: '', model: '', apiKey: '', maxTokens: 65535 });
  };

  const handleStartEditPreset = (index: number) => {
    const p = presets[index];
    if (!p) return;
    setEditingPreset({ index, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey, maxTokens: p.maxTokens ?? 65535 });
  };

  const handleSavePreset = () => {
    if (!editingPreset) return;
    const name = editingPreset.name.trim();
    const baseUrl = editingPreset.baseUrl.trim();
    const model = editingPreset.model.trim();
    if (!name || !baseUrl || !model) {
      toast.error('预设名称、Base URL 和模型为必填项');
      return;
    }
    if (presets.some((p, i) => i !== editingPreset.index && p.name.trim().toLowerCase() === name.toLowerCase())) {
      toast.error(`预设名称 "${name}" 已存在`);
      return;
    }
    const apiKey = editingPreset.apiKey.trim();
    // maxTokens 无输入时默认 65535（与后端 config.defaultMaxTokens 兜底一致）
    const maxTokens = editingPreset.maxTokens || 65535;
    const next = editingPreset.index === 'new'
      ? [...presets, { name, baseUrl, model, apiKey, maxTokens, apiFormat: 'openai-completions' as const }]
      : presets.map((p, i) => (i === editingPreset.index ? { ...p, name, baseUrl, model, apiKey, maxTokens } : p));
    setPresets(next);
    saveModelPresets(next);
    // 编辑的是当前选中项且名称被修改 → 同步选中名称
    if (editingPreset.index !== 'new' && activePreset === presets[editingPreset.index].name && activePreset !== name) {
      setActivePresetName(name);
      setActivePreset(name);
    }
    setEditingPreset(null);
    toast.success(`已保存模型「${name}」`);
  };

  const handleDeletePreset = async (index: number) => {
    const target = presets[index];
    if (!target) return;
    const r = await confirmDialog.confirm({
      title: '删除预设',
      message: `删除预设 "${target.name}"？`,
      danger: true,
      confirmLabel: '删除',
    });
    if (r !== 'confirm') return;
    const next = presets.filter((_, i) => i !== index);
    setPresets(next);
    saveModelPresets(next);
    if (activePreset === target.name) {
      setActivePresetName(null);
      setActivePreset(null);
    }
    if (editingPreset && editingPreset.index === index) setEditingPreset(null);
  };

  // ─── 记忆管理已迁至 settings/panels/MemoryPanel.tsx ───────────────────

  // ─── MCP 外部 server（第 9 个 tab） ───────────────────

  const handleMcpToggle = async (srv: McpServerConfig) => {
    try {
      const cfg = await api.updateMcpServer(srv.name, { enabled: !srv.enabled });
      setMcpServers(cfg.servers || []);
      toast.success(`已${srv.enabled ? '停用' : '启用'}「${srv.name}」，新建会话生效`);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleMcpDelete = async (srv: McpServerConfig) => {
    const r = await confirmDialog.confirm({
      title: '删除 MCP 服务',
      message: `确定删除 MCP 服务「${srv.name}」吗？其工具将不再可用。`,
      danger: true,
      confirmLabel: '删除',
    });
    if (r !== 'confirm') return;
    try {
      const cfg = await api.deleteMcpServer(srv.name);
      setMcpServers(cfg.servers || []);
      toast.success(`已删除「${srv.name}」`);
    } catch (e: any) {
      toast.error(e.message);
    }
  };

  const handleMcpAdd = async () => {
    const name = mcpForm.name.trim();
    const command = mcpForm.command.trim();
    if (!name || !command) {
      toast.error('请填写服务名称和命令');
      return;
    }
    setMcpSaving(true);
    try {
      const args = mcpForm.args
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      const cfg = await api.addMcpServer({
        name,
        command,
        args,
        description: mcpForm.description.trim(),
      });
      setMcpServers(cfg.servers || []);
      setMcpForm({ name: '', command: '', args: '', description: '' });
      setShowMcpModal(false);
      toast.success(`已新增「${name}」，新建会话生效`);
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setMcpSaving(false);
    }
  };

  // ─── 扩展（启停管理）已迁至 settings/panels/ExtensionsPanel.tsx ───

  // ─── 外部服务（知识库查询链接）已迁至 settings/panels/ExternalPanel.tsx ───

  // ─── 高级设置（advanced-config：压缩/子代理/记忆/黑名单/搜索） ───

  const [advSaving, setAdvSaving] = useState(false);

  const adv = form.advanced ?? DEFAULT_ADVANCED_CONFIG;

  // setAdv / setAdvNested 已移入 SettingsFormProvider（见 settings/shared/settings-form.tsx）

  const handleSaveAdvanced = async () => {
    setAdvSaving(true);
    try {
      await api.updateAdvancedConfig(adv);
      toast.success('高级设置已保存，立即生效');
    } catch (e: any) {
      toast.error(e.message || '保存失败');
    } finally {
      setAdvSaving(false);
    }
  };

  // ─── 思考模式（常规 tab）：当前模型 + 开启开关 + 按模型能力动态级别 ───

  const thinkingCap = form.thinking_capability;
  const capLevels = thinkingCap?.mode === 'levels' ? (thinkingCap.levels || []) : [];
  // thinking_level 归一化：不在当前模型级别中（如切换模型后残留旧级别 minimal/xhigh/max，
  // 或旧配置遗留 'off'）→ 映射模型默认级别（优先 high，回退首档），避免滑杆落空/级别错位；
  // 滑杆档位永远不含「关闭」（关闭由「开启思考」开关控制）
  const effectiveThinkingLevel = capLevels.some((l) => l.value === form.thinking_level)
    ? form.thinking_level
    : (capLevels.find((l) => l.value === 'high')?.value || capLevels[0]?.value || 'high');
  const thinkingSliderIndex = capLevels.length ? Math.max(0, capLevels.findIndex((l) => l.value === effectiveThinkingLevel)) : 0;
  const thinkingLevelLabel = capLevels.find((l) => l.value === effectiveThinkingLevel)?.label || effectiveThinkingLevel;

  // 当前模型显示：模型设置选中的预设名 → 服务端全局默认模型 id → 未配置提示
  const currentModelLabel = (() => {
    if (activePreset) {
      const p = presets.find((x) => x.name === activePreset);
      if (p) return p.name;
    }
    if (globalModel?.id) return globalModel.id;
    return '未配置（请到模型设置选择）';
  })();

  /**
   * 「开启思考」总开关（绑定 form.enable_thinking，三种能力模式均显示）：
   * - levels 模式：关闭 = enable_thinking=false（thinking_level 保留原值不置 off —— 后端以
   *   enableThinking 为权威关闭信号，且 levels 档位已无 off；旧配置残留 'off' 无害，开启时会归一化）
   * - switch 模式（Qwen）：enable_thinking 即开关
   * - none 模式：仅开关生效（模型无强度等级），开启/关闭不动 thinking_level
   * - 关闭开关时隐藏强度滑杆 / budget 输入（滑杆不会显示「关闭」档）
   */
  const handleThinkingToggle = (checked: boolean) => {
    if (!checked) {
      setForm((prev) => ({ ...prev, enable_thinking: false }));
      return;
    }
    setForm((prev) => {
      // 仅 levels 模式需要归一化级别；switch/none 模式保持原值。
      // 开启时若原级别为 off（旧配置残留）或不在当前模型级别中 → 归一到模型默认级别（优先 high）
      const level =
        capLevels.length > 0 && (prev.thinking_level === 'off' || !capLevels.some((l) => l.value === prev.thinking_level))
          ? (capLevels.find((l) => l.value === 'high')?.value || capLevels[0]?.value || 'high')
          : prev.thinking_level;
      return { ...prev, enable_thinking: true, thinking_level: level };
    });
  };

  return (
    // 遮罩不响应点击：设置弹窗只经右上角关闭按钮或 Esc 关闭
    // （原本点遮罩即关闭，与 Agent 详情弹窗统一为「不响应」—— 拖拽/误触时容易意外关闭）
    <div className="modal-overlay">
      <ResizableModal
        width={920}
        height="min(82vh, 680px)"
        style={{ width: '920px', height: 'min(82vh, 680px)' }}
        className="settings-modal"
        onEsc={onClose}
      >
        <div className="modal-header">
          <h2>设置</h2>
          <button className="modal-close-btn" onClick={onClose}>
            &#10005;
          </button>
        </div>

        {/* 两栏布局：左栏导航 + 右栏内容（菜单顺序：常规/Agent限流/模型设置/工具权限/记忆管理/外部服务/账户/高级/MCP服务） */}
        <div className="settings-layout">
          <nav className="settings-nav">
            <button
              className={`settings-nav-item${tab === 'common' ? ' active' : ''}`}
              onClick={() => setTab('common')}
            >
              常规
            </button>
            <button
              className={`settings-nav-item${tab === 'agent' ? ' active' : ''}`}
              onClick={() => setTab('agent')}
            >
              Agent 限流
            </button>
            <button
              className={`settings-nav-item${tab === 'presets' ? ' active' : ''}`}
              onClick={() => setTab('presets')}
            >
              模型设置
            </button>
            <button
              className={`settings-nav-item${tab === 'permissions' ? ' active' : ''}`}
              onClick={() => setTab('permissions')}
            >
              工具权限
            </button>
            <button
              className={`settings-nav-item${tab === 'memory' ? ' active' : ''}`}
              onClick={() => setTab('memory')}
            >
              记忆管理
            </button>
            <button
              className={`settings-nav-item${tab === 'external' ? ' active' : ''}`}
              onClick={() => setTab('external')}
            >
              外部服务
            </button>
            <button
              className={`settings-nav-item${tab === 'user' ? ' active' : ''}`}
              onClick={() => setTab('user')}
            >
              账户
            </button>
            <button
              className={`settings-nav-item${tab === 'advanced' ? ' active' : ''}`}
              onClick={() => setTab('advanced')}
            >
              高级
            </button>
            <button
              className={`settings-nav-item${tab === 'mcp' ? ' active' : ''}`}
              onClick={() => setTab('mcp')}
            >
              MCP 服务
            </button>
            <button
              className={`settings-nav-item${tab === 'extensions' ? ' active' : ''}`}
              onClick={() => setTab('extensions')}
            >
              扩展
            </button>
          </nav>
          <div className="settings-content">
          {tab === 'common' && (
            <>
              <div className="form-group">
                <label>System Prompt</label>
                <textarea
                  value={form.system_prompt}
                  onChange={(e) => setField('system_prompt', e.target.value)}
                  placeholder="系统提示词"
                  rows={2}
                />
              </div>
              <div className="form-group">
                <label>工作目录</label>
                <div className="input-with-btn">
                  <input
                    type="text"
                    value={form.work_dir}
                    onChange={(e) => setField('work_dir', e.target.value)}
                    placeholder="输入工作目录路径"
                    list="work-dir-suggestions"
                  />
                  <button type="button" className="btn btn-secondary" onClick={handleBrowse}>
                    浏览
                  </button>
                </div>
                <datalist id="work-dir-suggestions">
                  <option value="/home/user/my-Agent" />
                  <option value="/home/user/my-Agent/backend" />
                  <option value="/home/user" />
                  <option value="/tmp" />
                </datalist>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Temperature ({form.temperature})</label>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.1"
                    value={form.temperature}
                    onChange={(e) => setField('temperature', parseFloat(e.target.value))}
                  />
                </div>
                {/* maxTokens 已移至「模型设置」：添加模型时按模型预设设置，随 modelOverrides 生效。
                    此处不再展示输入框；form.max_tokens 保留仅作向后兼容（值固定 65535 与后端
                    config.defaultMaxTokens 兜底一致，保存时不改变后端兜底值） */}
              </div>
              <div className="form-group">
                <label>LLM 超时时间（秒） — 当前 {Math.round(form.llm_timeout_ms / 1000)}s</label>
                <input
                  type="range"
                  min={30}
                  max={600}
                  step={10}
                  value={form.llm_timeout_ms / 1000}
                  onChange={(e) => setField('llm_timeout_ms', parseInt(e.target.value) * 1000)}
                />
                <div className="timeout-labels">
                  <span>30s</span>
                  <span>120s</span>
                  <span>300s</span>
                  <span>600s</span>
                </div>
              </div>

              {/* 思考模式区块（当前模型 / 开启思考开关 / 按能力动态的强度滑杆），固定在常规 tab 最下面 */}
              <div className={`form-group thinking-slider-group${effectiveThinkingLevel === 'xhigh' ? ' fire-active' : ''}`}>
                {/* 当前模型（模型设置选中预设 → 服务端全局默认 → 未配置提示） */}
                <div className="current-model-row">
                  <span className="current-model-label">当前模型</span>
                  <span className="current-model-value">{currentModelLabel}</span>
                </div>
                {/* 「开启思考」总开关（三种能力模式均显示）：
                    levels 关闭 = enable_thinking=false（levels 档位无 off，关闭由开关统一控制，
                    旧配置 thinking_level='off' 残留由 handleThinkingToggle/归一化处理）；
                    switch（Qwen）enable_thinking 即开关；none 无强度设置，仅开关生效 */}
                <div className="thinking-switch-row">
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={form.enable_thinking}
                      onChange={(e) => handleThinkingToggle(e.target.checked)}
                    />
                    <span className="toggle-slider" />
                  </label>
                  <span className="thinking-switch-label">
                    {form.enable_thinking ? '思考已开启（模型会先思考再回答）' : '思考已关闭（模型直接回答）'}
                  </span>
                </div>
                {/* levels 模式：按当前模型能力动态渲染级别（DeepSeek: 低/高/最高；GPT-5/Claude: 5 级，无「关闭」档） */}
                {form.enable_thinking && thinkingCap?.mode === 'levels' && (
                  <>
                    <label>{thinkingCap?.label || '推理深度'} — {thinkingLevelLabel}</label>
                    <div className="thinking-slider-wrapper">
                      <div className="thinking-labels">
                        {capLevels.map((l) => (
                          <span key={l.value} className={effectiveThinkingLevel === l.value ? (l.value === 'xhigh' ? 'active fire-label' : 'active') : ''}>
                            {l.label}
                          </span>
                        ))}
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={capLevels.length - 1}
                        step="1"
                        value={thinkingSliderIndex}
                        onChange={(e) => setField('thinking_level', capLevels[parseInt(e.target.value)]?.value || 'high')}
                        className="thinking-slider"
                      />
                      <div className="thinking-fire-particles">
                        <span className="fire-particle p1" /><span className="fire-particle p2" />
                        <span className="fire-particle p3" /><span className="fire-particle p4" />
                        <span className="fire-particle p5" /><span className="fire-particle p6" />
                      </div>
                    </div>
                  </>
                )}
                {/* switch 模式（Qwen）：开启时显示思考预算 / 保留历史配置 */}
                {form.enable_thinking && thinkingCap?.mode === 'switch' && (
                  <>
                    {thinkingCap?.switchConfig?.supportsBudget && (
                      <div className="form-group" style={{ marginTop: 12 }}>
                        <label>思考 Token 预算（限制思考过程长度）</label>
                        <input
                          type="range"
                          min={0}
                          max={thinkingCap.switchConfig.budgetMax}
                          step={256}
                          value={form.thinking_budget}
                          onChange={(e) => setField('thinking_budget', parseInt(e.target.value))}
                        />
                        <span className="thinking-budget-value">
                          {form.thinking_budget > 0 ? `${form.thinking_budget} tokens` : '不限制'}
                        </span>
                      </div>
                    )}
                    {thinkingCap?.switchConfig?.supportsPreserve && (
                      <div className="thinking-switch-row" style={{ marginTop: 8 }}>
                        <label className="toggle-switch small">
                          <input
                            type="checkbox"
                            checked={form.preserve_thinking}
                            onChange={(e) => setField('preserve_thinking', e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                        <span className="thinking-switch-label">保留历史思考痕迹（多轮对话时有用）</span>
                      </div>
                    )}
                  </>
                )}
                {thinkingCap?.mode === 'none' && (
                  <label className="thinking-none-hint">当前模型不支持思考模式</label>
                )}
              </div>
            </>
          )}

          {tab === 'agent' && <AgentLimitPanel />}

          {tab === 'presets' && (
            <>
              <div className="settings-section-desc">
                选中的模型为默认使用（可在对话框输入 /model 快速切换）。选中后会自动同步保存到服务端，
                作为你的全局默认模型（其他设备/不带模型参数的新会话也使用它）。未选中任何模型时，
                新建会话会提示「未配置默认模型，请在设置→模型设置中选择模型」。
              </div>
              {presets.map((p, i) => (
                <div key={`${p.name}-${i}`} className={`preset-item${activePreset === p.name ? ' active' : ''}`}>
                  <label className="preset-radio">
                    <input
                      type="radio"
                      name="preset-select"
                      checked={activePreset === p.name}
                      onChange={() => handleSelectPreset(p.name)}
                    />
                  </label>
                  <div className="preset-info">
                    <div className="preset-name">
                      {p.name}
                      {activePreset === p.name && <span className="model-default-badge">默认使用</span>}
                    </div>
                    <div className="preset-meta">{p.model} · {p.baseUrl}{p.apiKey ? '' : ' · 无 API Key'} · maxTokens: {p.maxTokens ?? 65535}</div>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleStartEditPreset(i)}>编辑</button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeletePreset(i)}>删除</button>
                </div>
              ))}
              <button className="btn btn-secondary" onClick={handleStartAddPreset} style={{ marginTop: 8 }}>
                + 新增模型
              </button>
            </>
          )}

          {editingPreset && (
            <div className="modal-overlay">
              <ResizableModal width={480} onEsc={() => setEditingPreset(null)}>
                <div className="modal-header">
                  <h2>{editingPreset.index === 'new' ? '新增模型' : '编辑模型'}</h2>
                  <button className="modal-close-btn" onClick={() => setEditingPreset(null)}>&#10005;</button>
                </div>
                <div className="body" style={{ paddingTop: 10 }}>
                  <div className="form-group">
                    <label>模型名称</label>
                    <input
                      type="text"
                      value={editingPreset.name}
                      onChange={(e) => setEditingPreset({ ...editingPreset, name: e.target.value })}
                      placeholder="如：DeepSeek / GPT-5 / 本地Qwen"
                    />
                  </div>
                  <div className="form-group">
                    <label>Base URL</label>
                    <input
                      type="text"
                      value={editingPreset.baseUrl}
                      onChange={(e) => setEditingPreset({ ...editingPreset, baseUrl: e.target.value })}
                      placeholder="http://host:port/v1"
                    />
                    <div className="settings-field-hint">
                      API 基地址（如 http://host:port/v1），不要包含 /chat/completions（已支持自动兼容）
                    </div>
                  </div>
                  <div className="form-group">
                    <label>模型 ID</label>
                    <input
                      type="text"
                      value={editingPreset.model}
                      onChange={(e) => setEditingPreset({ ...editingPreset, model: e.target.value })}
                      placeholder="模型 ID"
                    />
                  </div>
                  <div className="form-group">
                    <label>API Key（可选）</label>
                    <input
                      type="password"
                      value={editingPreset.apiKey}
                      onChange={(e) => setEditingPreset({ ...editingPreset, apiKey: e.target.value })}
                      placeholder="无需认证可留空"
                    />
                  </div>
                  <div className="form-group">
                    <label>最大输出 Tokens</label>
                    <input
                      type="number"
                      value={editingPreset.maxTokens}
                      onChange={(e) => setEditingPreset({ ...editingPreset, maxTokens: parseInt(e.target.value) || 65535 })}
                      min={1}
                      max={128000}
                      step={100}
                    />
                    <div className="settings-field-hint">最大输出 token 数（回复长度上限），默认 65535</div>
                  </div>
                </div>
                <div className="foot">
                  <button className="btn btn-secondary" onClick={handlePresetTest} disabled={presetTesting}>
                    {presetTesting ? '测试中...' : '测试连接'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setEditingPreset(null)}>取消</button>
                  <button className="btn btn-primary" onClick={handleSavePreset}>
                    {editingPreset.index === 'new' ? '保存模型' : '保存修改'}
                  </button>
                </div>
              </ResizableModal>
            </div>
          )}

          {tab === 'permissions' && <PermissionsPanel />}

          {tab === 'memory' && <MemoryPanel />}

          {tab === 'advanced' && (
            <>
              <div className="settings-section-desc">
                新功能（上下文压缩 / 子代理 / 跨会话记忆 / 危险命令 / 网络搜索）的运行参数，保存在服务端
                data/advanced-config.json，修改后立即生效，无需重启。留空或非法输入会被后端拒绝并提示。
              </div>

              {/* 对话压缩 */}
              <div className="settings-section-title">对话压缩（上下文过长时自动摘要历史）</div>
              <div className="form-group">
                <label>压缩触发阈值 — {Math.round(adv.compaction.threshold * 100)}%</label>
                <input
                  type="range"
                  min={50}
                  max={95}
                  step={5}
                  value={Math.round(adv.compaction.threshold * 100)}
                  onChange={(e) => setAdvancedNested('compaction', 'threshold', parseInt(e.target.value) / 100)}
                />
                <div className="settings-field-hint">
                  上下文用量达到该比例时自动压缩（50%-95%）。调低更早压缩、更省 token；调高保留更多上下文。
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>尾部最少保留轮数（{adv.compaction.minTurns} 轮）</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={adv.compaction.minTurns}
                    onChange={(e) => setAdvancedNested('compaction', 'minTurns', parseInt(e.target.value) || 4)}
                  />
                  <div className="settings-field-hint">压缩后最近 N 轮对话完整保留，供 Agent 感知最新进展</div>
                </div>
                <div className="form-group">
                  <label>摘要辅助模型</label>
                  <select
                    value={adv.summaryModel}
                    onChange={(e) => setAdvanced({ summaryModel: e.target.value as 'auto' | 'main' })}
                  >
                    <option value="auto">自动（优先 DeepSeek，失败回退主模型）</option>
                    <option value="main">主模型（使用当前对话模型生成摘要）</option>
                  </select>
                  <div className="settings-field-hint">auto 时若配置了 DEEPSEEK_API_KEY 则用 DeepSeek 生成摘要，更省主模型额度</div>
                </div>
              </div>

              {/* 子代理 */}
              <hr className="settings-divider" />
              <div className="settings-section-title">子代理（subagent 工具）</div>
              <div className="form-row">
                <div className="form-group">
                  <label>最大轮数（{adv.subagent.maxTurns} 轮）</label>
                  <input
                    type="number"
                    min={1}
                    max={1000}
                    value={adv.subagent.maxTurns}
                    onChange={(e) => setAdvancedNested('subagent', 'maxTurns', parseInt(e.target.value) || 50)}
                  />
                  <div className="settings-field-hint">子代理最多执行多少轮（LLM 调用次数），1-1000，防止子任务失控</div>
                </div>
                <div className="form-group">
                  <label>超时时间（{Math.round(adv.subagent.timeoutMs / 1000)} 秒）</label>
                  <input
                    type="number"
                    min={1}
                    max={3600}
                    value={Math.round(adv.subagent.timeoutMs / 1000)}
                    onChange={(e) => setAdvancedNested('subagent', 'timeoutMs', (parseInt(e.target.value) || 1800) * 1000)}
                  />
                  <div className="settings-field-hint">子代理整体超时（秒），1-3600，超时自动中止并返回已有结果</div>
                </div>
                <div className="form-group">
                  <label>最大并发数（{adv.subagent.maxConcurrent} 个）</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={adv.subagent.maxConcurrent}
                    onChange={(e) => setAdvancedNested('subagent', 'maxConcurrent', parseInt(e.target.value) || 5)}
                  />
                  <div className="settings-field-hint">同一会话同时运行的子代理数上限，1-20。主代理一次派多个子代理会并行执行，此项仅防失控</div>
                </div>
              </div>

              {/* 记忆 */}
              <hr className="settings-divider" />
              <div className="settings-section-title">跨会话记忆</div>
              <div className="form-row">
                <div className="form-group">
                  <label>最大条目数（{adv.memory.maxEntries} 条）</label>
                  <input
                    type="number"
                    min={50}
                    max={5000}
                    step={10}
                    value={adv.memory.maxEntries}
                    onChange={(e) => setAdvancedNested('memory', 'maxEntries', parseInt(e.target.value) || 500)}
                  />
                  <div className="settings-field-hint">记忆条数超过上限时自动删除最旧条目，防止文件无限膨胀</div>
                </div>
                <div className="form-group">
                  <label>单条长度上限（{adv.memory.maxNoteLength} 字符）</label>
                  <input
                    type="number"
                    min={100}
                    max={10000}
                    step={100}
                    value={adv.memory.maxNoteLength}
                    onChange={(e) => setAdvancedNested('memory', 'maxNoteLength', parseInt(e.target.value) || 2000)}
                  />
                  <div className="settings-field-hint">Agent 调用记住（remember）工具时的单条内容长度限制</div>
                </div>
              </div>

              {/* 危险命令 */}
              <hr className="settings-divider" />
              <div className="settings-section-title">危险命令黑名单</div>
              <div className="form-group">
                <textarea
                  rows={5}
                  value={(adv.commandBlacklist ?? []).join('\n')}
                  onChange={(e) =>
                    setAdvanced({
                      commandBlacklist: e.target.value
                        .split('\n')
                        .map((s) => s.trim())
                        .filter(Boolean),
                    })
                  }
                  placeholder={'sudo\nmkfs\ndd\nrm -rf /'}
                  style={{ fontFamily: 'monospace' }}
                />
                <div className="settings-field-hint">
                  一行一个命令（如 sudo、rm -rf /）。代码内置底线保护（sudo/mkfs/dd 等）始终生效、无法移除，
                  这里只增不减；保存后立即阻止所有匹配该命令开头的执行请求。
                </div>
              </div>

              {/* 网络搜索 */}
              <hr className="settings-divider" />
              <div className="settings-section-title">网络搜索</div>
              <div className="form-row">
                <div className="form-group">
                  <label>超时时间（{Math.round(adv.search.timeoutMs / 1000)} 秒）</label>
                  <input
                    type="number"
                    min={1}
                    max={600}
                    value={Math.round(adv.search.timeoutMs / 1000)}
                    onChange={(e) => setAdvancedNested('search', 'timeoutMs', (parseInt(e.target.value) || 15) * 1000)}
                  />
                  <div className="settings-field-hint">单次搜索请求的最大等待时间（秒）</div>
                </div>
                <div className="form-group">
                  <label>最大结果数（{adv.search.maxResults} 条）</label>
                  <input
                    type="number"
                    min={1}
                    max={20}
                    value={adv.search.maxResults}
                    onChange={(e) => setAdvancedNested('search', 'maxResults', parseInt(e.target.value) || 8)}
                  />
                  <div className="settings-field-hint">Agent 搜索时默认返回的结果条数</div>
                </div>
              </div>
            </>
          )}

          {tab === 'mcp' && (
            <>
              <div className="settings-section-desc">
                MCP（Model Context Protocol）外部服务为 Agent 提供额外工具。
                服务保存在服务端 data/mcp-servers.json；外部 MCP 服务需本机可执行（如 npx）；改动后新建会话生效。
                内置服务删除后如需恢复，可新增：名称「内置服务」、命令「node」、参数「mcp/src/index.js」。
              </div>

              {/* 服务列表 */}
              {mcpServers.length === 0 && (
                <div className="settings-field-hint" style={{ marginBottom: 8 }}>
                  暂无 MCP 服务，可在下方新增
                </div>
              )}
              {mcpServers.map((srv) => (
                <div key={srv.name} className="mcp-server-item">
                  <div className="mcp-server-info">
                    <div className="mcp-server-name-row">
                      <span className="mcp-server-name">{srv.name}</span>
                      <span className={`mcp-server-badge${srv.enabled ? ' on' : ' off'}`}>
                        {srv.enabled ? '已启用' : '已停用'}
                      </span>
                      {srv.command === 'node' && srv.args[0] === 'mcp/src/index.js' && (
                        <span className="mcp-server-badge builtin">内置</span>
                      )}
                    </div>
                    <div className="mcp-server-meta">{srv.command} {srv.args.join(' ')}</div>
                    {srv.description && <div className="mcp-server-desc">{srv.description}</div>}
                    {!srv.enabled && (
                      <div className="mcp-server-hint">停用的服务不会启动子进程、不提供工具</div>
                    )}
                  </div>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => handleMcpToggle(srv)}
                  >
                    {srv.enabled ? '停用' : '启用'}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleMcpDelete(srv)}>
                    删除
                  </button>
                </div>
              ))}

              {/* 新增入口（弹窗） */}
              <button className="btn btn-secondary" onClick={() => setShowMcpModal(true)} style={{ marginBottom: 12 }}>
                + 新增外部 MCP 服务
              </button>
            </>
          )}

          {showMcpModal && (
            <div className="modal-overlay">
              <ResizableModal width={480} onEsc={() => setShowMcpModal(false)}>
                <div className="modal-header">
                  <h2>新增外部 MCP 服务</h2>
                  <button className="modal-close-btn" onClick={() => setShowMcpModal(false)}>&#10005;</button>
                </div>
                <div className="body" style={{ paddingTop: 10 }}>
                  <div className="form-group">
                    <label>服务名称</label>
                    <input
                      type="text"
                      value={mcpForm.name}
                      onChange={(e) => setMcpForm({ ...mcpForm, name: e.target.value })}
                      placeholder="如：filesystem（字母/数字/下划线/连字符，1-32 位）"
                    />
                    <div className="settings-field-hint">唯一名称，作为工具名前缀（外部服务工具显示为 mcp__名称__工具名）</div>
                  </div>
                  <div className="form-group">
                    <label>命令</label>
                    <input
                      type="text"
                      value={mcpForm.command}
                      onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })}
                      placeholder="如：npx"
                    />
                    <div className="settings-field-hint">可执行命令（如 node、npx、python3），仅允许常见可执行名</div>
                  </div>
                  <div className="form-group">
                    <label>参数（逗号分隔）</label>
                    <input
                      type="text"
                      value={mcpForm.args}
                      onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })}
                      placeholder="如：-y, @modelcontextprotocol/server-filesystem, /tmp"
                    />
                  </div>
                  <div className="form-group">
                    <label>描述</label>
                    <input
                      type="text"
                      value={mcpForm.description}
                      onChange={(e) => setMcpForm({ ...mcpForm, description: e.target.value })}
                      placeholder="该服务提供哪些工具（可留空）"
                    />
                  </div>
                </div>
                <div className="foot">
                  <span className="settings-field-hint" style={{ alignSelf: 'center' }}>
                    新增后请新建会话使用新工具
                  </span>
                  <button className="btn btn-secondary" onClick={() => setShowMcpModal(false)}>取消</button>
                  <button className="btn btn-primary" onClick={handleMcpAdd} disabled={mcpSaving}>
                    {mcpSaving ? '保存中...' : '添加'}
                  </button>
                </div>
              </ResizableModal>
            </div>
          )}

          {tab === 'extensions' && <ExtensionsPanel />}

          {tab === 'external' && <ExternalPanel />}

          {tab === 'user' && <UserPanel />}

          </div>
        </div>
        {/* 底部保存栏：位置固定在弹窗底部（视觉不变），但**内容由当前激活的域通过
            useSettingsForm().setFooter 自行提供** —— 壳不再按 tab 分派保存动作，
            也不再维护"哪些 tab 无保存语义"的排除清单（2026-10 架构改造）。 */}
        {footer && <div className="settings-bottom-bar">{footer}</div>}
        {browsing && (
          <DirBrowser
            currentPath={form.work_dir}
            onSelect={(path) => setField('work_dir', path)}
            onClose={() => setBrowsing(false)}
          />
        )}
    </ResizableModal>
    </div>
  );
}
