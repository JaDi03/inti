import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { defaultNetwork, type NetworkId } from "./limits/config";

/** The picked network is remembered in this browser. One project serves both networks. */
const STORAGE_KEY = "inti-network";

function savedNetwork(): NetworkId | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "testnet" || value === "mainnet" ? value : null;
  } catch {
    return null;
  }
}

interface NetworkContextValue {
  network: NetworkId;
  setNetwork: (network: NetworkId) => void;
}

const NetworkContext = createContext<NetworkContextValue | null>(null);

export function NetworkProvider({ children }: { children: ReactNode }) {
  const [network, setState] = useState<NetworkId>(() => savedNetwork() ?? defaultNetwork());
  const setNetwork = useCallback((next: NetworkId) => {
    setState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage can be blocked; the choice still applies for this visit.
    }
  }, []);
  return <NetworkContext.Provider value={{ network, setNetwork }}>{children}</NetworkContext.Provider>;
}

export function useNetwork(): NetworkContextValue {
  const value = useContext(NetworkContext);
  if (!value) throw new Error("useNetwork must be used inside NetworkProvider");
  return value;
}

const OPTIONS: { id: NetworkId; label: string }[] = [
  { id: "testnet", label: "Testnet" },
  { id: "mainnet", label: "Mainnet" },
];

/** Segmented control: Testnet (free test money) / Mainnet (real money). */
export function NetworkSwitch({ className }: { className?: string }) {
  const { network, setNetwork } = useNetwork();
  return (
    <div role="radiogroup" aria-label="Network" className={cn("flex rounded-full border border-border bg-muted p-0.5 text-xs", className)}>
      {OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={network === option.id}
          onClick={() => setNetwork(option.id)}
          className={cn(
            "rounded-full px-2.5 py-1 font-medium transition-colors",
            network === option.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
