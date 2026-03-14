// hooks/usePoll.js — generic polling hook
import { useEffect, useRef } from "react";

export function usePoll(fn, interval, enabled = true) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; }, [fn]);

  useEffect(() => {
    if (!enabled) return;
    fnRef.current(); // immediate call
    const id = setInterval(() => fnRef.current(), interval);
    return () => clearInterval(id);
  }, [interval, enabled]);
}
