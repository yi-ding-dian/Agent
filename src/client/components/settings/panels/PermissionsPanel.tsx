/**
 * 工具权限域（设置 → 工具权限）
 *
 * 控制每个工具的执行权限：允许 / 询问 / 禁止。
 * 保存走设置壳的底部保存栏（全量 POST /api/config），本组件只负责渲染与改值。
 */
import type { ToolPermissionValue } from '../../../types/api';
import { TOOL_LABELS } from '../shared/defaults';
import { SaveFooter } from '../shared/SaveFooter';
import { useSettingsForm, useSettingsFooter } from '../shared/settings-form';

export function PermissionsPanel() {
  const { form, permissionTools, setToolPermission } = useSettingsForm();
  // 本域保存走设置表单的全量保存（与常规/Agent限流同一个 POST /api/config）
  useSettingsFooter(<SaveFooter />, []);

  return (
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
            onChange={(e) => setToolPermission(name, e.target.value as ToolPermissionValue)}
          >
            <option value="allow">允许</option>
            <option value="ask">询问</option>
            <option value="deny">禁止</option>
          </select>
        </div>
      ))}
    </>
  );
}
