import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

/** The app lives under /app; every other path shows the public landing page. */
const onApp = /^\/app(\/|$)/.test(window.location.pathname);

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");
const root = createRoot(container);
const show = (page: ReactNode) => root.render(<StrictMode>{page}</StrictMode>);

/** The dry run lives under /try: no sign-in, no wallet. */
const onTry = /^\/try(\/|$)/.test(window.location.pathname);

// Each page loads only its own code: the landing never loads the wallet or sign-in.
if (onApp) void import("./AppRoot").then(({ AppRoot }) => show(<AppRoot />));
else if (onTry) void import("./dryrun/DryRun").then(({ DryRunRoot }) => show(<DryRunRoot />));
else void import("./landing/Landing").then(({ Landing }) => show(<Landing />));
