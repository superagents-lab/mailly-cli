import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Domain setup needs DNS changes outside Mailly; the skill must walk agents through them.
const maillySkillSource = await readFile(new URL('../skills/mailly/reference/commands.md', import.meta.url), 'utf8');

test("Mailly skill requires CLI agents to explain the external DNS step", () => {
  assert.match(maillySkillSource, /CLI 不会代用户修改 DNS/)
  assert.match(maillySkillSource, /DNS → Records → Add record/)
  assert.match(maillySkillSource, /不要假设用户知道 MX 在哪里配置/)
  assert.match(maillySkillSource, /mailly domains setup-outbound/)
  assert.match(maillySkillSource, /mailly domains verify-outbound/)
  assert.match(maillySkillSource, /CNAME 必须关闭代理/)
})

test("Mailly skill documents the Cloudflare one-click DNS flow without dropping manual guidance", () => {
  assert.match(maillySkillSource, /mailly dns set-token/)
  assert.match(maillySkillSource, /mailly domains apply-dns/)
  assert.match(maillySkillSource, /Zone \u2192 DNS \u2192 Edit/)
  assert.match(maillySkillSource, /幂等/)
  assert.match(maillySkillSource, /conflict/)
  // 手动路径必须保留，供未保存 Token 或其他 DNS 服务商的用户使用。
  assert.match(maillySkillSource, /未保存 Cloudflare Token 或 DNS 在其他服务商时，CLI 不会代用户修改 DNS/)
})
