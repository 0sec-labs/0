/** Small, soft silhouettes keep agent identity visible without adding chrome. */
export function AgentAvatar({ index = 0, className = "" }: { index?: number; className?: string }) {
  const colors = ["#e991bc", "#e5c263", "#a394ed", "#7fc5df", "#87c5ac"];
  return <svg viewBox="0 0 20 20" aria-hidden="true" className={`size-4 shrink-0 ${className}`}>
    <path fill={colors[index % colors.length]} d="M3 12C3 6.8 5.6 3 10 3s7 3.8 7 9v2.2c0 1.7-1.2 2.8-2.6 2.8-1.2 0-1.6-.7-2.4-.7s-1.1.7-2 .7-1.3-.7-2.1-.7-1.1.7-2.3.7C4.1 17 3 15.9 3 14.2Z" />
    <ellipse cx="7.5" cy="10" rx=".85" ry="1.5" fill="#242329"/><ellipse cx="12.5" cy="10" rx=".85" ry="1.5" fill="#242329"/>
  </svg>;
}
