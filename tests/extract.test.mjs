import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractCode, extractLink, htmlToText } from '../dist/extract.js';
import { messageMatches, parseDuration, parseSince } from '../dist/commands/wait.js';

test('extractCode finds the GitHub launch code on its own line', () => {
  assert.equal(extractCode({
    subject: 'Your GitHub launch code',
    text: "Here's your GitHub launch code, @octocat!\n\n58293017\n\nContinue signing up for GitHub by entering the code above.\n\n"
      + 'This code will expire in 15 minutes.\n\nGitHub, Inc. ・88 Colin P Kelly Jr Street ・San Francisco, CA 94107',
  }), '58293017');
});

test('extractCode reads a labelled device verification code and ignores digits inside links', () => {
  assert.equal(extractCode({
    subject: '[GitHub] Please verify your device',
    text: 'Hey octocat!\n\nA sign in attempt requires further verification because we did not recognize your device.\n\n'
      + 'Device: Chrome on macOS\nVerification code: 482913\n\n'
      + 'If you did not attempt to sign in, visit https://github.com/settings/security?ref=123456 to change your password.',
  }), '482913');
});

test('extractCode joins a grouped Stripe-style code and skips invoice numbers, amounts, dates and phone numbers', () => {
  assert.equal(extractCode({
    subject: 'Your Stripe verification code',
    text: "Hi there,\n\nUse the following code to sign in to Stripe:\n\n639-201\n\nThis code expires in 10 minutes. If you didn't request it, ignore this email.\n\n"
      + 'Invoice #1043 for $49.00 was paid on 2026-10-15.\nCall us at (415) 555-0199.\n\nStripe, 354 Oyster Point Blvd, South San Francisco, CA 94080',
  }), '639201');
});

test('extractCode understands a Chinese 验证码 email with phone and order numbers', () => {
  assert.equal(extractCode({
    subject: '【云服务】邮箱验证码',
    text: '尊敬的用户：\n您好！您正在进行邮箱验证，本次验证码为：582046，10分钟内有效。请勿将验证码泄露给他人。\n'
      + '如非本人操作，请忽略本邮件。客服电话：400-820-8820\n订单号：20261015001\n© 2026 云服务',
  }), '582046');
});

test('extractCode uses the subject and penalizes order numbers', () => {
  assert.equal(extractCode({
    subject: '771204 is your Acme sign-in code',
    text: 'Enter it in the app to finish signing in. Order #123456 shipped on 2026-10-01. Reference code: 777777',
  }), '771204');
});

test('extractCode reads HTML-only mail: ignores CSS colors and keeps alphanumeric codes', () => {
  assert.equal(extractCode({
    subject: 'Confirm your email address',
    html: '<html><head><style>.code{color:#123456;font-size:32px}</style></head><body><table width="600">'
      + '<tr><td>Your confirmation code is below — enter it in your open browser window.</td></tr>'
      + '<tr><td class="code" style="letter-spacing:8px">XKF-7QD</td></tr>'
      + '<tr><td>&copy; 2026 Example Technologies, 500 Howard Street</td></tr></table></body></html>',
  }), 'XKF7QD');
  assert.equal(extractCode({
    subject: 'Sign in',
    html: '<div style="display:none">Your code&zwnj;&nbsp;</div><p>Your login code: 9&#8203;1&#8203;2&#8203;3&#8203;4&#8203;5</p>',
  }), '912345');
});

test('extractCode returns null instead of guessing', () => {
  assert.equal(extractCode({
    subject: 'Welcome to Acme!',
    text: 'Thanks for joining Acme in 2026. Your account number is 88231. Visit https://acme.example/start?id=123456 to get started.',
  }), null);
  assert.equal(extractCode({}), null);
});

const marketingStyleHtml = `<html><head><style>a{color:#0969da}</style></head><body>
<a href="https://acme.example/"><img src="https://cdn.acme.example/logo.png" alt="Acme"></a>
<p>Click the button below to confirm your email address.</p>
<a href="https://u123.ct.sendgrid.net/ls/click?upn=abcDEF123456ghiJKL789&amp;x=1" style="background:#000">Confirm email address</a>
<p>Or paste this link into your browser: https://app.acme.example/verify?token=AbCdEf0123456789xyz&amp;email=user%40example.com</p>
<p><a href="https://acme.example/privacy">Privacy</a> · <a href="https://twitter.com/acme">Twitter</a>
 · <a href="https://acme.example/unsubscribe?u=123">Unsubscribe</a> · <a href="https://acme.example/preferences/email">Email preferences</a></p>
<img src="https://open.mailer.example/o/abc.gif" width="1" height="1"></body></html>`;

test('extractLink prefers the direct verification link over tracking, unsubscribe, policy and social links', () => {
  assert.equal(
    extractLink({ html: marketingStyleHtml }),
    'https://app.acme.example/verify?token=AbCdEf0123456789xyz&email=user%40example.com',
  );
  // Without the direct link, the tracked "Confirm" button is still the verification link.
  assert.equal(
    extractLink({ html: marketingStyleHtml.replace(/<p>Or paste[\s\S]*?<\/p>/, '') }),
    'https://u123.ct.sendgrid.net/ls/click?upn=abcDEF123456ghiJKL789&x=1',
  );
});

test('extractLink picks the GitHub "Verify email address" button over sign-in, report and policy links', () => {
  const html = `<p>Almost done, <strong>@octocat</strong>! To complete your GitHub sign up, we just need to verify your email address.</p>
<a href="https://github.com/users/octocat/emails/12345678/confirm_verification/0a1b2c3d4e5f60718293a4b5c6d7e8f9?via_launch_code_email=true">Verify email address</a>
<p>Once verified, <a href="https://github.com/login">sign in to GitHub</a>.</p>
<p>If this wasn't you, please <a href="https://github.com/contact/report-abuse?report=octocat">report this</a>.
<a href="https://docs.github.com/articles/github-terms-of-service">Terms</a> <a href="https://github.com/site/privacy">Privacy</a></p>`;
  assert.equal(
    extractLink({ subject: '[GitHub] Please verify your email address', html }),
    'https://github.com/users/octocat/emails/12345678/confirm_verification/0a1b2c3d4e5f60718293a4b5c6d7e8f9?via_launch_code_email=true',
  );
});

test('extractLink reads plain-text magic links and skips unsubscribe links', () => {
  assert.equal(extractLink({
    text: "Hi,\n\nClick the link below to sign in to Acme:\nhttps://app.acme.example/auth/magic?token=Zx81kLmN0pQ2rS3tU4v.\n\n"
      + "If you didn't request this, ignore this email.\n\nTo unsubscribe: https://acme.example/u/123abcdefghijklmnop",
  }), 'https://app.acme.example/auth/magic?token=Zx81kLmN0pQ2rS3tU4v');
  assert.equal(extractLink({
    text: '请点击以下链接完成邮箱验证（30分钟内有效）：\nhttps://www.example.cn/account/activate?code=8f3a9c2e1b7d4f60a\n'
      + '退订邮件：https://www.example.cn/unsubscribe?id=99',
  }), 'https://www.example.cn/account/activate?code=8f3a9c2e1b7d4f60a');
});

test('extractLink returns null when only home, unsubscribe and non-web links exist', () => {
  assert.equal(extractLink({
    html: '<a href="https://acme.example/">Home</a> <a href="https://acme.example/unsubscribe">Unsubscribe</a>'
      + ' <a href="mailto:help@acme.example">Email us</a> <a href="javascript:alert(1)">Verify</a>',
  }), null);
});

test('htmlToText drops markup and decodes entities', () => {
  assert.equal(htmlToText('<p>Hello&nbsp;<b>world</b></p><style>p{color:#123456}</style><br>Fish &amp; chips'), 'Hello world\n\nFish & chips');
});

test('wait durations and --since accept units, absolute times and now', () => {
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('1h30m'), 5_400_000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('90'), 90_000);
  assert.throws(() => parseDuration('soon'), /Invalid duration/);
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(parseSince('10m', now), now / 1000 - 600);
  assert.equal(parseSince('now', now), now / 1000);
  assert.equal(parseSince('2026-10-15T11:00:00Z', now), now / 1000 - 3600);
  assert.equal(parseSince('1760000000', now), 1760000000);
  assert.throws(() => parseSince('yesterday', now));
});

test('wait filters match exact senders, domains with subdomains, names, subjects and recipients', () => {
  const message = {
    from_address: 'noreply@mail.github.com', from_name: 'GitHub', to_address: 'agent@mailly.site',
    subject: 'Your GitHub launch code', direction: 'inbound',
  };
  assert.ok(messageMatches(message, { from: 'github.com' }));
  assert.ok(messageMatches(message, { from: '@GitHub.com' }));
  assert.ok(messageMatches(message, { from: 'NoReply@mail.github.com' }));
  assert.ok(messageMatches(message, { from: 'github' }));
  assert.ok(messageMatches(message, { subject: 'launch code', to: 'agent@mailly.site' }));
  assert.ok(!messageMatches(message, { from: 'noreply@github.com' }));
  assert.ok(!messageMatches({ ...message, from_address: 'noreply@github.com.attacker.example' }, { from: 'github.com' }));
  assert.ok(!messageMatches({ ...message, from_address: 'noreply@evilgithub.com' }, { from: 'github.com' }));
  assert.ok(!messageMatches(message, { subject: 'password reset' }));
  assert.ok(!messageMatches(message, { to: 'other@mailly.site' }));
  assert.ok(!messageMatches({ ...message, direction: 'outbound' }, {}));
});
