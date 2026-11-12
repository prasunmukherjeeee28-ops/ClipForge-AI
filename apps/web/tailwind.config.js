/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#08080b",
          900: "#0b0b0f",
          850: "#101016",
          800: "#15151d",
          700: "#1c1c26",
        },
        violet: {
          350: "#b7a8ff",
          450: "#9a86f5",
          550: "#7c63ee",
        },
      },
      fontFamily: {
        sans: [
          '"Geist"',
          '"Inter"',
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          '"Segoe UI"',
          "sans-serif",
        ],
        mono: ['"Geist Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      boxShadow: {
        glass: "0 1px 0 0 rgba(255,255,255,0.04) inset, 0 8px 32px -12px rgba(0,0,0,0.6)",
        pop: "0 24px 64px -24px rgba(0,0,0,0.7)",
      },
      transitionTimingFunction: {
        smooth: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
