import { useCallback, useState } from 'react';

const STORAGE_KEY = 'conflict-engine-api-key';

export function useApiKey(): [string, (key: string) => void] {
  const [apiKey, setApiKeyState] = useState(() => localStorage.getItem(STORAGE_KEY) ?? '');

  const setApiKey = useCallback((key: string) => {
    setApiKeyState(key);
    localStorage.setItem(STORAGE_KEY, key);
  }, []);

  return [apiKey, setApiKey];
}
