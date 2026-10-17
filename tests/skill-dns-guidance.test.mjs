import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Domain setup needs DNS changes outside Mailly; the skill must walk agents through them.
const maillySkillSource = await readFile(new URL('../skills/mailly/reference/commands.md', import.meta.url), 'utf8');

test("Mailly skill requires CLI agents to explain the external DNS step", () => {
  assert.match(maillySkillSource, /the CLI does not change DNS for the user/)
  assert.match(maillySkillSource, /DNS → Records → Add record/)
  assert.match(maillySkillSource, /do not assume the user knows where MX is configured/)
  assert.match(maillySkillSource, /mailly domains setup-outbound/)
  assert.match(maillySkillSource, /mailly domains verify-outbound/)
  assert.match(maillySkillSource, /CNAME proxy must be turned off/)
})

test("Mailly skill documents the Cloudflare one-click DNS flow without dropping manual guidance", () => {
  assert.match(maillySkillSource, /mailly dns set-token/)
  assert.match(maillySkillSource, /mailly domains apply-dns/)
  assert.match(maillySkillSource, /Zone \u2192 DNS \u2192 Edit/)
  assert.match(maillySkillSource, /idempotent/)
  assert.match(maillySkillSource, /conflict/)
  // The manual path must stay for users without a saved token or with another DNS provider.
  assert.match(maillySkillSource, /Without a saved Cloudflare token, or when DNS is hosted elsewhere, the CLI does not change DNS for the user/)
})
