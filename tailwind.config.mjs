/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef7ff",
          100: "#d9ecff",
          500: "#1a73e8",
          600: "#1557b0",
          700: "#0f3f80",
          900: "#0a2a55",
        },
      },
    },
  },
  plugins: [],
};
