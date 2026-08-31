import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const noVncProxies = Object.fromEntries(
  Array.from({ length: 100 }, (_, index) => 6200 + index).map((port) => {
    const route = `/novnc/${port}`;
    const options: ProxyOptions = {
      target: `http://127.0.0.1:${port}`,
      ws: true,
      rewrite: (path) => path.slice(route.length) || "/",
    };
    return [route, options];
  })
);

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  server: {
    host: process.env.OPENBOT_DEV_HOST ?? "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": process.env.OPENBOT_SERVER_URL ?? "http://127.0.0.1:8787",
      ...noVncProxies,
    },
  },
  build: { outDir: "dist" },
});
