// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Event Calc - External Trigger Feature', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to Node-RED editor
    await page.goto('/');
    // Wait for Node-RED to load
    await page.waitForSelector('#red-ui-palette', { timeout: 30000 });
  });

  test('should show External Trigger checkbox in event-calc node configuration', async ({ page }) => {
    // Search for the event-calc node in the palette
    const paletteSearch = page.locator('#red-ui-palette-search input');
    await paletteSearch.fill('event calc');

    // Wait for search results
    await page.waitForTimeout(500);

    // Find the event-calc node in the palette
    const eventCalcNode = page.locator('.red-ui-palette-node[data-palette-type="event-calc"]');
    await expect(eventCalcNode).toBeVisible();

    // Drag the node to the workspace
    const workspace = page.locator('#red-ui-workspace-chart');
    await eventCalcNode.dragTo(workspace);

    // Double-click on the newly created node to open the editor
    // First find the node in the workspace
    const nodeInWorkspace = page.locator('.red-ui-flow-node-group').last();
    await nodeInWorkspace.dblclick();

    // Wait for the edit dialog to open
    await page.waitForSelector('.red-ui-editor', { timeout: 5000 });

    // Verify the External Trigger checkbox exists
    const externalTriggerCheckbox = page.locator('#node-input-externalTrigger');
    await expect(externalTriggerCheckbox).toBeVisible();

    // Verify it's unchecked by default
    await expect(externalTriggerCheckbox).not.toBeChecked();

    // Check the checkbox
    await externalTriggerCheckbox.check();
    await expect(externalTriggerCheckbox).toBeChecked();

    // Verify the label is correct
    const label = page.locator('label[for="node-input-externalTrigger"]');
    await expect(label).toContainText('External Trigger');
    await expect(label).toContainText('calculate on any input message');
  });

  test('should toggle External Trigger checkbox', async ({ page }) => {
    // Search for the event-calc node
    const paletteSearch = page.locator('#red-ui-palette-search input');
    await paletteSearch.fill('event calc');
    await page.waitForTimeout(500);

    // Find and drag the node
    const eventCalcNode = page.locator('.red-ui-palette-node[data-palette-type="event-calc"]');
    const workspace = page.locator('#red-ui-workspace-chart');
    await eventCalcNode.dragTo(workspace);

    // Open the node editor
    const nodeInWorkspace = page.locator('.red-ui-flow-node-group').last();
    await nodeInWorkspace.dblclick();
    await page.waitForSelector('.red-ui-editor', { timeout: 5000 });

    const externalTriggerCheckbox = page.locator('#node-input-externalTrigger');

    // Toggle on
    await externalTriggerCheckbox.check();
    await expect(externalTriggerCheckbox).toBeChecked();

    // Toggle off
    await externalTriggerCheckbox.uncheck();
    await expect(externalTriggerCheckbox).not.toBeChecked();

    // Toggle on again
    await externalTriggerCheckbox.check();
    await expect(externalTriggerCheckbox).toBeChecked();
  });

  test('should persist External Trigger setting after save', async ({ page }) => {
    // Search for event-cache node first (required config)
    const paletteSearch = page.locator('#red-ui-palette-search input');
    await paletteSearch.fill('event cache');
    await page.waitForTimeout(500);

    // Add event-cache config node if needed
    const eventCacheNode = page.locator('.red-ui-palette-node[data-palette-type="event-cache"]');
    if (await eventCacheNode.isVisible()) {
      const workspace = page.locator('#red-ui-workspace-chart');
      await eventCacheNode.dragTo(workspace);

      // Configure the cache node
      const cacheNodeInWorkspace = page.locator('.red-ui-flow-node-group').last();
      await cacheNodeInWorkspace.dblclick();
      await page.waitForSelector('.red-ui-editor', { timeout: 5000 });

      // Set a name for the cache
      const nameInput = page.locator('#node-input-name');
      await nameInput.fill('Test Cache');

      // Save the cache node
      const doneButton = page.locator('.red-ui-tray-footer button').filter({ hasText: 'Done' });
      await doneButton.click();
      await page.waitForTimeout(500);
    }

    // Now add the event-calc node
    await paletteSearch.clear();
    await paletteSearch.fill('event calc');
    await page.waitForTimeout(500);

    const eventCalcNode = page.locator('.red-ui-palette-node[data-palette-type="event-calc"]');
    const workspace = page.locator('#red-ui-workspace-chart');
    await eventCalcNode.dragTo(workspace);

    // Open the node editor
    const calcNodeInWorkspace = page.locator('.red-ui-flow-node-group').last();
    await calcNodeInWorkspace.dblclick();
    await page.waitForSelector('.red-ui-editor', { timeout: 5000 });

    // Check the External Trigger checkbox
    const externalTriggerCheckbox = page.locator('#node-input-externalTrigger');
    await externalTriggerCheckbox.check();

    // Save the node configuration
    const doneButton = page.locator('.red-ui-tray-footer button').filter({ hasText: 'Done' });
    await doneButton.click();
    await page.waitForTimeout(500);

    // Reopen the node editor
    await calcNodeInWorkspace.dblclick();
    await page.waitForSelector('.red-ui-editor', { timeout: 5000 });

    // Verify the checkbox is still checked
    await expect(externalTriggerCheckbox).toBeChecked();
  });
});
