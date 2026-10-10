/**
 * Agent 限流域（设置 → Agent 限流）
 *
 * 四个数值限流参数，blur 时越界回落到默认值。
 * 保存走设置壳的底部保存栏（全量 POST /api/config，服务端实时生效）。
 */
import { SaveFooter } from '../shared/SaveFooter';
import { useSettingsForm, useSettingsFooter } from '../shared/settings-form';

export function AgentLimitPanel() {
  const { form, setField, handleRateLimitBlur } = useSettingsForm();
  // 本域保存走设置表单的全量保存（与常规/工具权限同一个 POST /api/config）
  useSettingsFooter(<SaveFooter />, []);

  return (
    <>
      <div className="settings-section-title">Agent 限流（超过限制时 Agent 会自动阻断工具调用）</div>
      <div className="settings-section-desc">
        说明：限流由服务端实时执行（data/rate-limit-config.json），超过上限时 Agent 会自动阻断工具调用并提示（rate_limit_abort）。保存后立即生效。
      </div>

      <div className="form-row">
        <div className="form-group">
          <label>每分钟最多工具调用（10-50）</label>
          <input
            type="number"
            value={form.tool_rate_limit_per_minute}
            onChange={(e) => setField('tool_rate_limit_per_minute', parseInt(e.target.value) || 0)}
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
            onChange={(e) => setField('agent_max_tool_calls_per_turn', parseInt(e.target.value) || 0)}
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
            onChange={(e) => setField('agent_max_consecutive_errors', parseInt(e.target.value) || 0)}
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
            onChange={(e) => setField('agent_max_turns', parseInt(e.target.value) || 0)}
            onBlur={() => handleRateLimitBlur('agent_max_turns')}
            min={10}
            max={100}
          />
        </div>
      </div>
    </>
  );
}
