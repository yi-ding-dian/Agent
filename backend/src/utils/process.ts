import type { ChildProcess } from 'node:child_process';

/**
 * 终止子进程及其**整个进程组**。
 *
 * 直接 `proc.kill()` 只作用于直接子进程 —— 若它是 shell（`sh -c ...`），真正的命令是
 * 它的子进程，shell 一死就沦为孤儿继续跑：实测 `sh -c "sleep 120"` 被 SIGTERM 后
 * sh 已退出，而 `sleep 120` 的 PPID 变成 1 仍存活。
 *
 * 所以 spawn 时须配 `detached: true` 让它自成进程组组长，这里以**负 PID** 杀整组。
 * 进程组已回收时 process.kill 抛 ESRCH，退回单进程再试一次。
 */
export function killProcessGroup(proc: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (proc.pid) process.kill(-proc.pid, sig);
  } catch {
    try { proc.kill(sig); } catch { /* 进程已结束，忽略 */ }
  }
}

/**
 * 把 AbortSignal 接到子进程上：中止时先 SIGTERM，宽限期内未退则 SIGKILL 整组。
 *
 * `onSettled` 用于判断该次执行是否已有结果 —— 已有结果时不再补刀，
 * 避免误伤 PID 被复用后新建的无关进程组。
 */
export function bindAbortToProcess(
  proc: ChildProcess,
  signal: AbortSignal | undefined,
  isSettled: () => boolean,
): void {
  if (!signal) return;
  signal.addEventListener(
    'abort',
    () => {
      if (isSettled()) return;
      killProcessGroup(proc, 'SIGTERM');
      // 宽限期后仍未退出则强杀整组
      setTimeout(() => {
        if (isSettled()) return;
        killProcessGroup(proc, 'SIGKILL');
      }, 2000).unref();
    },
    { once: true },
  );
}
