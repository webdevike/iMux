import "@mantine/core/styles.css";
import "./styles.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { PanelApp } from "./App";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<PanelApp />);
}
