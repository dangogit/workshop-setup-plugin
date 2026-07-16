import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const onboarding = html.match(/<div class="card setup-card[\s\S]*?<div class="listening-summary/)?.[0] || '';
const ownershipStep = html.match(/<div id="setupModeStep">([\s\S]*?)<div id="setupTargetStep"/)?.[1] || '';

test('onboarding starts with one ownership question and two choices', () => {
  assert.match(ownershipStep, /איזה מספר חיברת/);
  assert.equal((ownershipStep.match(/<button class="setup-choice(?: recommended)?"/g) || []).length, 2);
  assert.match(ownershipStep, /המספר הרגיל שלי/);
  assert.match(ownershipStep, /מספר נפרד לבוט/);
  assert.doesNotMatch(ownershipStep, /בוט לקבוצה או ללקוחות/);
});

test('onboarding uses progressive disclosure and accessible feedback', () => {
  assert.match(onboarding, /שלב 1 מתוך 2/);
  assert.equal((onboarding.match(/id="setupProgress[12]"/g) || []).length, 2);
  assert.match(onboarding, /id="setupBackBtn"/);
  assert.match(onboarding, /aria-live="polite"/);
  assert.match(html, /setAttribute\('aria-busy', String\(busy\)\)/);
});

test('a new or completed connection clears stale onboarding navigation', () => {
  assert.match(html, /if \(complete \|\| s\.status !== 'connected'\) \{\s*pendingSetupMode = null;\s*setupParentStep = 'ownership';/);
});

test('onboarding structural icons are SVG instead of emoji', () => {
  assert.match(onboarding, /<svg viewBox="0 0 24 24">/);
  assert.doesNotMatch(onboarding, /📱|📲|👥|💬|1️⃣/u);
});
