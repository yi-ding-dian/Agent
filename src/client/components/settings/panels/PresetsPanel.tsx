/**
 * 模型设置域（设置 → 模型设置）
 *
 * 模型预设列表（localStorage）+ 选中（同步为服务端全局默认）+ 新增/编辑/删除 + 连通性测试。
 * 无保存栏 —— 选中即时同步服务端，预设编辑即时写 localStorage。
 *
 * 「当前选中 / 预设列表 / 服务端全局默认」三个 state 已上提至 shared/model-selection.tsx，
 * 因为常规域的「当前模型」展示需要读它们（原两域同处一个组件故可直接读）。
 */
import { useState } from 'react';
import * as api from '../../../services/api';
import { confirmDialog } from '../../../store/confirm-dialog';
import { toast } from '../../../store/toast-store';
import { ResizableModal } from '../../common/ResizableModal';
import { useModelSelection } from '../shared/model-selection';

export function PresetsPanel() {
  const { presets, commitPresets, activePreset, applyActivePreset, selectPreset } = useModelSelection();
  const [editingPreset, setEditingPreset] = useState<{ index: number | 'new'; name: string; baseUrl: string; model: string; apiKey: string; maxTokens: number } | null>(null);
  const [presetTesting, setPresetTesting] = useState(false);

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
    commitPresets(next);
    // 编辑的是当前选中项且名称被修改 → 同步选中名称
    if (editingPreset.index !== 'new' && activePreset === presets[editingPreset.index].name && activePreset !== name) {
      applyActivePreset(name);
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
    commitPresets(next);
    if (activePreset === target.name) {
      applyActivePreset(null);
    }
    if (editingPreset && editingPreset.index === index) setEditingPreset(null);
  };

  return (
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
                  onChange={() => selectPreset(p.name)}
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
    </>
  );
}
