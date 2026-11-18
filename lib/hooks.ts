'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, api } from './api';

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  errorCode: string | null;
  /** True only while there is nothing to show yet (first load). */
  loading: boolean;
  /** True while a background reload runs over already-visible data. */
  refreshing: boolean;
  reload: () => void;
  /** Update the cached value in place (optimistic UI). */
  mutate: (updater: (current: T | null) => T | null) => void;
}

/** Minimal data hook: no external cache library, adequate for a single-user dashboard. */
export function useApi<T>(path: string | null, options: { enabled?: boolean } = {}): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [refreshing, setRefreshing] = useState(false);
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  const hasData = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!path || options.enabled === false) return;
    let cancelled = false;
    if (hasData.current) setRefreshing(true);
    else setLoading(true);

    api
      .get<T>(path)
      .then((result) => {
        if (cancelled || !mounted.current) return;
        hasData.current = true;
        setData(result);
        setError(null);
        setErrorCode(null);
      })
      .catch((caught: unknown) => {
        if (cancelled || !mounted.current) return;
        setError(caught instanceof Error ? caught.message : 'Request failed');
        setErrorCode(caught instanceof ApiRequestError ? caught.code : 'REQUEST_FAILED');
      })
      .finally(() => {
        if (cancelled || !mounted.current) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path, version, options.enabled]);

  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const mutate = useCallback((updater: (current: T | null) => T | null) => {
    setData((current) => updater(current));
  }, []);

  return { data, error, errorCode, loading, refreshing, reload, mutate };
}

export function useAction(): {
  busy: boolean;
  run: <T>(
    fn: () => Promise<T>,
    onSuccess?: (result: T) => void,
    onError?: (message: string) => void,
  ) => Promise<void>;
} {
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T>(
      fn: () => Promise<T>,
      onSuccess?: (result: T) => void,
      onError?: (message: string) => void,
    ) => {
      setBusy(true);
      try {
        const result = await fn();
        onSuccess?.(result);
      } catch (error) {
        const message =
          error instanceof ApiRequestError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Request failed';
        onError?.(message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );
  return { busy, run };
}
