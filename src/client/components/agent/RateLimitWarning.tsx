import { useState, useEffect } from 'react';

interface Props {
  message: string;
  remaining: number;
  resetIn: number;
  onDismiss: () => void;
}

/**
 * 速率限制警告条
 */
export function RateLimitWarning({ message, remaining, resetIn, onDismiss }: Props) {
  const [countdown, setCountdown] = useState(resetIn);

  useEffect(() => {
    if (countdown <= 0) {
      onDismiss();
      return;
    }
    const timer = setInterval(() => setCountdown((c) => c - 1), 1000);
    return () => clearInterval(timer);
  }, [countdown, onDismiss]);

  return (
    <div className="rate-limit-warning">
      <span>{message}</span>
      <span className="rate-limit-countdown">({countdown}s)</span>
      <button onClick={onDismiss}>&#10005;</button>
    </div>
  );
}
