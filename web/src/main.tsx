import { PrivyProvider } from "@privy-io/react-auth";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

const appId = import.meta.env.PRIVY_APP_ID as string | undefined;
const root = document.getElementById("root");
if (!root) throw new Error("missing #root");

createRoot(root).render(
  <StrictMode>
    {appId ? (
      <PrivyProvider appId={appId} config={{ loginMethods: ["email", "google"] }}>
        <App />
      </PrivyProvider>
    ) : (
      <p style={{ fontFamily: "system-ui", margin: 48 }}>Falta PRIVY_APP_ID en el archivo .env de la raiz.</p>
    )}
  </StrictMode>,
);
