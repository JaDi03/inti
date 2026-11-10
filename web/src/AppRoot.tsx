import { PrivyProvider } from "@privy-io/react-auth";
import { App } from "./App";
import { logoSrc, ThemeProvider } from "./theme";

const appId = import.meta.env.PRIVY_APP_ID as string | undefined;

/** The app with its sign-in (Privy) and theme. Only the /app page loads it. */
export function AppRoot() {
  if (!appId) return <p style={{ fontFamily: "system-ui", margin: 48 }}>Inti is not available right now. Please try again later.</p>;
  return (
    <ThemeProvider>
      {(theme) => (
        <PrivyProvider
          appId={appId}
          config={{
            loginMethods: ["email", "google"],
            appearance: { theme, accentColor: "#00EB96", logo: <img src={logoSrc(theme)} alt="Inti" width={180} height={69} /> },
          }}
        >
          <App />
        </PrivyProvider>
      )}
    </ThemeProvider>
  );
}
