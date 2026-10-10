import { useEffect, useRef } from 'react';
import { useChatStore } from '../../store/chat-store';

/**
 * 魔法飞行动画：AI 派子代理（subagent tool_start）时，从消息区的工具卡片
 * 飞出一个金色发光魔法球（光晕 + 粒子拖尾 + 残影），沿抛物线飞到右侧
 * Agent 面板（Agent列表 tab），到达时面板上扩散一圈波纹、列表项金色闪烁。
 *
 * 实现说明：
 * - 监听 store.flyRequest.id 变化触发一次；动画元素全部用 DOM API + Web Animations
 *   API 直接操作（避免 React 高频重渲染），挂在 fixed 容器里，z-index 9999，穿透点击。
 * - 弧线：WAAPI keyframes 中间点（0.5 offset）上抬 arc px 实现抛物线，cubic-bezier 加速飞出。
 * - 起点：优先定位该 subagent 工具卡片（data-tool-call-id，见 ToolCallGroup）；找不到时
 *   fallback 消息区右下角（.message-area-wrapper rect 右下）。
 * - 终点：Agent列表 tab（.side-panel-tab 第 2 个）中心；找不到则取面板中心。
 * - 小屏（≤1100px，question-panel display:none 无终点）：跳过动画直接 clearFly。
 * - 动画期间新 flyRequest：token 代次自增 + 清空旧元素，覆盖重播。
 */
export function MagicFly() {
  const flyRequest = useChatStore((s) => s.flyRequest);
  const clearFly = useChatStore((s) => s.clearFly);
  const containerRef = useRef<HTMLDivElement>(null);
  /** 动画代次：新请求/卸载使旧代次的 setTimeout 回调全部失效 */
  const tokenRef = useRef(0);

  useEffect(() => {
    if (!flyRequest) return;
    const id = flyRequest.id;

    const container = containerRef.current;
    if (!container) {
      clearFly();
      return;
    }

    // 动画代次 +1，使上一轮残留的 setTimeout 回调失效（覆盖重播）
    const token = ++tokenRef.current;

    // 小屏（≤1100px，question-panel display:none）：面板隐藏无终点可飞 → 直接结束
    const panel = document.querySelector('.question-panel') as HTMLElement | null;
    const panelHidden =
      !panel ||
      window.matchMedia('(max-width: 1100px)').matches ||
      getComputedStyle(panel).display === 'none';
    if (panelHidden) {
      clearFly();
      return;
    }

    // ── 起点：最后一条 AI 回复文本（用户要求从回复文本出发）；找不到 → 消息区右下角 ──
    let sx: number;
    let sy: number;
    const lastAssistant = document.querySelector(
      '.message-list .message-row:not(.user) .message-bubble',
    ) as HTMLElement | null;
    if (lastAssistant) {
      const r = lastAssistant.getBoundingClientRect();
      sx = r.left + Math.min(r.width, 120); // 气泡左侧偏内，贴近正在生成的文本
      sy = r.top + r.height / 2;
    } else {
      const area = document.querySelector('.message-area-wrapper') as HTMLElement | null;
      const r = area
        ? area.getBoundingClientRect()
        : { right: window.innerWidth / 2, bottom: window.innerHeight / 2 };
      sx = r.right - 24;
      sy = r.bottom - 24;
    }

    // ── 终点：Agent列表 tab 中心（面板右上角）；找不到 → 面板中心 ──
    let ex: number;
    let ey: number;
    const agentTab = document.querySelectorAll('.side-panel-tab')[1] as HTMLElement | undefined;
    if (agentTab && agentTab.getBoundingClientRect().width > 0) {
      const r = agentTab.getBoundingClientRect();
      ex = r.left + r.width / 2;
      ey = r.top + r.height / 2;
    } else {
      const r = panel!.getBoundingClientRect();
      ex = r.left + r.width / 2;
      ey = r.top + r.height / 2;
    }

    const dx = ex - sx;
    const dy = ey - sy;
    const DURATION = 900;
    // 抛物线拱高：横向距离越大抬得越高（40 ~ 120px）
    const arc = Math.max(40, Math.min(120, Math.abs(dx) * 0.18));
    // 加速飞出（ease-in 风格：先慢后快，冲向面板）
    const easing = 'cubic-bezier(0.55, 0, 0.65, 0.4)';

    // 清空上一轮动画元素（新请求覆盖旧动画）
    container.innerHTML = '';

    /** 在 (left, top) 创建 size×size 的动画元素并挂入容器 */
    const make = (cls: string, size: number, left: number, top: number): HTMLElement => {
      const el = document.createElement('div');
      el.className = cls;
      el.style.left = `${left - size / 2}px`;
      el.style.top = `${top - size / 2}px`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      container.appendChild(el);
      return el;
    };

    // 1) 发光球：白色核心 + 金色光晕渐变（见 index.css .magic-ball）
    const ball = make('magic-ball', 18, sx, sy);

    // 2) 粒子 ×4：沿轨迹散布（横向 ±散布、垂向小上抬），飞远渐隐
    for (let i = 0; i < 4; i++) {
      const p = make(
        'magic-particle',
        5,
        sx + (Math.random() - 0.5) * 18,
        sy + (Math.random() - 0.5) * 18,
      );
      const spreadX = (Math.random() - 0.5) * (26 + i * 16);
      const spreadY = (Math.random() - 0.5) * 18 - 8;
      p.animate(
        [
          { transform: 'translate(0px, 0px)', offset: 0, opacity: 1 },
          {
            transform: `translate(${dx * 0.35 + spreadX}px, ${dy * 0.35 - arc * 0.55 + spreadY}px)`,
            offset: 0.35,
            opacity: 0.85,
          },
          {
            transform: `translate(${dx + spreadX * 1.8}px, ${dy + spreadY * 1.8 - 12}px)`,
            offset: 1,
            opacity: 0,
          },
        ],
        { duration: DURATION + 150, easing: 'cubic-bezier(0.4, 0, 0.7, 0.5)' },
      );
    }

    // 3) 拖尾残影 ×2：同抛物线延迟跟随，opacity 递减
    [0.5, 0.28].forEach((op, i) => {
      const t = make('magic-trail', 9, sx, sy);
      t.style.opacity = String(op);
      t.animate(
        [
          { transform: 'translate(0px, 0px)', offset: 0 },
          { transform: `translate(${dx / 2}px, ${dy / 2 - arc}px)`, offset: 0.5 },
          { transform: `translate(${dx}px, ${dy}px)`, offset: 1 },
        ],
        { duration: DURATION, delay: (i + 1) * 60, easing, fill: 'forwards' },
      );
    });

    // 4) 球本体：抛物线 keyframes（0.5 offset 中点上抬 arc → 弧线感）
    ball.animate(
      [
        { transform: 'translate(0px, 0px)', offset: 0 },
        { transform: `translate(${dx / 2}px, ${dy / 2 - arc}px)`, offset: 0.5 },
        { transform: `translate(${dx}px, ${dy}px)`, offset: 1 },
      ],
      { duration: DURATION, easing, fill: 'forwards' },
    );

    // 5) 到达反馈：球落地后 → 波纹扩散 + 切到 Agent列表 tab + 新项金色闪烁
    setTimeout(() => {
      if (tokenRef.current !== token) return; // 已被新请求覆盖
      make('magic-ripple', 30, ex, ey);
      // 幂等切到「Agent列表」tab（当前即该 tab 时无副作用），让新列表项可见并被高亮
      const agentTabBtn = document.querySelectorAll('.side-panel-tab')[1] as HTMLElement | undefined;
      agentTabBtn?.click();
      // 等待 React flush 渲染出列表项后再加高亮类
      setTimeout(() => {
        if (tokenRef.current !== token) return;
        const item = document.querySelector(
          `[data-agent-id="${CSS.escape(id)}"]`,
        ) as HTMLElement | null;
        if (item) {
          item.classList.remove('just-arrived');
          void item.offsetWidth; // 强制重排，保证动画可重放
          item.classList.add('just-arrived');
          setTimeout(() => item.classList.remove('just-arrived'), 1100);
        }
      }, 80);
    }, DURATION + 50);

    setTimeout(() => {
      if (tokenRef.current !== token) return;
      container.innerHTML = '';
      clearFly();
    }, DURATION + 50 + 600);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyRequest?.id]);

  // 卸载：使未决回调失效（容器 DOM 随 React 一并移除）
  useEffect(() => () => { tokenRef.current++; }, []);

  return <div className="magic-fly-container" ref={containerRef} aria-hidden="true" />;
}
