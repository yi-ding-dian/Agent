/**
 * 通用确认弹窗：标题 + 信息 + 取消/主确认（可选危险/方案 B 副按钮）
 *
 * 覆盖场景：删除确认（取消+删除[危险]）、二次确认（取消+确认）、
 * 二选一操作（取消 + 主操作 + 副操作[如"仅还原选中/全部还原"，副按钮可标红]）。
 * 三个按钮以上的场景请自行组合：外层 .modal-overlay + ResizableModal 自定义底部区。
 *
 * 用法：
 *   <ConfirmModal
 *     title="确定删除？"
 *     message="删除后不可恢复。"
 *     danger
 *     confirmLabel="删除"
 *     onConfirm={...}
 *     onCancel={...}
 *   />
 */
import type { ReactNode } from 'react';
import { ResizableModal } from './ResizableModal';

export function ConfirmModal(props: {
  title: ReactNode;
  message: ReactNode;
  /** 主按钮是否红色（危险操作） */
  danger?: boolean;
  confirmLabel?: string;
  secondaryLabel?: string;
  /** 副按钮是否红色（危险选项，如「磁盘文件也删除」） */
  secondaryDanger?: boolean;
  /** 隐藏「取消」按钮：仅"知道了"一种回应（信息型通知） */
  hideCancel?: boolean;
  /** 命令预览：鼠标悬浮按钮时显示将执行的命令 */
  confirmCmd?: string;
  secondaryCmd?: string;
  /** 弹窗宽度（默认 440） */
  width?: number;
  /** 弹窗出现的屏幕坐标（默认居中）；提供时在鼠标位置附近弹出（视口内自动收边） */
  pos?: { x: number; y: number };
  onConfirm: () => void;
  onCancel: () => void;
  onSecondary?: () => void;
}) {
  const pos = props.pos;
  // 宽度自适应：未显式指定 width 时按内容估算（11px/字密集口径 + 边距，短消息是紧凑窄框；上限 400）
  const textLen =
    (typeof props.title === 'string' ? props.title.length : 0) +
    (typeof props.message === 'string' ? props.message.length : 0);
  const width = props.width ?? Math.round(Math.max(280, Math.min(textLen * 11 + 60, 400)));
  const minWidth = Math.min(420, width);
  // 视口内收边（弹窗宽约 width、高约 180 的保守估算）
  const fixedStyle = pos
    ? {
        position: 'fixed' as const,
        left: Math.max(8, Math.min(pos.x + 16, window.innerWidth - width - 16)),
        top: Math.max(8, Math.min(pos.y + 12, window.innerHeight - 200)),
        width: Math.min(width, window.innerWidth - 16),
      }
    : undefined;

  return (
    <div className="modal-overlay" onClick={props.onCancel}>
      <div style={{ ...fixedStyle, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <ResizableModal width={width} minWidth={minWidth} onEsc={props.onCancel}>
          <h3 style={{ padding: '18px 24px 0', fontSize: 16 }}>{props.title}</h3>
          <div className="body" style={{ whiteSpace: 'pre-wrap', paddingTop: 10 }}>{props.message}</div>
          <div className="foot">
            {!props.hideCancel && <button onClick={props.onCancel}>取消</button>}
            {props.secondaryLabel && props.onSecondary && (
              <button
                className={props.secondaryDanger ? 'btn-danger' : 'btn-primary'}
                onClick={props.onSecondary}
                title={props.secondaryCmd ? `${props.secondaryCmd}` : undefined}
              >
                {props.secondaryLabel}
              </button>
            )}
            <button
              className={props.danger ? 'btn-danger' : 'btn-primary'}
              onClick={props.onConfirm}
              title={props.confirmCmd ? `${props.confirmCmd}` : undefined}
            >
              {props.confirmLabel ?? '确认'}
            </button>
          </div>
        </ResizableModal>
      </div>
    </div>
  );
}
