/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        board: {
          bg: "var(--board-bg)",
          surface: "var(--board-surface)",
          border: "var(--board-border)",
          text: "var(--board-text)",
          muted: "var(--board-text-muted)",
          primary: "var(--board-primary)",
          success: "var(--board-success)",
          danger: "var(--board-danger)",
          warning: "var(--board-warning)",
        },
      },
    },
  },
  plugins: [],
};
