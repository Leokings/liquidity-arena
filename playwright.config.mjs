import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: isCi,
  retries: isCi ? 2 : 0,
  workers: isCi ? 1 : undefined,
  timeout: 30_000,
  expect: {
    timeout: 10_000,
  },
  reporter: isCi ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4400',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      use: { ...devices['Pixel 7'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://127.0.0.1:4400/market.html',
    reuseExistingServer: !isCi,
    timeout: 120_000,
    env: {
      ...process.env,
      VITE_GENLAYER_NETWORK: 'studionet',
      VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v7',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V7',
      VITE_GENLAYER_CONTRACT: '0xb2ae59aE641f571726Ae81E30080f8c2192b15EF',
      VITE_GENLAYER_V7_CONTRACT: '0xb2ae59aE641f571726Ae81E30080f8c2192b15EF',
      VITE_GENLAYER_V6_CONTRACT: '0x587950DCDc2A8c4DFcde98a72715A06F5844e0b1',
      VITE_GENLAYER_WALLET_RPC: '',
    },
  },
});
