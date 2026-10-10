/**
 * 记忆管理域（设置 → 记忆管理）
 *
 * 跨会话记忆的查看 / 编辑 / 清空 / 蒸馏。数据在服务端（注入下次创建的服务端会话；
 * Electron 客户端会话不注入）。保存走独立端点 api.saveMemory，不经过设置表单的全量保存。
 */
import { useEffect, useLayoutEffect, useState } from 'react';
import * as api from '../../../services/api';
import { confirmDialog } from '../../../store/confirm-dialog';
import { toast } from '../../../store/toast-store';
import { useSettingsForm } from '../shared/settings-form';

export function MemoryPanel() {
  const { setFooter } = useSettingsForm();
  const [memoryText, setMemoryText] = useState('');
  const [memorySaving, setMemorySaving] = useState(false);
  const [memoryDistilling, setMemoryDistilling] = useState(false);

  const handleSaveMemory = async (content?: string) => {
    const target = content !== undefined ? content : memoryText;
    setMemorySaving(true);
    try {
      await api.saveMemory(target);
      toast.success('记忆已保存，将在下次创建会话时注入');
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setMemorySaving(false);
    }
  };

  const handleClearMemory = async () => {
    const r = await confirmDialog.confirm({
      title: '清空全部记忆',
      message: '确定清空全部记忆吗？此操作不可撤销。',
      danger: true,
      confirmLabel: '清空',
    });
    if (r !== 'confirm') return;
    setMemoryText('');
    handleSaveMemory('');
  };

  const handleDistillMemory = async () => {
    setMemoryDistilling(true);
    try {
      const r = await api.distillMemory();
      if (r.success) {
        toast.success(`蒸馏完成：${r.distilled} 条记忆 → ${r.result} 条精炼记忆`);
        // 蒸馏成功后重新拉取全文刷新编辑器
        const d = await api.getMemory();
        setMemoryText(d.content || '');
      } else {
        toast.error(r.error || '记忆蒸馏失败');
      }
    } catch (e: any) {
      toast.error(e.message);
    } finally {
      setMemoryDistilling(false);
    }
  };

  // 挂载即加载当前记忆全文（本组件只在「记忆管理」tab 激活时渲染）
  useEffect(() => {
    api.getMemory()
      .then((d) => setMemoryText(d.content || ''))
      .catch((e: any) => toast.error(e.message));
  }, []);

  // 底部保存栏：本域用独立端点保存，与全量 /api/config 无关
  useLayoutEffect(() => {
    setFooter(
      <button
        className="btn btn-primary"
        onClick={() => void handleSaveMemory()}
        disabled={memorySaving}
      >
        {memorySaving ? '保存中...' : '保存'}
      </button>,
    );
    return () => setFooter(null);
    // memoryText 进 deps：footer 的点击回调需捕获最新的编辑内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memorySaving, memoryText]);

  return (
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
    </>
  );
}
