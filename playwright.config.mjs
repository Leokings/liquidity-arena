import { defineConfig, devices } from '@playwright/test';

const isCi = Boolean(process.env.CI);
const e2eV8Contract = '0x8888888888888888888888888888888888888888';

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
    // Never inherit a developer server with stale deployment environment.
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      VITE_GENLAYER_NETWORK: 'testnet-bradbury',
      VITE_GENLAYER_ACTIVE_DEPLOYMENT: 'v8',
      VITE_GENLAYER_PROTOCOL: 'LIQUIDITY_ARENA_V8',
      VITE_GENLAYER_CONTRACT: e2eV8Contract,
      VITE_GENLAYER_V8_CONTRACT: e2eV8Contract,
      VITE_GENLAYER_WALLET_RPC: '',
      GENLAYER_RPC_URL: 'https://rpc-bradbury.genlayer.com',
    },
  },
});
