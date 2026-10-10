/**
 * 通用保存按钮（设置弹窗底部栏用）
 *
 * 常规 / Agent 限流 / 工具权限 三个域共用同一份 ConfigData 表单与同一个 POST /api/config
 * 保存动作，故共用本组件。memory / advanced / external 各自有独立的保存端点，用各自的按钮。
 */
import { useSettingsForm } from './settings-form';

export function SaveFooter() {
  const { save, saving } = useSettingsForm();
  return (
    <button className="btn btn-primary" onClick={() => void save()} disabled={saving}>
      {saving ? '保存中...' : '保存'}
    </button>
  );
}
