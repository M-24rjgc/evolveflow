import { test, expect } from '@playwright/test';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Wait for the app shell to finish loading (sidebar + main area). */
async function waitForAppReady(page: import('@playwright/test').Page) {
  await page.waitForSelector('.app-layout', { timeout: 15000 });
  await page.waitForSelector('.sidebar', { timeout: 10000 });
  await page.waitForSelector('.main-content', { timeout: 10000 });
  // Allow async data fetches to settle
  await page.waitForTimeout(1000);
}

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('EvolveFlow Desktop App', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page);
  });

  test('App loads and shows today page', async ({ page }) => {
    // The today page title should be visible
    await expect(page.locator('.page-title').first()).toBeVisible({ timeout: 10000 });
    const titleText = await page.locator('.page-title').first().textContent();
    expect(titleText).toContain('今天');

    // Sidebar and main content should be present
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.main-content')).toBeVisible();

    // The logo should be visible
    await expect(page.locator('.logo')).toBeVisible();
    await expect(page.locator('.logo')).toHaveText('EvolveFlow');
  });

  test('Navigation works (click sidebar links)', async ({ page }) => {
    const navLinks = page.locator('.nav-item');

    // Click "日历"
    await navLinks.filter({ hasText: '日历' }).click();
    await expect(page.locator('.page-title').first()).toHaveText('日历', { timeout: 10000 });

    // Click "任务"
    await navLinks.filter({ hasText: '任务' }).click();
    await expect(page.locator('.page-title').first()).toHaveText(/任务/, { timeout: 10000 });

    // Click "AI"
    await navLinks.filter({ hasText: 'AI' }).click();
    await expect(page.locator('.page-title').first()).toHaveText('AI 助手', { timeout: 10000 });

    // Click "分析"
    await navLinks.filter({ hasText: '分析' }).click();
    await expect(page.locator('.page-title').first()).toHaveText(/分析/, { timeout: 10000 });

    // Click "设置"
    await navLinks.filter({ hasText: '设置' }).click();
    await expect(page.locator('.page-title').first()).toHaveText('设置', { timeout: 10000 });

    // Navigate back home
    await navLinks.filter({ hasText: '今天' }).click();
    await expect(page.locator('.page-title').first()).toHaveText(/今天/, { timeout: 10000 });
  });

  test('Quick-add task creates a task optimistically', async ({ page }) => {
    // Navigate to today page
    await page.locator('.nav-item').filter({ hasText: '今天' }).click();

    // Type a task name into the quick-add input
    const quickAddInput = page.locator('.quick-add input');
    await expect(quickAddInput).toBeVisible({ timeout: 10000 });

    const testTaskTitle = `E2E Test Task ${Date.now()}`;
    await quickAddInput.fill(testTaskTitle);

    // Click the "添加" button
    await page.locator('.quick-add button').filter({ hasText: '添加' }).click();

    // Wait for the task to appear optimistically (it shows immediately in local state)
    await page.waitForTimeout(500);

    // The task should be visible somewhere on the page (sidebar nav still visible)
    await expect(page.locator('.task-item').first()).toBeVisible({ timeout: 5000 });
  });

  test('Settings page loads and shows preferences', async ({ page }) => {
    // Navigate to settings
    await page.locator('.nav-item').filter({ hasText: '设置' }).click();
    await expect(page.locator('.page-title').first()).toHaveText('设置', { timeout: 10000 });

    // Work hours section should be visible
    await expect(page.locator('h3.card-title').filter({ hasText: '工作时段' })).toBeVisible();

    // Reminder preferences section
    await expect(page.locator('h3.card-title').filter({ hasText: '提醒与安排偏好' })).toBeVisible();

    // AI configuration section
    await expect(page.locator('h3.card-title').filter({ hasText: 'AI 配置' })).toBeVisible();

    // Buddy settings section
    await expect(page.locator('h3.card-title').filter({ hasText: 'Buddy 设置' })).toBeVisible();

    // Keyboard shortcuts section
    await expect(page.locator('h3.card-title').filter({ hasText: '键盘快捷键' })).toBeVisible();
  });

  test('Calendar navigation (prev/next/today buttons)', async ({ page }) => {
    // Navigate to calendar
    await page.locator('.nav-item').filter({ hasText: '日历' }).click();
    await expect(page.locator('.page-title').first()).toHaveText('日历', { timeout: 10000 });

    // Today button should be visible
    const todayBtn = page.locator('button').filter({ hasText: '今天' }).first();
    await expect(todayBtn).toBeVisible({ timeout: 5000 });

    // Previous button (◀) should be visible
    const prevBtn = page.locator('button').filter({ hasText: '◀' }).first();
    await expect(prevBtn).toBeVisible();

    // Next button (▶) should be visible
    const nextBtn = page.locator('button').filter({ hasText: '▶' }).first();
    await expect(nextBtn).toBeVisible();

    // View toggle buttons
    await expect(page.locator('button').filter({ hasText: '日视图' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: '周视图' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: '月视图' })).toBeVisible();

    // Click "今天" to reset to today
    await todayBtn.click();

    // Click next to advance
    await nextBtn.click();
    await page.waitForTimeout(500);

    // Click previous to go back
    await prevBtn.click();
    await page.waitForTimeout(500);
  });

  test('AI page loads and shows input', async ({ page }) => {
    await page.locator('.nav-item').filter({ hasText: 'AI' }).click();
    await expect(page.locator('.page-title').first()).toHaveText('AI 助手', { timeout: 10000 });

    // The chat input should be visible
    const chatInput = page.locator('input[type="text"]').first();
    await expect(chatInput).toBeVisible({ timeout: 5000 });

    // Quick action buttons should be visible
    await expect(page.locator('button').filter({ hasText: '帮我安排今天的工作' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: '我今天有什么任务？' })).toBeVisible();
    await expect(page.locator('button').filter({ hasText: '创建一个高优先级的任务' })).toBeVisible();

    // The welcome message should be shown
    await expect(page.locator('text=你好！我是 EvolveFlow AI 助手').first()).toBeVisible({ timeout: 5000 });
  });

  test('404 page shown for unknown routes', async ({ page }) => {
    await page.goto('/this-route-does-not-exist');
    await page.waitForTimeout(1000);

    // Should show 404 text
    await expect(page.locator('text=404').first()).toBeVisible({ timeout: 5000 });
    await expect(page.locator('text=页面未找到').first()).toBeVisible({ timeout: 5000 });

    // Should have a link back to home
    const homeLink = page.locator('a').filter({ hasText: '返回今天页面' });
    await expect(homeLink).toBeVisible();
  });
});
