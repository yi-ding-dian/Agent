export type ConfirmationDecision = 'allow' | 'always_allow' | 'block';

interface PendingEntry {
  resolve: (decision: ConfirmationDecision) => void;
  reject: (reason: string) => void;
  command: string;
  timestamp: number;
}

class PendingConfirmationManager {
  private pending = new Map<string, PendingEntry>();
  private autoApproved = new Set<string>();

  create(sessionId: string, command: string): Promise<ConfirmationDecision> {
    return new Promise((resolve, reject) => {
      this.pending.set(sessionId, { resolve, reject, command, timestamp: Date.now() });
    });
  }

  resolve(sessionId: string, decision: ConfirmationDecision): boolean {
    if (decision === 'always_allow') {
      this.autoApproved.add(sessionId);
    }
    const entry = this.pending.get(sessionId);
    if (!entry) return false;
    entry.resolve(decision);
    this.pending.delete(sessionId);
    return true;
  }

  reject(sessionId: string, reason: string): boolean {
    const entry = this.pending.get(sessionId);
    if (!entry) return false;
    entry.reject(reason);
    this.pending.delete(sessionId);
    return true;
  }

  isAutoApproved(sessionId: string): boolean {
    return this.autoApproved.has(sessionId);
  }

  getPending(sessionId: string): string | null {
    return this.pending.get(sessionId)?.command ?? null;
  }

  cleanupSession(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}

export const pendingConfirmationManager = new PendingConfirmationManager();
