import { expect, test } from '@playwright/test';

const demoPassword = process.env.RESERVEFLOW_SEED_PASSWORD ?? 'ReserveFlowDemoOnly!2026';

async function signIn(page: import('@playwright/test').Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password').fill(demoPassword);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page.getByRole('heading', { name: /good to see you/i })).toBeVisible();
}

test('employee submits a request and an approver reserves budget', async ({ page }) => {
  const title = `Playwright purchase ${Date.now()}`;
  await signIn(page, 'employee@reserveflow.local');
  await page.getByRole('button', { name: /new request/i }).first().click();
  await page.getByLabel('Request title').fill(title);
  await page.getByLabel('Requested amount (AED)').fill('15.00');
  await page.getByLabel('Business justification').fill('End-to-end test for the ReserveFlow approval workflow.');
  await page.getByRole('button', { name: /create draft/i }).click();
  await expect(page.getByRole('heading', { name: title })).toBeVisible();
  await page.getByRole('button', { name: /submit for approval/i }).click();
  await expect(page.getByText('Request submitted for approval.')).toBeVisible();
  await expect(page.locator('.detail-drawer').getByText('Submitted')).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'approver@reserveflow.local');
  await page.getByRole('button', { name: 'Purchase requests' }).click();
  await page.getByRole('button', { name: new RegExp(title) }).first().click();
  await expect(page.locator('.detail-drawer').getByText('Submitted')).toBeVisible();
  await page.getByRole('button', { name: /approve & reserve/i }).click();
  await expect(page.getByText('Request approved and budget reserved.')).toBeVisible();
  await expect(page.locator('.detail-drawer').getByText('Approved')).toBeVisible();
});
