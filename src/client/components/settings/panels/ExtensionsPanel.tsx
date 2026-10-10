/**
 * 扩展管理域（设置 → 扩展）
 *
 * Pi 扩展的启停管理。启停切换对新会话/命令列表即时生效，运行中的会话不热更新 ——
 * 因此本域**没有保存栏**（操作即时落盘，无需批量提交）。
 */
import { useEffect, useState } from 'react';
import type { ExtensionInfo } from '../../../types/api';
import * as api from '../../../services/api';
import { toast } from '../../../store/toast-store';

export function ExtensionsPanel() {
  const [extensions, setExtensions] = useState<ExtensionInfo[]>([]);
  const [extensionsLoading, setExtensionsLoading] = useState(false);

  const handleExtensionToggle = async (ext: ExtensionInfo) => {
    try {
      const r = await api.toggleExtension(ext.name);
      // 后端落盘后对新会话即时生效（运行中会话不热更新），本地刷新列表展示新状态
      setExtensions((prev) => prev.map((e) => (e.name === ext.name ? { ...e, enabled: r.enabled } : e)));
      toast.success(`已${r.enabled ? '启用' : '停用'}「${ext.name}」，新会话生效`);
    } catch (e: any) {
      toast.error(e.message || '切换失败');
    }
  };

  // 挂载即加载扩展列表（本组件只在「扩展」tab 激活时渲染）
  useEffect(() => {
    setExtensionsLoading(true);
    api.listExtensions()
      .then((list) => setExtensions(list))
      .catch((e: any) => toast.error(e.message || '加载扩展列表失败'))
      .finally(() => setExtensionsLoading(false));
  }, []);

  return (
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
    </>
  );
}
