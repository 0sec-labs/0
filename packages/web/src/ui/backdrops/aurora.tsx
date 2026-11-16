import * as React from "react"

/** Positions in percent, size in percent of the layer width (the layer is a size container, so tiles and the preview keep the proportions), drift time in seconds and a negative delay that sets the still frame. */
const BLOBS = [
  { x: 8, y: -12, size: 62, time: 46, delay: -9 },
  { x: 52, y: -18, size: 54, time: 58, delay: -23 },
  { x: 74, y: 20, size: 40, time: 52, delay: -31 },
] as const

/** Slow soft gradient blobs, CSS only (the drift keyframes live in styles.css); paused rather than hidden when idle. */
function Aurora({ animate }: { animate: boolean }) {
  return <>
    {BLOBS.map((blob, index) => (
      <span key={index} className="absolute rounded-full bg-[radial-gradient(closest-side,currentColor,transparent)] will-change-transform"
        style={{ left: `${blob.x}%`, top: `${blob.y}%`, width: `${blob.size}cqw`, height: `${blob.size * 0.7}cqw`, animation: `backdrop-drift ${blob.time}s ease-in-out ${blob.delay}s infinite alternate`, animationPlayState: animate ? "running" : "paused" }} />
    ))}
  </>
}

export { Aurora }
