import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.voice.shooter",
  appName: "Voice Shooter",
  webDir: "www",
  bundledWebRuntime: false,
  android: {
    allowMixedContent: true
  }
};

export default config;
