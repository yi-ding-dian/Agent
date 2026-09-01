import { useConfirmStore } from '../../store/confirm-dialog';
import { ConfirmModal } from './ConfirmModal';

/**
 * 全局确认弹窗宿主（挂载一次于 App 根部）
 *
 * 渲染 confirm-dialog store 中的确认请求；确认/取消/副按钮/Esc/遮罩点击
 * 均经 resolve 回传结果，调用方 await 后继续处理。
 */
export function ConfirmDialogHost() {
  const request = useConfirmStore((s) => s.request);
  const resolve = useConfirmStore((s) => s.resolve);

  if (!request) return null;
  return (
    <ConfirmModal
      title={request.title}
      message={request.message}
      danger={request.danger}
      confirmLabel={request.confirmLabel}
      secondaryLabel={request.secondaryLabel}
      secondaryDanger={request.secondaryDanger}
      hideCancel={request.hideCancel}
      width={request.width}
      pos={request.pos}
      onConfirm={() => resolve(request.id, 'confirm')}
      onCancel={() => resolve(request.id, 'cancel')}
      onSecondary={request.secondaryLabel ? () => resolve(request.id, 'secondary') : undefined}
    />
  );
}
