import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./sessions.css";
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<App />);
