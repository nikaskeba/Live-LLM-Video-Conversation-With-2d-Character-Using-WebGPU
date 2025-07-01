// Character.jsx
import { useEffect, useState } from "react";

export default function Character({ currentViseme }) {
  const [isBlinking, setIsBlinking] = useState(false);

  useEffect(() => {
    let blinkTimeout;
    const scheduleBlink = () => {
      const next = Math.random() * 5000 + 3000;
      blinkTimeout = setTimeout(() => {
        setIsBlinking(true);
        setTimeout(() => setIsBlinking(false), 150);
        scheduleBlink();
      }, next);
    };
    scheduleBlink();
    return () => clearTimeout(blinkTimeout);
  }, []); // only once!

  const shape = currentViseme || "rest";

  return (
    <div className="relative w-48 h-48">
      <img src="/assets/face.png" className="absolute inset-0 z-0" />
      <img
        src={isBlinking ? "/assets/eyes_closed.png" : "/assets/eyes_open.png"}
        className="absolute inset-0 z-5 pointer-events-none"
      />
      <img
        src={`/assets/mouth_${shape}.png`}
        className="absolute inset-0 z-10"
        onError={e => (e.currentTarget.src = "/assets/mouth_rest.png")}
      />
    </div>
  );
}