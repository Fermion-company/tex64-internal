"use client";

import { useCallback, useEffect, useRef } from "react";

export function useDebouncedCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result | Promise<Result>,
  delay: number,
) {
  const callbackRef = useRef(callback);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const argsRef = useRef<Args | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  const cancel = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    argsRef.current = null;
  }, []);

  const flush = useCallback(async (): Promise<Result | undefined> => {
    if (!argsRef.current) return undefined;
    if (timerRef.current) clearTimeout(timerRef.current);
    const args = argsRef.current;
    timerRef.current = null;
    argsRef.current = null;
    return callbackRef.current(...args);
  }, []);

  const schedule = useCallback(
    (...args: Args) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      argsRef.current = args;
      timerRef.current = setTimeout(() => void flush(), delay);
    },
    [delay, flush],
  );

  useEffect(() => cancel, [cancel]);

  return { schedule, flush, cancel };
}
