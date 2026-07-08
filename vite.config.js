import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // During local dev, forward function calls to `netlify dev` (port 8888)
    proxy: {
      "/.netlify/functions": "http://localhost:8888",
    },
  },
});
