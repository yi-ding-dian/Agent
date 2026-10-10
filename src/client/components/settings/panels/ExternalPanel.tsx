/**
 * 外部服务域（设置 → 外部服务）
 *
 * 可自定义的查询链接列表（知识库 / 文件管理系统为内置项），持久化在服务端
 * data/external-service-config.json。保存走独立端点 api.saveExternalService，立即生效。
 * 新增/编辑走弹窗（原为壳内联，随本域一并搬出 —— 顺带修正了"切到别的 tab 弹窗仍浮着"）。
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import type { ExternalServiceEntry } from '../../../types/api';
import * as api from '../../../services/api';
import { confirmDialog } from '../../../store/confirm-dialog';
import { toast } from '../../../store/toast-store';
import { ResizableModal } from '../../common/ResizableModal';
import { useSettingsForm } from '../shared/settings-form';

export function ExternalPanel() {
  const { setFooter } = useSettingsForm();
  const [extServices, setExtServices] = useState<ExternalServiceEntry[]>([]);
  // null = 空闲；'kb' / 'filesys' / 自定义条目 id = 对应链接正在测试
  const [extTesting, setExtTesting] = useState<string | null>(null);
  const [extSaving, setExtSaving] = useState(false);
  // 外部服务新增/编辑弹窗
  const [showServiceModal, setShowServiceModal] = useState(false);
  const [newService, setNewService] = useState({ title: '', url: '', description: '' });
  /** null = 新增模式；否则为编辑的外部队列索引 */
  const [editingServiceIndex, setEditingServiceIndex] = useState<number | null>(null);

  const handleExtTest = async (s: ExternalServiceEntry) => {
    if (!s.url.trim()) {
      toast.error(`请先填写「${s.title}」的链接`);
      return;
    }
    setExtTesting(s.id);
    try {
      const r = await api.testExternalService({ id: s.id, url: s.url.trim() });
      if (r.ok) {
        toast.success(`${s.title} 连接成功（${r.latencyMs}ms）`);
      } else {
        toast.error(`${s.title}：${r.error || '连接失败'}`);
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setExtTesting(null);
    }
  };

  /** 删除外部服务（二次确认；返回是否真的删除）；供行内与编辑弹窗共用 */
  const handleExtDelete = async (index: number): Promise<boolean> => {
    const s = extServices[index];
    if (!s) return false;
    const r = await confirmDialog.confirm({
      title: '删除外部服务',
      message: `删除外部服务「${s.title}」？${s.id === 'kb' ? '（知识库查询将变为未配置）' : s.id === 'filesys' ? '（文件系统查询将变为未配置）' : ''}`,
      danger: true,
      confirmLabel: '删除',
    });
    if (r !== 'confirm') return false;
    setExtServices((prev) => prev.filter((_, i) => i !== index));
    toast.info(`已删除「${s.title}」`);
    return true;
  };

  /** 关闭弹窗并重置编辑态 */
  const handleCloseServiceModal = () => {
    setShowServiceModal(false);
    setEditingServiceIndex(null);
    setNewService({ title: '', url: '', description: '' });
  };

  const handleOpenAddService = () => {
    setEditingServiceIndex(null);
    setNewService({ title: '', url: '', description: '' });
    setShowServiceModal(true);
  };

  const handleOpenEditService = (index: number) => {
    const s = extServices[index];
    if (!s) return;
    setEditingServiceIndex(index);
    setNewService({ title: s.title, url: s.url, description: s.description });
    setShowServiceModal(true);
  };

  /** 弹窗保存：编辑模式更新对应条目，新增模式追加（无 id 由后端分配） */
  const handleSaveServiceModal = () => {
    const title = newService.title.trim();
    const url = newService.url.trim();
    if (!title) {
      toast.error('请填写服务标题');
      return;
    }
    if (!url) {
      toast.error('请填写服务链接');
      return;
    }
    const description = newService.description.trim();
    if (editingServiceIndex !== null) {
      setExtServices((prev) => prev.map((s, i) => (i === editingServiceIndex ? { ...s, title, url, description } : s)));
    } else {
      // 新条目不带 id（后端保存时按标题匹配置内置 id 或分配 uuid）；临时 key 用时间戳前缀
      setExtServices((prev) => [...prev, { id: `tmp-${Date.now()}`, title, url, description }]);
    }
    handleCloseServiceModal();
  };

  /** 编辑弹窗内删除：二次确认成功后关闭弹窗 */
  const handleDeleteFromServiceModal = async () => {
    if (editingServiceIndex === null) return;
    const deleted = await handleExtDelete(editingServiceIndex);
    if (deleted) handleCloseServiceModal();
  };

  const handleExtSave = async () => {
    setExtSaving(true);
    try {
      // 临时 id（tmp-*）的新条目不发 id，由后端分配；保留后端返回的正式列表
      const payload = { services: extServices.map((s) => ({ ...s, id: s.id.startsWith('tmp-') ? '' : s.id })) };
      const saved = await api.saveExternalService(payload);
      setExtServices(saved.services);
      toast.success('外部服务配置已保存，立即生效');
    } catch (e: any) {
      toast.error(e.message || '保存失败');
    } finally {
      setExtSaving(false);
    }
  };

  // 挂载即加载当前配置（本组件只在「外部服务」tab 激活时渲染）
  useEffect(() => {
    api.getExternalService()
      .then((d) => setExtServices(d.services || []))
      .catch((e: any) => toast.error(e.message));
  }, []);

  // 底部保存栏：本域用独立端点保存
  useLayoutEffect(() => {
    setFooter(
      <button
        className="btn btn-primary"
        onClick={() => void handleExtSave()}
        disabled={extSaving}
      >
        {extSaving ? '保存中...' : '保存'}
      </button>,
    );
    return () => setFooter(null);
    // extServices 进 deps：保存需提交最新的列表内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extSaving, extServices]);

  return (
    <>
      <div className="settings-section-desc">
        外部服务的查询链接（知识库 / 文件管理系统为内置项；支持自定义新增）。保存后即时生效（无需重启）。
      </div>
      {extServices.map((s, i) => (
        <div key={s.id} className="preset-item" style={{ marginBottom: 8 }}>
          <div className="preset-info" style={{ flex: 1, minWidth: 0 }}>
            <div className="preset-name">
              {s.title}
              {(s.id === 'kb' || s.id === 'filesys') && <span className="model-default-badge">内置</span>}
            </div>
            <div className="preset-meta" style={{ wordBreak: 'break-all' }}>{s.url || '未配置链接'}</div>
            {s.description && (
              <div className="settings-field-hint" style={{ marginTop: 2 }}>{s.description}</div>
            )}
          </div>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => handleExtTest(s)}
            disabled={extTesting !== null}
            style={{ marginLeft: 8 }}
          >
            {extTesting === s.id ? '测试中...' : '测试连接'}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => handleOpenEditService(i)}
            style={{ marginLeft: 8 }}
          >
            编辑
          </button>
        </div>
      ))}
      <button className="btn btn-secondary" onClick={handleOpenAddService} style={{ marginBottom: 12 }}>
        + 新增服务
      </button>
      {showServiceModal && (
        <div className="modal-overlay">
          <ResizableModal width={480} onEsc={handleCloseServiceModal}>
            <div className="modal-header">
              <h2>{editingServiceIndex !== null ? '编辑外部服务' : '新增外部服务'}</h2>
              <button className="modal-close-btn" onClick={handleCloseServiceModal}>&#10005;</button>
            </div>
            <div className="body" style={{ paddingTop: 12 }}>
              <div className="form-group">
                <label>标题</label>
                <input
                  type="text"
                  value={newService.title}
                  onChange={(e) => setNewService({ ...newService, title: e.target.value })}
                  placeholder="如：企业知识库 / 内网文档"
                />
              </div>
              <div className="form-group">
                <label>链接</label>
                <input
                  type="text"
                  value={newService.url}
                  onChange={(e) => setNewService({ ...newService, url: e.target.value })}
                  placeholder="http://host:port?token=xxx"
                />
              </div>
              <div className="form-group">
                <label>描述（可选）</label>
                <textarea
                  rows={2}
                  value={newService.description}
                  onChange={(e) => setNewService({ ...newService, description: e.target.value })}
                  placeholder="这个服务是做什么的，怎么使用"
                />
              </div>
            </div>
            <div className="foot">
              {editingServiceIndex !== null && (
                <button className="btn btn-danger" onClick={() => void handleDeleteFromServiceModal()} style={{ marginRight: 'auto' }}>
                  删除
                </button>
              )}
              <button className="btn btn-secondary" onClick={handleCloseServiceModal}>取消</button>
              <button className="btn btn-primary" onClick={handleSaveServiceModal}>
                {editingServiceIndex !== null ? '保存修改' : '添加'}
              </button>
            </div>
          </ResizableModal>
        </div>
      )}
    </>
  );
}
