import { PrivyProvider } from "@privy-io/react-auth";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ThemeProvider } from "./theme";
import "./index.css";

const appId = import.meta.env.PRIVY_APP_ID as string | undefined;
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    {appId ? (
      <ThemeProvider>
        {(theme) => (
          <PrivyProvider appId={appId} config={{ loginMethods: ["email", "google"], appearance: { theme, accentColor: "#00EB96" } }}>
            <App />
          </PrivyProvider>
        )}
      </ThemeProvider>
    ) : (
      <p style={{ fontFamily: "system-ui", margin: 48 }}>PRIVY_APP_ID is missing from the root .env file.</p>
    )}
  </StrictMode>,
);
