/**
 * MCP 服务域（设置 → MCP 服务）
 *
 * 管理 MCP（Model Context Protocol）外部服务：列表 / 启停 / 删除 / 新增。
 * 配置持久化在服务端 data/mcp-servers.json，改动后**新建会话生效**（运行中会话不热更新），
 * 故本域没有保存栏（操作即时落盘）。
 *
 * 注：新增弹窗此前渲染条件不含 tab 判断（切 tab 仍浮着），随本域迁出后自然跟随卸载。
 */
import { useEffect, useState } from 'react';
import type { McpServerConfig } from '../../../types/api';
import * as api from '../../../services/api';
import { confirmDialog } from '../../../store/confirm-dialog';
import { toast } from '../../../store/toast-store';
import { ResizableModal } from '../../common/ResizableModal';

export function McpPanel() {
  const [mcpServers, setMcpServers] = useState<McpServerConfig[]>([]);
  const [mcpForm, setMcpForm] = useState({ name: '', command: '', args: '', description: '' });
  const [mcpSaving, setMcpSaving] = useState(false);
  const [showMcpModal, setShowMcpModal] = useState(false);

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

  // 挂载即加载 server 列表（本组件只在「MCP 服务」tab 激活时渲染）
  useEffect(() => {
    api.listMcpServers()
      .then((d) => setMcpServers(d.servers || []))
      .catch((e: any) => toast.error(e.message));
  }, []);

  return (
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
          {/* 新增入口（弹窗）—— 弹出条件 + 遮罩层缺一不可：
              条件丢失会变成无条件渲染（弹窗常驻且关不掉，setShowMcpModal(null) 无对应判断） */}
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
    </>
  );
}
