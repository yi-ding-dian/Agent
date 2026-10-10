/**
 * 常规设置域（设置 → 常规）
 *
 * System Prompt / 工作目录 / Temperature / LLM 超时 / 思考模式（当前模型 + 开启开关 + 按能力动态级别）。
 * 保存走设置表单的全量 POST /api/config（与 Agent 限流、工具权限共用 shared/SaveFooter）。
 *
 * 两处跨域只读依赖：
 *  - 「当前模型」文案来自 shared/model-selection（presets 域写、本域读）
 *  - 工作目录浏览用 common/DirBrowser —— 原先挂在壳的 modal 末尾（切 tab 不关），
 *    随本域迁入后改为跟随本域卸载
 */
import { useState } from 'react';
import { isElectron } from '../../../services/api-config';
import { DirBrowser } from '../../common/DirBrowser';
import { SaveFooter } from '../shared/SaveFooter';
import { useSettingsForm, useSettingsFooter } from '../shared/settings-form';
import { useModelSelection } from '../shared/model-selection';

export function CommonPanel() {
  const { form, setForm, setField } = useSettingsForm();
  const { currentModelLabel } = useModelSelection();
  const [browsing, setBrowsing] = useState(false);

  /** 「浏览」工作目录：Electron 桌面端走系统目录选择对话框；Web 模式走定制目录浏览器 */
  const handleBrowse = async () => {
    if (isElectron() && window.myagent?.selectDirectory) {
      const dir = await window.myagent.selectDirectory();
      if (dir) setForm((prev) => ({ ...prev, work_dir: dir }));
      return;
    }
    setBrowsing(true);
  };

  // ─── 思考模式：当前模型 + 开启开关 + 按模型能力动态级别 ───

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

  // 本域保存走设置表单的全量保存（与 Agent 限流、工具权限共用同一个 POST /api/config）
  useSettingsFooter(<SaveFooter />, []);

  return (
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
      {browsing && (
        <DirBrowser
          currentPath={form.work_dir}
          onSelect={(path) => setField('work_dir', path)}
          onClose={() => setBrowsing(false)}
        />
      )}
    </>
  );
}
