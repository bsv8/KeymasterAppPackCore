import { useState } from "react";
import { createRoot } from "react-dom/client";
import logo from "./logo.svg";
import "./style.css";

function App() {
  const [status, setStatus] = useState("Ready");

  async function loadModule() {
    const module = await import("./lazy.js");
    setStatus(module.message);
  }

  return (
    <section className="panel">
      <img src={logo} alt="Keymaster" width="64" height="64" />
      <h1>Content-addressed Vite App</h1>
      <p>{status}</p>
      <button type="button" onClick={loadModule}>
        Load dynamic module
      </button>
    </section>
  );
}

createRoot(document.querySelector("#app")).render(<App />);
