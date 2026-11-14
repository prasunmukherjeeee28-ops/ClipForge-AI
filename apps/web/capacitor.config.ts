import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.clipforge.app",
  appName: "ClipForge",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
};

export default config;
