interface LoadingSpinnerProps {
  size?: number;
  text?: string;
}

export function LoadingSpinner({ size = 16, text }: LoadingSpinnerProps) {
  return (
    <div className="loading-spinner">
      <div className="loading-spinner-dot" style={{ width: size, height: size }} />
      <div className="loading-spinner-dot" style={{ width: size, height: size }} />
      <div className="loading-spinner-dot" style={{ width: size, height: size }} />
      {text && <span style={{ marginLeft: 8, color: 'var(--text-secondary)', fontSize: 13 }}>{text}</span>}
    </div>
  );
}
