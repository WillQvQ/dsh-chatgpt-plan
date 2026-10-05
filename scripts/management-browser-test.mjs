// Requires Playwright and a browser. OAuth is mocked; no real credentials or external requests.
import assert from 'node:assert/strict';
import { startManagement } from '../management.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
const cases = [
  { name: 'add-account', button: 'Continue with ChatGPT', existing: false, newProfile: true, enablePlan: false },
  { name: 'sign-in-again', button: '重新登录', existing: true, newProfile: false, enablePlan: false },
  { name: 'authorize-plan', button: '授权套餐使用', existing: true, newProfile: false, enablePlan: true },
];
const results = [];
try {
  for (const spec of cases) {
    const begins = [], callbacks = [];
    let manager;
    const profile = { id: 'test-profile', email: 'test@example.invalid', clientId: 'synthetic-client', connected: true, planEnabled: false, models: [] };
    const auth = {
      initialize: async () => {},
      status: async () => ({ profiles: spec.existing ? [profile] : [], activeProfileId: spec.existing ? profile.id : null, pending: false }),
      // Keep even redirect destinations on loopback: route interception does
      // not necessarily intercept every hop after a continued request.
      begin: async options => { begins.push(options); return manager.origin + '/?mock-authorization'; },
      callback: async url => { callbacks.push(url.pathname); },
      cancel() {}, requestController: new AbortController(),
    };
    manager = await startManagement(auth, { port: 0 });
    const mockAuthorization = manager.origin + '/?mock-authorization';
    const context = await browser.newContext();
    try {
      await context.route('**/*', route => {
        const url = route.request().url();
        if (url.startsWith(manager.origin + '/')) return route.continue();
        return route.abort();
      });
      const page = await context.newPage();
      const loaded = page.waitForResponse(r => r.url() === manager.origin + '/api/status');
      const landing = await page.goto(manager.origin);
      assert.equal(landing.headers()['referrer-policy'], 'same-origin');
      await loaded;
      const [post] = await Promise.all([
        page.waitForResponse(r => r.url() === manager.origin + '/oauth/start'),
        page.getByRole('button', { name: spec.button, exact: true }).click(),
      ]);
      assert.equal(post.status(), 303);
      assert.equal(post.headers().location, mockAuthorization);
      assert.equal((await post.request().allHeaders()).origin, manager.origin);
      assert.equal(post.headers()['referrer-policy'], 'no-referrer');
      await page.waitForURL(mockAuthorization);
      assert.equal(await page.title(), 'DeepSeek Harness · ChatGPT 套餐');
      assert.deepEqual(begins, [{ redirectUri: manager.origin + '/auth/callback', profileId: spec.existing ? profile.id : undefined, newProfile: spec.newProfile, enablePlan: spec.enablePlan }]);
      const redirectedHome = page.waitForRequest(r => r.isNavigationRequest() && r.url() === manager.origin + '/');
      const callbackResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/auth/callback');
      await page.goto(manager.origin + '/auth/callback?state=synthetic&code=test-only');
      assert.equal((await callbackResponse).headers()['referrer-policy'], 'no-referrer');
      assert.equal((await (await redirectedHome).allHeaders()).referer, undefined);
      assert.deepEqual(callbacks, ['/auth/callback']);
      assert.equal(page.url(), manager.origin + '/');
      results.push({ case: spec.name, loginStatus: post.status(), callbackReferrerSuppressed: true });
    } finally {
      await context.close();
      manager.close();
    }
  }
  console.log(JSON.stringify({ success: true, realBrowser: true, oauth: 'mocked', cases: results }, null, 2));
} finally {
  await browser.close();
}
