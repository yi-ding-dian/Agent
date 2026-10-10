import { useChatStore } from '../../store/chat-store';

/**
 * 规划完成卡片：plan 轮结束后展示（趋势化放置于输入区上方），
 * 提供「按此计划执行」（关闭规划并发执行指令）与「关闭」。
 */
export function PlanCard() {
  const planReady = useChatStore((s) => s.planReady);
  const planMode = useChatStore((s) => s.planMode);
  const executePlan = useChatStore((s) => s.executePlan);
  const setPlanMode = useChatStore((s) => s.setPlanMode);

  if (!planReady && !planMode) return null;

  return (
    <div className="plan-card">
      {planReady ? (
        <>
          <div className="plan-card-header">
            📋 规划完成：上面是只读调研方案，确认后开始实施
          </div>
          <div className="plan-card-actions">
            <button className="btn btn-primary btn-sm" onClick={() => void executePlan()}>
              ▶ 按此计划执行
            </button>
            <button className="btn btn-secondary btn-sm" onClick={() => setPlanMode(false)}>
              关闭
            </button>
          </div>
        </>
      ) : (
        <div className="plan-card-header">📋 规划模式：Agent 将只读调研并给出计划，不执行任何修改</div>
      )}
    </div>
  );
}
