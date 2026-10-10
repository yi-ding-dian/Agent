/**
 * 设置弹窗（2026-10 架构改造后的壳）
 *
 * 本文件只负责三件事：
 *  1. 提供两个 Provider —— SettingsFormProvider（表单大对象，多域共享）与
 *     ModelSelectionProvider（模型选中态，presets 域写 / 常规域读）；
 *  2. 左侧导航 + 右侧内容的两栏布局，按 tab 路由到 settings/panels/ 下的域组件；
 *  3. 渲染底部保存栏的容器（内容由当前激活的域通过 useSettingsForm().setFooter 声明）。
 *
 * 原先 1665 行的十个域实现、四类跨域耦合（共享 form、按 tab 分派保存、common 读 presets 的
 * 模型态、弹窗挂载层级）均已随域拆分消解，见 settings/shared/ 与 settings/panels/。
 */
import { useState, type ComponentType } from 'react';
import { ResizableModal } from '../common/ResizableModal';
import { SettingsFormProvider, useSettingsForm } from '../settings/shared/settings-form';
import { ModelSelectionProvider } from '../settings/shared/model-selection';
import { CommonPanel } from '../settings/panels/CommonPanel';
import { AgentLimitPanel } from '../settings/panels/AgentLimitPanel';
import { PresetsPanel } from '../settings/panels/PresetsPanel';
import { PermissionsPanel } from '../settings/panels/PermissionsPanel';
import { MemoryPanel } from '../settings/panels/MemoryPanel';
import { ExternalPanel } from '../settings/panels/ExternalPanel';
import { UserPanel } from '../settings/panels/UserPanel';
import { AdvancedPanel } from '../settings/panels/AdvancedPanel';
import { McpPanel } from '../settings/panels/McpPanel';
import { ExtensionsPanel } from '../settings/panels/ExtensionsPanel';

interface SettingsModalProps {
  onClose: () => void;
}

type SettingsTab = 'common' | 'agent' | 'presets' | 'permissions' | 'memory' | 'user' | 'advanced' | 'mcp' | 'extensions' | 'external';

/** 导航项：标签 + 对应域组件（导航与内容同源，避免两处各列一遍） */
const SECTIONS: { id: SettingsTab; label: string; Panel: ComponentType }[] = [
  { id: 'common', label: '常规', Panel: CommonPanel },
  { id: 'agent', label: 'Agent 限流', Panel: AgentLimitPanel },
  { id: 'presets', label: '模型设置', Panel: PresetsPanel },
  { id: 'permissions', label: '工具权限', Panel: PermissionsPanel },
  { id: 'memory', label: '记忆管理', Panel: MemoryPanel },
  { id: 'external', label: '外部服务', Panel: ExternalPanel },
  { id: 'user', label: '账户', Panel: UserPanel },
  { id: 'advanced', label: '高级', Panel: AdvancedPanel },
  { id: 'mcp', label: 'MCP 服务', Panel: McpPanel },
  { id: 'extensions', label: '扩展', Panel: ExtensionsPanel },
];

export function SettingsModal({ onClose }: SettingsModalProps) {
  return (
    <SettingsFormProvider onClose={onClose}>
      {/* 模型选中态由 presets 域写、常规域读 —— 解耦点：两域原先共处一个组件 */}
      <ModelSelectionProvider>
        <SettingsShell onClose={onClose} />
      </ModelSelectionProvider>
    </SettingsFormProvider>
  );
}

/** 设置壳：两栏布局 + 导航 + 内容路由 + 底部保存栏容器 */
function SettingsShell({ onClose }: SettingsModalProps) {
  // 壳只从表单 Provider 取 footer —— 其余（form / 各域 setter / 工具清单）都由域自取
  const { footer } = useSettingsForm();
  const [tab, setTab] = useState<SettingsTab>('common');
  const active = SECTIONS.find((s) => s.id === tab) ?? SECTIONS[0];
  const ActivePanel = active.Panel;

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

        {/* 两栏布局：左栏导航 + 右栏内容 */}
        <div className="settings-layout">
          <nav className="settings-nav">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`settings-nav-item${tab === s.id ? ' active' : ''}`}
                onClick={() => setTab(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            <ActivePanel />
          </div>
        </div>
        {/* 底部保存栏：位置固定在弹窗底部（视觉不变），内容由当前激活的域自行提供 ——
            壳不再按 tab 分派保存动作，也不再维护"哪些 tab 无保存语义"的排除清单 */}
        {footer && <div className="settings-bottom-bar">{footer}</div>}
      </ResizableModal>
    </div>
  );
}
