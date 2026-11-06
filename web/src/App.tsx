import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { useState } from "react";
import { runSelfTest, type CheckResult } from "./selfTest";

/** The user's Privy NEAR wallet address (implicit account id), if any. */
function nearAddress(accounts: readonly unknown[]): string | null {
  for (const account of accounts) {
    const a = account as { type?: string; chainType?: string; address?: string };
    if (a.type === "wallet" && a.chainType === "near" && typeof a.address === "string") return a.address;
  }
  return null;
}

export function App() {
  const { ready, authenticated, user, login, logout } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<CheckResult[] | null>(null);

  if (!ready) return <main style={styles.main}>Cargando...</main>;

  if (!authenticated || !user) {
    return (
      <main style={styles.main}>
        <h1>Inti</h1>
        <p>Prueba de acceso: entra con tu correo o Google. No se mueve dinero.</p>
        <button style={styles.button} onClick={login}>Entrar</button>
      </main>
    );
  }

  const address = nearAddress(user.linkedAccounts);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main style={styles.main}>
      <h1>Inti</h1>
      <p>Sesion: {user.email?.address ?? user.google?.email ?? user.id}</p>

      {address === null ? (
        <button style={styles.button} disabled={busy} onClick={() => run(async () => void (await createWallet({ chainType: "near" })))}>
          Crear mi cuenta NEAR
        </button>
      ) : (
        <>
          <p>
            Cuenta NEAR: <code style={styles.code}>{address}</code>
          </p>
          <button
            style={styles.button}
            disabled={busy}
            onClick={() => run(async () => setResults(await runSelfTest(address, signRawHash)))}
          >
            Probar firmas (sin mover dinero)
          </button>
        </>
      )}

      {results && (
        <ul>
          {results.map((r) => (
            <li key={r.name}>
              {r.ok ? "OK" : "FALLO"} - {r.name}: {r.detail}
            </li>
          ))}
        </ul>
      )}
      {error && <p style={{ color: "#c0392b" }}>{error}</p>}
      <button style={styles.link} onClick={logout}>Salir</button>
    </main>
  );
}

const styles = {
  main: { fontFamily: "system-ui, sans-serif", maxWidth: 560, margin: "48px auto", padding: "0 16px", lineHeight: 1.5 },
  button: { padding: "10px 16px", fontSize: 16, cursor: "pointer" },
  link: { marginTop: 24, background: "none", border: "none", color: "#555", cursor: "pointer", padding: 0 },
  code: { wordBreak: "break-all" as const, fontSize: 13 },
};
