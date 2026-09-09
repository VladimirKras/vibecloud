import "@gravity-ui/uikit/styles/fonts.css";
import "@gravity-ui/uikit/styles/styles.css";
import { ThemeProvider } from "@gravity-ui/uikit";
import { getRootClassName } from "@gravity-ui/uikit/server";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./themes/common.css";
import { applyDocumentTheme, getInitialTheme, useTheme } from "./hooks/useTheme";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("#app was not found");

const initialTheme = getInitialTheme();
const initialRootClasses = getRootClassName({ theme: initialTheme.resolved }).split(" ");

for (const className of document.body.classList) {
  if (className.startsWith("g-root_theme_")) document.body.classList.remove(className);
}
document.body.classList.add(...initialRootClasses);
applyDocumentTheme(initialTheme.resolved);

function Root() {
  const theme = useTheme(initialTheme);
  return (
    <ThemeProvider theme={theme.resolved}>
      <App theme={theme} />
    </ThemeProvider>
  );
}

createRoot(root).render(<StrictMode><Root /></StrictMode>);
