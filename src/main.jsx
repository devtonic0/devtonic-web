import "./platform/shim.js";
import React from "react";
import { createRoot } from "react-dom/client";

// App is imported dynamically so the shim installs window.require before any
// panel module evaluates its top-level window.require(...) calls.
const { default: App } = await import("./App.jsx");
createRoot(document.getElementById("root")).render(<App />);
