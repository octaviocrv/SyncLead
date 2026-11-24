import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { fetchDashboard } from './api';
import type { Lead } from './data';

const refreshIntervalMs = 10_000;

interface LeadsState {
  leads: Lead[];
  syonetDelivery: 'enabled' | 'disabled' | 'unknown';
  loading: boolean;
  error: string | null;
  updatedAt: Date | null;
  refresh: () => void;
}

const LeadsContext = createContext<LeadsState | null>(null);

export function LeadsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<LeadsState, 'refresh'>>({
    leads: [],
    syonetDelivery: 'unknown',
    loading: true,
    error: null,
    updatedAt: null,
  });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    fetchDashboard(controller.signal)
      .then((data) => setState({ ...data, loading: false, error: null, updatedAt: new Date() }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState((s) => ({ ...s, loading: false, error: error instanceof Error ? error.message : 'Falha ao consultar a API.' }));
      });
    const timer = setTimeout(refresh, refreshIntervalMs);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [tick, refresh]);

  return <LeadsContext.Provider value={{ ...state, refresh }}>{children}</LeadsContext.Provider>;
}

export function useLeads(): LeadsState {
  const context = useContext(LeadsContext);
  if (!context) throw new Error('useLeads must be used inside LeadsProvider.');
  return context;
}

export const isPending = (lead: Lead) => lead.status === 'pendente' || lead.status === 'erro';
