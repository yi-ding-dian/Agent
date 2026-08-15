import { useState, useEffect, useCallback } from 'react';
import { useChatStore } from '../../store/chat-store';
import { useAuthStore } from '../../store/auth-store';
import type { AdvancedConfig, ConfigData, ExtensionInfo, McpServerConfig, ToolPermissionValue } from '../../types/api';
import * as api from '../../services/api';
import {
  getModelPresets,
  saveModelPresets,
  getActivePresetName,
  setActivePresetName,
  getLlmOverrides,
  type ModelPreset,
} from '../../services/api-config';

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsTab = 'common' | 'agent' | 'presets' | 'permissions' | 'memory' | 'user' | 'advanced' | 'mcp' | 'extensions' | 'external';

// 高级设置默认值（与后端 data/advanced-config.json 默认一致，供 GET 未返回时兜底）
const DEFAULT_ADVANCED: AdvancedConfig = {
  compaction: {
    threshold: 0.8,
    tailRatio: 0.2,
    cooldownMs: 60000,
    minGainRatio: 1.1,
    minTurns: 4,
    headMessages: 2,
  },
  subagent: { maxTurns: 50, timeoutMs: 1800000 },
  memory: { maxEntries: 500, maxNoteLength: 2000 },
  commandBlacklist: ['sudo', 'mkfs', 'dd', 'rm -rf /', 'chmod 777', 'mkfs.ext4'],
  search: { timeoutMs: 15000, maxResults: 8 },
  summaryModel: 'auto',
};

// 工具权限配置：工具名 → 中文名（未知工具名兜底显示原名）
const TOOL_LABELS: Record<string, string> = {
  execute_command: '执行命令',
  run_python: '运行 Python',
  read_file: '读取文件',
  write_file: '写入文件',
  edit_file: '编辑文件',
  search_web: '网络搜索',
  grep_search: '文本搜索',
  list_files: '列出文件',
  run_skill: '运行技能',
  remember: '记住信息',
  subagent: '子代理',
};

const DEFAULT_PERMISSIONS: Record<string, ToolPermissionValue> = {
  execute_command: 'ask',
  run_python: 'ask',
  read_file: 'allow',
  write_file: 'allow',
  edit_file: 'allow',
  search_web: 'allow',
  grep_search: 'allow',
  list_files: 'allow',
  run_skill: 'allow',
  remember: 'allow',
  subagent: 'allow',
};

function DirBrowser({
  currentPath,
  onSelect,
  onClose,
}: {
  currentPath: string;
  onSelect: (path: string) => void;
  onClose: () => void;
}) {
  const [dirPath, setDirPath] = useState(currentPath);
  const [entries, setEntries] = useState<{ dirs: string[]; files: string[]; parent: string | null }>({ dirs: [], files: [], parent: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadDir = useCallback(async (path: string) => {
    setLoading(true);
    setError('');
    try {
      const data = await api.listDirectory(path);
      setEntries({ dirs: data.directories, files: data.files, parent: data.parent });
    } catch (e: any) {
      setError(e.message || '读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDir(dirPath);
  }, [dirPath, loadDir]);

  return (
    <div className="dir-browser-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dir-browser">
        <div className="dir-browser-header">
          <span className="dir-browser-title">选择目录</span>
          <button className="modal-close-btn" onClick={onClose}>&#10005;</button>
        </div>
        <div className="dir-browser-path">{dirPath}</div>
        <div className="dir-browser-list">
          {loading && <div className="dir-browser-loading">加载中...</div>}
          {error && <div className="dir-browser-error">{error}</div>}
          {!loading && !error && entries.parent !== null && (
            <div className="dir-browser-item dir-browser-up" onClick={() => setDirPath(entries.parent!)}>
              ..
            </div>
          )}
          {!loading && !error && entries.dirs.map((d) => (
            <div key={d} className="dir-browser-item dir-browser-dir" onClick={() => setDirPath(`${dirPath}/${d}`.replace(/\/+/g, '/'))}>
              &#128193; {d}
            </div>
          ))}
          {!loading && !error && entries.files.map((f) => (
            <div key={f} className="dir-browser-item dir-browser-file">
              &#128196; {f}
            </div>
          ))}
          {!loading && !error && entries.dirs.length === 0 && entries.files.length === 0 && (
            <div className="dir-browser-empty">空目录</div>
          )}
        </div>
        <div className="dir-browser-footer">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-primary" onClick={() => { onSelect(dirPath); onClose(); }}>选择此目录</button>
        </div>
      </div>
    </div>
  );
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  const config = useChatStore((s) => s.config);
  const saveConfig = useChatStore((s) => s.saveConfig);

  const [form, setForm] = useState<ConfigData>({
    // 不再有出厂默认模型：base_url/model/api_key 初始为空（真实值由 GET /api/config 覆盖）
    base_url: '',
    api_key: '',
    model: '',
    system_prompt: '你是一个智能助手，可以帮助用户解决各种问题。',
    temperature: 0.7,
    max_tokens: 2000,
    thinking_level: 'medium',
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
    advanced: { ...DEFAULT_ADVANCED },
  });

  const [tab, setTab] = useState<SettingsTab>('common');
  const [saving, setSaving] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // 跨会话记忆（第 6 个 tab：记忆管理）
  const [memoryText, setMemoryText] = useState('');
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryStatus, setMemoryStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [memoryDistilling, setMemoryDistilling] = useState(false);
  // MCP 外部 server（第 9 个 tab：MCP 服务）
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '', description: '' });
  const [mcpStatus, setMcpStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [mcpSaving, setMcpSaving] = useState(false);
  // 扩展（第 10 个 tab：扩展管理）
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [extensionsStatus, setExtensionsStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [extensionsLoading, setExtensionsLoading] = useState(false);
  // 外部服务（第 11 个 tab：知识库查询链接）
  const [extUrl, setExtUrl] = useState('');
  const [extStatus, setExtStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [extTesting, setExtTesting] = useState(false);
  const [extSaving, setExtSaving] = useState(false);
  // 模型预设（localStorage；选中项会同步 POST /api/global-model 持久化到服务端作为该用户的
  // 全局默认模型 —— 后端创建会话时 modelOverrides 与全局默认都无才报错）
  const [presets, setPresets] = useState<ModelPreset[]>(() => getModelPresets());
  const [activePreset, setActivePreset] = useState<string | null>(() => getActivePresetName());
  const [editingPreset, setEditingPreset] = useState<{ index: number | 'new'; name: string; baseUrl: string; model: string; apiKey: string } | null>(null);
  const [avatar, setAvatar] = useState<string>(() => localStorage.getItem('myagent_avatar') || '');
  const user = useAuthStore((s) => s.user);

  const RATE_FIELDS: Record<string, { min: number; max: number; def: number; label: string }> = {
    tool_rate_limit_per_minute: { min: 10, max: 50, def: 50, label: '每分钟最多工具调用' },
    agent_max_tool_calls_per_turn: { min: 20, max: 100, def: 100, label: '单轮最多工具调用' },
    agent_max_consecutive_errors: { min: 5, max: 20, def: 5, label: '连续错误上限' },
    agent_max_turns: { min: 10, max: 100, def: 100, label: '最大对话轮数' },
  };

  const handleRateLimitBlur = (field: string) => {
    const range = RATE_FIELDS[field];
    const val = form[field as keyof ConfigData] as number;
    if (val < range.min || val > range.max) {
      setForm((prev) => ({ ...prev, [field]: range.def }));
    }
  };

  useEffect(() => {
    if (config) {
      setForm((prev) => ({ ...prev, ...config }));
    }
  }, [config]);

  // 切换到记忆管理 tab 时加载当前记忆全文
  useEffect(() => {
    if (tab === 'memory') {
      setMemoryStatus(null);
      api.getMemory()
        .then((d) => setMemoryText(d.content || ''))
        .catch((e: any) => setMemoryStatus({ ok: false, msg: e.message }));
    }
  }, [tab]);

  // 切换到 MCP 服务 tab 时加载 server 列表
  useEffect(() => {
    if (tab === 'mcp') {
      setMcpStatus(null);
      api.listMcpServers()
        .then((d) => setMcpServers(d.servers || []))
        .catch((e: any) => setMcpStatus({ ok: false, msg: e.message }));
    }
  }, [tab]);

  // 切换到扩展 tab 时加载扩展列表
  useEffect(() => {
    if (tab === 'extensions') {
      setExtensionsStatus(null);
      setExtensionsLoading(true);
      api.listExtensions()
        .then((list) => setExtensions(list))
        .catch((e: any) => setExtensionsStatus({ ok: false, msg: e.message || '加载扩展列表失败' }))
        .finally(() => setExtensionsLoading(false));
    }
  }, [tab]);

  // 切换到外部服务 tab 时加载当前配置
  useEffect(() => {
    if (tab === 'external') {
      setExtStatus(null);
      api.getExternalService()
        .then((d) => setExtUrl(d.kbQueryUrl || ''))
        .catch((e: any) => setExtStatus({ ok: false, msg: e.message }));
    }
  }, [tab]);

  const handleChange = (field: keyof ConfigData, value: string | number | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  // ─── 工具权限 ───────────────────────

  const handleToolPermissionChange = (name: string, value: ToolPermissionValue) => {
    setForm((prev) => ({
      ...prev,
      tool_permissions: { ...(prev.tool_permissions || {}), [name]: value },
    }));
  };

  // 固定工具列表 + 后端返回的额外工具键（扩展工具/MCP 工具）
  const permissionTools = Array.from(new Set([
    ...Object.keys(DEFAULT_PERMISSIONS),
    ...Object.keys(form.tool_permissions || {}),
  ]));

  const handleSave = async () => {
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

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { alert('头像图片不能超过 2MB'); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      setAvatar(dataUrl);
      localStorage.setItem('myagent_avatar', dataUrl);
    };
    reader.readAsDataURL(file);
  };

  // ─── 模型预设操作（即时写入 localStorage，并同步 POST /api/global-model 持久化到服务端） ───

  const handleSelectPreset = (name: string) => {
    const preset = presets.find((p) => p.name === name);
    setActivePresetName(name);
    setActivePreset(name);
    // 同步保存该预设为该用户的全局默认模型（后端创建会话时无 overrides 则使用它）。
    // 失败静默：不影响本地选中，本地选中本身已随请求经 modelOverrides 生效。
    if (preset) {
      api.saveGlobalModel({ id: preset.model, baseUrl: preset.baseUrl, apiKey: preset.apiKey })
        .catch(() => {});
    }
  };

  // 打开设置时恢复服务端全局默认：本地无选中预设且后端有全局默认 → 恢复选中。
  // 后端为权威来源（服务端会话不带 modelOverrides 时使用它）；若该模型不在预设列表，
  // 自动补一个临时预设显示并选中（写入 localStorage presets），保证本地与后端一致。
  // 同时兼容旧版本：localStorage 手动配置（三个 key）且未选中预设 → 一并同步到服务端。
  useEffect(() => {
    if (getActivePresetName()) return;
    api.getGlobalModel()
      .then((gm) => {
        if (!gm?.id || !gm?.baseUrl) return;
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

  const handleStartAddPreset = () => {
    setEditingPreset({ index: 'new', name: '', baseUrl: '', model: '', apiKey: '' });
  };

  const handleStartEditPreset = (index: number) => {
    const p = presets[index];
    if (!p) return;
    setEditingPreset({ index, name: p.name, baseUrl: p.baseUrl, model: p.model, apiKey: p.apiKey });
  };

  const handleSavePreset = () => {
    if (!editingPreset) return;
    const name = editingPreset.name.trim();
    const baseUrl = editingPreset.baseUrl.trim();
    const model = editingPreset.model.trim();
    if (!name || !baseUrl || !model) {
      alert('预设名称、Base URL 和模型为必填项');
      return;
    }
    if (presets.some((p, i) => i !== editingPreset.index && p.name.trim().toLowerCase() === name.toLowerCase())) {
      alert(`预设名称 "${name}" 已存在`);
      return;
    }
    const apiKey = editingPreset.apiKey.trim();
    const next = editingPreset.index === 'new'
      ? [...presets, { name, baseUrl, model, apiKey, apiFormat: 'openai-completions' as const }]
      : presets.map((p, i) => (i === editingPreset.index ? { ...p, name, baseUrl, model, apiKey } : p));
    setPresets(next);
    saveModelPresets(next);
    // 编辑的是当前选中项且名称被修改 → 同步选中名称
    if (editingPreset.index !== 'new' && activePreset === presets[editingPreset.index].name && activePreset !== name) {
      setActivePresetName(name);
      setActivePreset(name);
    }
    setEditingPreset(null);
  };

  const handleDeletePreset = (index: number) => {
    const target = presets[index];
    if (!target) return;
    if (!window.confirm(`删除预设 "${target.name}"？`)) return;
    const next = presets.filter((_, i) => i !== index);
    setPresets(next);
    saveModelPresets(next);
    if (activePreset === target.name) {
      setActivePresetName(null);
      setActivePreset(null);
    }
    if (editingPreset && editingPreset.index === index) setEditingPreset(null);
  };

  // ─── 记忆管理（跨会话记忆） ───────────────────

  const handleSaveMemory = async (content?: string) => {
    const target = content !== undefined ? content : memoryText;
    setMemorySaving(true);
    setMemoryStatus(null);
    try {
      await api.saveMemory(target);
      setMemoryStatus({ ok: true, msg: '记忆已保存，将在下次创建会话时注入' });
    } catch (e: any) {
      setMemoryStatus({ ok: false, msg: e.message });
    } finally {
      setMemorySaving(false);
    }
  };

  const handleClearMemory = () => {
    if (!window.confirm('确定清空全部记忆吗？此操作不可撤销。')) return;
    setMemoryText('');
    handleSaveMemory('');
  };

  const handleDistillMemory = async () => {
    setMemoryDistilling(true);
    setMemoryStatus(null);
    try {
      const r = await api.distillMemory();
      if (r.success) {
        setMemoryStatus({
          ok: true,
          msg: `蒸馏完成：${r.distilled} 条记忆 → ${r.result} 条精炼记忆`,
        });
        // 蒸馏成功后重新拉取全文刷新编辑器
        const d = await api.getMemory();
        setMemoryText(d.content || '');
      } else {
        setMemoryStatus({ ok: false, msg: r.error || '记忆蒸馏失败' });
      }
    } catch (e: any) {
      setMemoryStatus({ ok: false, msg: e.message });
    } finally {
      setMemoryDistilling(false);
    }
  };

  // ─── MCP 外部 server（第 9 个 tab） ───────────────────

  const handleMcpToggle = async (srv: McpServerConfig) => {
    setMcpStatus(null);
    try {
      const cfg = await api.updateMcpServer(srv.name, { enabled: !srv.enabled });
      setMcpServers(cfg.servers || []);
      setMcpStatus({ ok: true, msg: `已${srv.enabled ? '停用' : '启用'}「${srv.name}」，新建会话生效` });
    } catch (e: any) {
      setMcpStatus({ ok: false, msg: e.message });
    }
  };

  const handleMcpDelete = async (srv: McpServerConfig) => {
    if (!window.confirm(`确定删除 MCP 服务「${srv.name}」吗？其工具将不再可用。`)) return;
    setMcpStatus(null);
    try {
      const cfg = await api.deleteMcpServer(srv.name);
      setMcpServers(cfg.servers || []);
      setMcpStatus({ ok: true, msg: `已删除「${srv.name}」` });
    } catch (e: any) {
      setMcpStatus({ ok: false, msg: e.message });
    }
  };

  const handleMcpAdd = async () => {
    const name = mcpForm.name.trim();
    const command = mcpForm.command.trim();
    if (!name || !command) {
      setMcpStatus({ ok: false, msg: '请填写服务名称和命令' });
      return;
    }
    setMcpSaving(true);
    setMcpStatus(null);
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
      setMcpStatus({ ok: true, msg: `已新增「${name}」，新建会话生效` });
    } catch (e: any) {
      setMcpStatus({ ok: false, msg: e.message });
    } finally {
      setMcpSaving(false);
    }
  };

  // ─── 扩展（第 10 个 tab：启停管理） ───

  const handleExtensionToggle = async (ext: ExtensionInfo) => {
    setExtensionsStatus(null);
    try {
      const r = await api.toggleExtension(ext.name);
      // 后端落盘后对新会话即时生效（运行中会话不热更新），本地刷新列表展示新状态
      setExtensions((prev) => prev.map((e) => (e.name === ext.name ? { ...e, enabled: r.enabled } : e)));
      setExtensionsStatus({ ok: true, msg: `已${r.enabled ? '启用' : '停用'}「${ext.name}」，新会话生效` });
    } catch (e: any) {
      setExtensionsStatus({ ok: false, msg: e.message || '切换失败' });
    }
  };

  // ─── 外部服务（知识库查询链接，服务端 data/external-service-config.json） ───

  const handleExtTest = async () => {
    if (!extUrl.trim()) {
      setExtStatus({ ok: false, msg: '请先填写知识库查询链接' });
      return;
    }
    setExtTesting(true);
    setExtStatus(null);
    try {
      const r = await api.testExternalService(extUrl);
      if (r.ok) {
        setExtStatus({ ok: true, msg: `连接正常（${r.latencyMs}ms）` });
      } else {
        setExtStatus({ ok: false, msg: r.error || '连接失败' });
      }
    } catch (e: any) {
      setExtStatus({ ok: false, msg: e.message });
    } finally {
      setExtTesting(false);
    }
  };

  const handleExtSave = async () => {
    setExtSaving(true);
    setExtStatus(null);
    try {
      await api.saveExternalService(extUrl);
      setExtStatus({ ok: true, msg: '外部服务配置已保存，立即生效' });
    } catch (e: any) {
      setExtStatus({ ok: false, msg: e.message || '保存失败' });
    } finally {
      setExtSaving(false);
    }
  };

  // ─── 高级设置（advanced-config：压缩/子代理/记忆/黑名单/搜索） ───

  const [advSaving, setAdvSaving] = useState(false);
  const [advStatus, setAdvStatus] = useState<{ ok: boolean; msg: string } | null>(null);

  const adv = form.advanced ?? DEFAULT_ADVANCED;

  /** 更新 advanced 顶层字段 */
  const setAdv = (patch: Partial<AdvancedConfig>) => {
    setForm((prev) => ({
      ...prev,
      advanced: { ...DEFAULT_ADVANCED, ...(prev.advanced ?? {}), ...patch },
    }));
  };

  /** 更新 advanced 嵌套分组字段（compaction/subagent/memory/search） */
  const setAdvNested = <K extends 'compaction' | 'subagent' | 'memory' | 'search'>(
    group: K,
    field: keyof AdvancedConfig[K],
    value: number,
  ) => {
    setForm((prev) => {
      const cur = prev.advanced ?? DEFAULT_ADVANCED;
      return {
        ...prev,
        advanced: { ...cur, [group]: { ...cur[group], [field]: value } },
      };
    });
  };

  const handleSaveAdvanced = async () => {
    setAdvSaving(true);
    setAdvStatus(null);
    try {
      await api.updateAdvancedConfig(adv);
      setAdvStatus({ ok: true, msg: '高级设置已保存，立即生效' });
    } catch (e: any) {
      setAdvStatus({ ok: false, msg: e.message || '保存失败' });
    } finally {
      setAdvSaving(false);
    }
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="modal settings-modal">
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
                  onChange={(e) => handleChange('system_prompt', e.target.value)}
                  placeholder="系统提示词"
                  rows={3}
                />
              </div>
              <div className="form-group">
                <label>工作目录</label>
                <div className="input-with-btn">
                  <input
                    type="text"
                    value={form.work_dir}
                    onChange={(e) => handleChange('work_dir', e.target.value)}
                    placeholder="输入工作目录路径"
                    list="work-dir-suggestions"
                  />
                  <button type="button" className="btn btn-secondary" onClick={() => setBrowsing(true)}>
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
                    onChange={(e) => handleChange('temperature', parseFloat(e.target.value))}
                  />
                </div>
                <div className="form-group">
                  <label>Max Tokens</label>
                  <input
                    type="number"
                    value={form.max_tokens}
                    onChange={(e) => handleChange('max_tokens', parseInt(e.target.value) || 2000)}
                    min={100}
                    max={128000}
                    step={100}
                  />
                </div>
              </div>
              <div className="form-group">
                <label>LLM 超时时间（秒） — 当前 {Math.round(form.llm_timeout_ms / 1000)}s</label>
                <input
                  type="range"
                  min={30}
                  max={600}
                  step={10}
                  value={form.llm_timeout_ms / 1000}
                  onChange={(e) => handleChange('llm_timeout_ms', parseInt(e.target.value) * 1000)}
                />
                <div className="timeout-labels">
                  <span>30s</span>
                  <span>120s</span>
                  <span>300s</span>
                  <span>600s</span>
                </div>
              </div>
              <div className={`form-group thinking-slider-group${form.thinking_level === 'xhigh' ? ' fire-active' : ''}`}>
                {form.thinking_capability?.mode === 'levels' ? (
                  <>
                    <label>{form.thinking_capability?.label || '推理深度'} — {(() => { const labels: Record<string, string> = { off: '关闭', minimal: '极少', low: '低', medium: '中等', high: '高', xhigh: '极高' }; return labels[form.thinking_level] || form.thinking_level; })()}</label>
                    <div className="thinking-slider-wrapper">
                      <div className="thinking-labels">
                        <span className={form.thinking_level === 'off' ? 'active' : ''}>关闭</span>
                        <span className={form.thinking_level === 'minimal' ? 'active' : ''}>极少</span>
                        <span className={form.thinking_level === 'low' ? 'active' : ''}>低</span>
                        <span className={form.thinking_level === 'medium' ? 'active' : ''}>中等</span>
                        <span className={form.thinking_level === 'high' ? 'active' : ''}>高</span>
                        <span className={form.thinking_level === 'xhigh' ? 'active fire-label' : ''}>极高🔥</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="5"
                        step="1"
                        value={(() => { const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']; return levels.indexOf(form.thinking_level); })()}
                        onChange={(e) => { const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']; handleChange('thinking_level', levels[parseInt(e.target.value)]); }}
                        className="thinking-slider"
                      />
                      <div className="thinking-fire-particles">
                        <span className="fire-particle p1" /><span className="fire-particle p2" />
                        <span className="fire-particle p3" /><span className="fire-particle p4" />
                        <span className="fire-particle p5" /><span className="fire-particle p6" />
                      </div>
                    </div>
                  </>
                ) : form.thinking_capability?.mode === 'switch' ? (
                  <>
                    <label>{form.thinking_capability?.label || '思考模式'}</label>
                    <div className="thinking-switch-row">
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          checked={form.enable_thinking}
                          onChange={(e) => handleChange('enable_thinking', e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                      <span className="thinking-switch-label">
                        {form.enable_thinking ? '已开启（模型会先思考再回答）' : '已关闭（模型直接回答）'}
                      </span>
                    </div>
                    {form.enable_thinking && form.thinking_capability?.switchConfig?.supportsBudget && (
                      <div className="form-group" style={{ marginTop: 12 }}>
                        <label>思考 Token 预算（限制思考过程长度）</label>
                        <input
                          type="range"
                          min={0}
                          max={form.thinking_capability.switchConfig.budgetMax}
                          step={256}
                          value={form.thinking_budget}
                          onChange={(e) => handleChange('thinking_budget', parseInt(e.target.value))}
                        />
                        <span className="thinking-budget-value">
                          {form.thinking_budget > 0 ? `${form.thinking_budget} tokens` : '不限制'}
                        </span>
                      </div>
                    )}
                    {form.enable_thinking && form.thinking_capability?.switchConfig?.supportsPreserve && (
                      <div className="thinking-switch-row" style={{ marginTop: 8 }}>
                        <label className="toggle-switch small">
                          <input
                            type="checkbox"
                            checked={form.preserve_thinking}
                            onChange={(e) => handleChange('preserve_thinking', e.target.checked)}
                          />
                          <span className="toggle-slider" />
                        </label>
                        <span className="thinking-switch-label">保留历史思考痕迹（多轮对话时有用）</span>
                      </div>
                    )}
                  </>
                ) : (
                  <label className="thinking-none-hint">当前模型不支持思考模式</label>
                )}
              </div>
            </>
          )}

          {tab === 'agent' && (
            <>
              <div className="settings-section-title">Agent 限流（超过限制时 Agent 会自动阻断工具调用）</div>
              <div className="settings-section-desc">
                说明：限流配置已由服务端统一管理（data/rate-limit-config.json），
                工具限流执行器已下线，此处修改仅保存配置、暂不强制生效。
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>每分钟最多工具调用（10-50）</label>
                  <input
                    type="number"
                    value={form.tool_rate_limit_per_minute}
                    onChange={(e) => handleChange('tool_rate_limit_per_minute', parseInt(e.target.value) || 0)}
                    onBlur={() => handleRateLimitBlur('tool_rate_limit_per_minute')}
                    min={10}
                    max={50}
                  />
                </div>
                <div className="form-group">
                  <label>单轮最多工具调用（20-100）</label>
                  <input
                    type="number"
                    value={form.agent_max_tool_calls_per_turn}
                    onChange={(e) => handleChange('agent_max_tool_calls_per_turn', parseInt(e.target.value) || 0)}
                    onBlur={() => handleRateLimitBlur('agent_max_tool_calls_per_turn')}
                    min={20}
                    max={100}
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>连续错误上限（5-20）</label>
                  <input
                    type="number"
                    value={form.agent_max_consecutive_errors}
                    onChange={(e) => handleChange('agent_max_consecutive_errors', parseInt(e.target.value) || 0)}
                    onBlur={() => handleRateLimitBlur('agent_max_consecutive_errors')}
                    min={5}
                    max={20}
                  />
                </div>
                <div className="form-group">
                  <label>最大对话轮数（10-100）</label>
                  <input
                    type="number"
                    value={form.agent_max_turns}
                    onChange={(e) => handleChange('agent_max_turns', parseInt(e.target.value) || 0)}
                    onBlur={() => handleRateLimitBlur('agent_max_turns')}
                    min={10}
                    max={100}
                  />
                </div>
              </div>
            </>
          )}

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
                    <div className="preset-meta">{p.model} · {p.baseUrl}{p.apiKey ? '' : ' · 无 API Key'}</div>
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleStartEditPreset(i)}>编辑</button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeletePreset(i)}>删除</button>
                </div>
              ))}
              <button className="btn btn-secondary" onClick={handleStartAddPreset} style={{ marginTop: 8 }}>
                + 新增模型
              </button>
              {editingPreset && (
                <div className="preset-editor">
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
                  <div className="preset-editor-actions">
                    <button className="btn btn-primary" onClick={handleSavePreset}>
                      {editingPreset.index === 'new' ? '保存模型' : '保存修改'}
                    </button>
                    <button className="btn btn-secondary" onClick={() => setEditingPreset(null)}>取消</button>
                  </div>
                </div>
              )}
            </>
          )}

          {tab === 'permissions' && (
            <>
              <div className="settings-section-desc">
                控制每个工具的执行权限：允许=直接执行，询问=执行前弹窗确认，禁止=直接拒绝不执行。
                服务端生效（data/tool-permissions.json），Electron 客户端不强制此配置。执行命令的绝对黑名单（sudo/mkfs/dd 等）始终生效，不受权限配置影响。
              </div>
              {permissionTools.map((name) => (
                <div className="form-group" key={name}>
                  <label>{TOOL_LABELS[name] || name}</label>
                  <select
                    value={form.tool_permissions?.[name] || 'allow'}
                    onChange={(e) => handleToolPermissionChange(name, e.target.value as ToolPermissionValue)}
                  >
                    <option value="allow">允许</option>
                    <option value="ask">询问</option>
                    <option value="deny">禁止</option>
                  </select>
                </div>
              ))}
            </>
          )}

          {tab === 'memory' && (
            <>
              <div className="settings-section-desc">
                记忆会自动注入每次 Agent 对话（服务端会话，含 chat 模式），可在此查看/修改/清空。
                对话中 Agent 可通过 remember 工具追加新记忆；Electron 客户端会话不注入记忆。
              </div>
              <div className="form-group">
                <textarea
                  value={memoryText}
                  onChange={(e) => setMemoryText(e.target.value)}
                  placeholder="暂无记忆内容"
                  rows={14}
                  style={{ fontFamily: 'monospace', whiteSpace: 'pre' }}
                />
              </div>
              <div className="memory-actions">
                <button className="btn btn-primary" onClick={() => handleSaveMemory()} disabled={memorySaving}>
                  {memorySaving ? '保存中...' : '保存记忆'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={handleDistillMemory}
                  disabled={memoryDistilling || memorySaving}
                >
                  {memoryDistilling ? '蒸馏中...' : '蒸馏记忆'}
                </button>
                <button className="btn btn-danger" onClick={handleClearMemory} disabled={memorySaving}>
                  清空
                </button>
              </div>
              <div className="settings-field-hint" style={{ marginTop: 4 }}>
                把旧记忆交给 AI 提炼合并，保留关键信息、精简体积；建议记忆接近上限时使用。
                蒸馏使用 DeepSeek（需配置 DEEPSEEK_API_KEY），失败不影响原记忆。
              </div>
              {memoryStatus && (
                <div className={`test-result ${memoryStatus.ok ? 'success' : 'error'}`}>
                  {memoryStatus.msg}
                </div>
              )}
            </>
          )}

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
                  onChange={(e) => setAdvNested('compaction', 'threshold', parseInt(e.target.value) / 100)}
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
                    onChange={(e) => setAdvNested('compaction', 'minTurns', parseInt(e.target.value) || 4)}
                  />
                  <div className="settings-field-hint">压缩后最近 N 轮对话完整保留，供 Agent 感知最新进展</div>
                </div>
                <div className="form-group">
                  <label>摘要辅助模型</label>
                  <select
                    value={adv.summaryModel}
                    onChange={(e) => setAdv({ summaryModel: e.target.value as 'auto' | 'main' })}
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
                    onChange={(e) => setAdvNested('subagent', 'maxTurns', parseInt(e.target.value) || 50)}
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
                    onChange={(e) => setAdvNested('subagent', 'timeoutMs', (parseInt(e.target.value) || 1800) * 1000)}
                  />
                  <div className="settings-field-hint">子代理整体超时（秒），1-3600，超时自动中止并返回已有结果</div>
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
                    onChange={(e) => setAdvNested('memory', 'maxEntries', parseInt(e.target.value) || 500)}
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
                    onChange={(e) => setAdvNested('memory', 'maxNoteLength', parseInt(e.target.value) || 2000)}
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
                    setAdv({
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
                    onChange={(e) => setAdvNested('search', 'timeoutMs', (parseInt(e.target.value) || 15) * 1000)}
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
                    onChange={(e) => setAdvNested('search', 'maxResults', parseInt(e.target.value) || 8)}
                  />
                  <div className="settings-field-hint">Agent 搜索时默认返回的结果条数</div>
                </div>
              </div>

              <div className="memory-actions" style={{ marginTop: 16 }}>
                <button className="btn btn-primary" onClick={handleSaveAdvanced} disabled={advSaving}>
                  {advSaving ? '保存中...' : '保存高级设置'}
                </button>
                <span className="settings-field-hint" style={{ alignSelf: 'center', marginLeft: 12 }}>
                  保存成功后立即生效，无需重启服务
                </span>
              </div>
              {advStatus && (
                <div className={`test-result ${advStatus.ok ? 'success' : 'error'}`}>{advStatus.msg}</div>
              )}
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

              {/* 新增表单 */}
              <hr className="settings-divider" />
              <div className="settings-section-title">新增外部 MCP 服务</div>
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
              <div className="memory-actions">
                <button className="btn btn-primary" onClick={handleMcpAdd} disabled={mcpSaving}>
                  {mcpSaving ? '保存中...' : '+ 新增服务'}
                </button>
                <span className="settings-field-hint" style={{ alignSelf: 'center', marginLeft: 12 }}>
                  新增/启停后请新建会话使用新工具
                </span>
              </div>
              {mcpStatus && (
                <div className={`test-result ${mcpStatus.ok ? 'success' : 'error'}`}>{mcpStatus.msg}</div>
              )}
            </>
          )}

          {tab === 'extensions' && (
            <>
              <div className="settings-section-desc">
                Pi 扩展为 Agent 提供额外工具、自定义命令与事件钩子（input / before_provider_request /
                tool_call / tool_result）。扩展来源：extensions/node_modules 中的 npm 包（pi.extensions
                manifest）与项目 .pi/extensions 目录扩展。启停切换对新会话/命令列表即时生效，
                运行中的会话不热更新（需新会话使用新配置）。
              </div>
              {extensionsLoading && <div className="settings-field-hint">加载中...</div>}
              {!extensionsLoading && extensions.length === 0 && (
                <div className="settings-field-hint" style={{ marginBottom: 8 }}>
                  未发现扩展
                </div>
              )}
              {extensions.map((ext) => (
                <div key={ext.name} className="mcp-server-item">
                  <div className="mcp-server-info">
                    <div className="mcp-server-name-row">
                      <span className="mcp-server-name">{ext.name}</span>
                      <span className={`mcp-server-badge${ext.enabled ? ' on' : ' off'}`}>
                        {ext.enabled ? '已启用' : '已停用'}
                      </span>
                      <span className={`mcp-server-badge ${ext.source === 'npm' ? 'builtin' : ''}`}>
                        {ext.source === 'npm' ? 'npm' : 'dir'}
                      </span>
                    </div>
                    <div className="mcp-server-meta">
                      工具 {ext.toolCount} 个 · 命令 {ext.commandCount} 个
                    </div>
                    {ext.description && <div className="mcp-server-desc">{ext.description}</div>}
                    {!ext.enabled && (
                      <div className="mcp-server-hint">停用的扩展不提供工具/命令，不触发事件钩子</div>
                    )}
                  </div>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleExtensionToggle(ext)}>
                    {ext.enabled ? '停用' : '启用'}
                  </button>
                </div>
              ))}
              {extensionsStatus && (
                <div className={`test-result ${extensionsStatus.ok ? 'success' : 'error'}`}>
                  {extensionsStatus.msg}
                </div>
              )}
            </>
          )}

          {tab === 'external' && (
            <>
              <div className="settings-section-desc">
                外部知识库服务的查询链接；保存后即时生效（无需重启）。
              </div>
              <div className="form-group">
                <label>知识库查询链接</label>
                <input
                  type="text"
                  value={extUrl}
                  onChange={(e) => setExtUrl(e.target.value)}
                  placeholder="http://<知识库服务地址>:8091/ext-query/<id>?token=xxx"
                />
                <div className="settings-field-hint">
                  从知识库服务获取的查询链接（需含 id 与 token）；留空保存可清除配置。
                </div>
              </div>
              <div className="memory-actions">
                <button className="btn btn-secondary" onClick={handleExtTest} disabled={extTesting}>
                  {extTesting ? '测试中...' : '测试连接'}
                </button>
                <button className="btn btn-primary" onClick={handleExtSave} disabled={extSaving}>
                  {extSaving ? '保存中...' : '保存'}
                </button>
                <span className="settings-field-hint" style={{ alignSelf: 'center', marginLeft: 12 }}>
                  保存成功后立即生效，无需重启服务
                </span>
              </div>
              {extStatus && (
                <div className={`test-result ${extStatus.ok ? 'success' : 'error'}`}>{extStatus.msg}</div>
              )}
            </>
          )}

          {tab === 'user' && (
            <div className="user-settings">
              <div className="user-profile-card">
                <div className="user-avatar-section">
                  <div className="user-avatar" onClick={() => document.getElementById('avatar-input')?.click()}>
                    {avatar ? (
                      <img src={avatar} alt="头像" className="user-avatar-img" />
                    ) : (
                      <span className="user-avatar-letter">{user?.username?.[0]?.toUpperCase() || '?'}</span>
                    )}
                    <div className="user-avatar-overlay">点击更换</div>
                  </div>
                  <input
                    id="avatar-input"
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleAvatarChange}
                  />
                </div>
                <div className="user-info-section">
                  <div className="user-info-row">
                    <span className="user-info-label">用户名</span>
                    <span className="user-info-value">{user?.username || '-'}</span>
                  </div>
                  <div className="user-info-row">
                    <span className="user-info-label">账号</span>
                    <span className="user-info-value">{user?.account || '-'}</span>
                  </div>
                  {user?.last_login_at && (
                    <div className="user-info-row">
                      <span className="user-info-label">上次登录</span>
                      <span className="user-info-value">{user.last_login_at}</span>
                    </div>
                  )}
                </div>
                <button className="btn btn-danger user-logout-btn" onClick={() => useAuthStore.getState().logout()}>
                  退出登录
                </button>
              </div>
            </div>
          )}

          </div>
        </div>
        {/* 底部保存栏保留在弹窗整体底部（两栏之下）：切换左侧菜单时按钮位置固定、弹窗尺寸稳定；
            记忆/高级/MCP/外部服务等 tab 的独立保存按钮仍位于右侧内容区内，原样保留 */}
        {tab !== 'user' && tab !== 'memory' && tab !== 'advanced' && tab !== 'mcp' && tab !== 'extensions' && tab !== 'external' && (
          <div className="settings-bottom-bar">
            <button
              className="btn btn-primary"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        )}
        {browsing && (
          <DirBrowser
            currentPath={form.work_dir}
            onSelect={(path) => handleChange('work_dir', path)}
            onClose={() => setBrowsing(false)}
          />
        )}
      </div>
    </div>
  );
}
