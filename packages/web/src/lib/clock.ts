import { useEffect, useState } from 'react';

/** Draw again every second while `active`: the clocks of a step, a sub-agent or a turn at work. */
export function useEverySecond(active: boolean): void {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const i = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, [active]);
}
