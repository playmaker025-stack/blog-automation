import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/localhost-write-flow.spec.ts",
  fullyParallel: false,
  retries: 0,
  timeout: 300_000, // 5분
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report-localhost", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:3001",
    trace: "on",
    screenshot: "on",
    video: "off",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  outputDir: "test-results",
  // 앱이 이미 실행 중이므로 webServer는 사용하지 않음
});
