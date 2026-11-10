import { PrivyProvider } from "@privy-io/react-auth";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { logoSrc, ThemeProvider } from "./theme";
import "./index.css";

const appId = import.meta.env.PRIVY_APP_ID as string | undefined;
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    {appId ? (
      <ThemeProvider>
        {(theme) => (
          <PrivyProvider appId={appId} config={{ loginMethods: ["email", "google"], appearance: { theme, accentColor: "#00EB96", logo: <img src={logoSrc(theme)} alt="Inti" width={180} height={69} /> } }}>
            <App />
          </PrivyProvider>
        )}
      </ThemeProvider>
    ) : (
      <p style={{ fontFamily: "system-ui", margin: 48 }}>Inti is not available right now. Please try again later.</p>
    )}
  </StrictMode>,
);
