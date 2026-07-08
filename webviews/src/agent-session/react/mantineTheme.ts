import { createTheme, type MantineThemeOverride } from "@mantine/core";

/**
 * Eva's Mantine theme. Colors intentionally stay out of here: every Mantine
 * surface is bridged to the native `--agent-*` palette in styles.css so the
 * chat chrome always matches the host app theme pushed via applyAgentTheme.
 */
export const evaMantineTheme: MantineThemeOverride = createTheme({
  fontFamily: "var(--font-sans)",
  fontFamilyMonospace: "var(--font-mono)",
  defaultRadius: "lg",
  cursorType: "pointer",
  components: {
    Tooltip: {
      defaultProps: { openDelay: 350, withinPortal: false },
    },
    Menu: {
      defaultProps: { withinPortal: false, shadow: "xl" },
    },
  },
});
