import type { ResolvedAuth } from './config.js';
import type { EmailAttachmentPayload } from './attachments.js';
import { mailSearchQuery, type MailSearchOptions } from './search.js';

export interface ClientOptions extends ResolvedAuth {}

export interface AgentInput {
  name?: string;
  persona_prompt?: string;
  mode?: 'off' | 'summarize' | 'draft';
  address_id?: string | null;
  allowed_senders?: string[];
  skills?: unknown[];
}

export interface AgentProfile {
  id: string;
  name: string;
  persona_prompt: string;
  mode: string;
  address_id: string | null;
  bound_address: string | null;
  allowed_senders_json: string | null;
  skills_json?: string;
}

export type InboxBodyFormat = 'text' | 'markdown' | 'html';

export interface InboxWebhookConfig {
  url: string;
  active: boolean;
  bodyFormat: InboxBodyFormat;
  stripQuotes: boolean;
  events: string[];
  signingSecretConfigured?: boolean;
  lastTest?: InboxWebhookLastTest | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface InboxWebhookLastTest {
  at: string;
  ok: boolean;
  responseStatus: number | null;
  error: string | null;
}

export interface InboxWebhookEndpoint extends InboxWebhookConfig {
  id: string;
  addressId: string;
  address: string | null;
}

export interface InboxWebhookTestResult {
  ok: boolean;
  eventId: string;
  responseStatus: number | null;
  error: string | null;
  durationMs: number;
  testedAt: string;
}

export interface InboxWebhookEndpointInput {
  url?: string;
  active?: boolean;
  bodyFormat?: InboxBodyFormat;
  stripQuotes?: boolean;
  signingSecret?: string;
  rotateSecret?: boolean;
}

export interface InboxMessageContent {
  id: string;
  text?: string | null;
  markdown?: string | null;
  html?: string | null;
  text_truncated: boolean | null;
  html_truncated: boolean | null;
  text_source: 'plain' | 'derived' | null;
  has_html: boolean;
  quotes_stripped?: boolean;
  attachments: unknown[];
}

export interface InboxAddress {
  id: string;
  address: string;
  created_at: number;
  message_count: number;
}

export interface InboxAttachment {
  id?: string;
  filename: string;
  mimeType: string;
  size?: number;
  disposition?: 'attachment' | 'inline';
  contentId?: string;
  download_url?: string;
}

export interface InboxMessage {
  id: string;
  address_id: string;
  to_address: string;
  from_address: string;
  from_name?: string | null;
  subject?: string | null;
  snippet?: string | null;
  text_body?: string | null;
  html_body?: string | null;
  message_id?: string | null;
  in_reply_to?: string | null;
  references?: string[];
  attachments?: InboxAttachment[];
  raw_size?: number;
  is_read: boolean;
  received_at: number;
  reply_to_address?: string | null;
  thread_id: string;
  direction: 'inbound' | 'outbound';
  folder?: 'inbox' | 'quarantine';
  quarantine_reason?: string | null;
  authentication_json?: string | null;
}

export interface InboxListOptions extends MailSearchOptions {
  addressId?: string;
  senderDomain?: string;
  limit?: number;
  cursor?: string;
  folder?: string;
}

function inboxListQuery(options: InboxListOptions) {
  return {
    address_id: options.addressId,
    limit: options.limit,
    cursor: options.cursor,
    folder: options.folder,
    sender_domain: options.senderDomain,
    ...mailSearchQuery(options),
  };
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

// --- CLI device-code flow ---

export interface CliAuthInitResult {
  deviceToken: string;
  expiresIn: number;
  interval: number;
}

export type CliAuthPollResult =
  | { status: 'pending' }
  | { status: 'approved'; apiKey: string; email: string }
  | { status: 'expired' };

export async function cliAuthInit(baseUrl: string, deviceToken: string): Promise<CliAuthInitResult> {
  const root = baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${root}/cli/auth/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ deviceToken }),
  });
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data?.success) {
    throw new ApiError(res.status, data?.error || `init failed (${res.status})`, data);
  }
  return {
    deviceToken: data.deviceToken,
    expiresIn: data.expiresIn,
    interval: data.interval,
  };
}

export async function cliAuthPoll(baseUrl: string, deviceToken: string): Promise<CliAuthPollResult> {
  const root = baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${root}/cli/auth/poll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ deviceToken }),
  });

  if (res.status === 202) {
    return { status: 'pending' };
  }
  if (res.status === 410) {
    return { status: 'expired' };
  }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !data?.success) {
    throw new ApiError(res.status, data?.error || `poll failed (${res.status})`, data);
  }
  return { status: 'approved', apiKey: data.apiKey, email: data.email };
}

export class MaillyClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(opts: ClientOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
  }

  async request<T = unknown>(
    method: string,
    path: string,
    init?: {
      body?: unknown;
      rawBody?: string;
      contentType?: string;
      query?: Record<string, string | number | undefined>;
      headers?: Record<string, string>;
      raw?: boolean;
    }
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    if (init?.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v != null) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...init?.headers,
    };
    if (init?.body !== undefined || init?.rawBody !== undefined) {
      headers['Content-Type'] = init.contentType ?? 'application/json';
    }
    const res = await fetch(url, {
      method,
      headers,
      body: init?.rawBody ?? (init?.body !== undefined ? JSON.stringify(init.body) : undefined),
    });

    if (init?.raw) {
      return res as unknown as T;
    }

    const text = await res.text();
    let parsed: any = text;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // leave as text
      }
    }

    if (!res.ok) {
      const message =
        (parsed && typeof parsed === 'object' && 'error' in parsed && (parsed as any).error) ||
        res.statusText ||
        `HTTP ${res.status}`;
      throw new ApiError(res.status, String(message), parsed);
    }
    return parsed as T;
  }

  // --- Endpoints ---

  balance() {
    return this.request<{ success: boolean; balance: number }>('GET', '/balance');
  }

  sendEmail(payload: {
    to?: string | Array<string | { email: string; externalId: string }>;
    subject: string;
    html?: string;
    text?: string;
    fromEmail: string;
    fromName?: string;
    replyTo?: string;
    cc?: string;
    bcc?: string;
    provider?: string;
    emailType?: 'transactional' | 'lifecycle' | 'marketing';
    campaignKey?: string;
    campaignName?: string;
    testSend?: boolean;
    frequencyCapDays?: number;
    frequencyCapMax?: number;
    topicExclusionDays?: number;
    recipientReason?: string;
    templateKey?: string;
    templateVersion?: number;
    audienceDefinition?: unknown;
    sourceApp?: string;
    utm?: Record<string, string>;
    businessGoal?: string;
    scheduledAt?: number;
    topic?: string;
    dryRun?: boolean;
    audience?: { include?: string[]; exclude?: string[]; recipients?: string[] };
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    attachments?: EmailAttachmentPayload[];
  }) {
    return this.request<{
      success: boolean;
      message?: string;
      provider_response?: any;
      error?: string;
      dryRun?: boolean;
      planned?: number;
      eligible?: number;
      suppressed?: number;
      exclusions?: Array<{ email: string; reason?: string }>;
      campaignKey?: string | null;
      campaignStatus?: string | null;
      inputCount?: number;
      deduplicatedCount?: number;
      duplicateCount?: number;
      duplicateRecipients?: Array<{ index: number; email: string }>;
      invalidCount?: number;
      invalidRecipients?: Array<{ index: number; input: string; reason: string }>;
      unsubscribedCount?: number;
      unsubscribedRecipients?: Array<{ email: string; reason: string }>;
      suppressedCount?: number;
      suppressedRecipients?: Array<{ email: string; reason: string }>;
      alreadySentCount?: number;
      alreadySentRecipients?: Array<{ email: string; status: string }>;
      campaignClaimedCount?: number;
      campaignClaimedRecipients?: Array<{ email: string; status: string }>;
      frequencyCappedCount?: number;
      frequencyCappedRecipients?: Array<{ email: string; sendCount: number }>;
      topicExcludedCount?: number;
      topicExcludedRecipients?: Array<{ email: string; lastSentAt: number }>;
      eligibleCount?: number;
      requiredEmailUnits?: number;
      availableEmailUnits?: number;
      scheduled?: boolean;
      scheduledAt?: number;
      dispatchId?: string;
      audience?: Record<string, unknown>;
    }>('POST', '/send-email', { body: payload });
  }

  emailStatus(taskId: string) {
    return this.request<any>('GET', `/email-status/${encodeURIComponent(taskId)}`);
  }

  listCampaigns(limit?: number, offset?: number) {
    return this.request<any>('GET', '/campaigns', { query: { limit, offset } });
  }

  createCampaign(input: unknown) {
    return this.request<any>('POST', '/campaigns', { body: input });
  }

  getMarketingSettings() {
    return this.request<any>('GET', '/marketing-settings');
  }

  updateMarketingSettings(input: { brandName: string; postalAddress: string }) {
    return this.request<any>('PUT', '/marketing-settings', { body: input });
  }

  getPreferenceStatus(email: string) {
    return this.request<any>('GET', '/preferences', { query: { email } });
  }

  resubscribePreference(input: {
    email: string;
    scope: 'workspace';
    source: string;
    consentAt: string;
    consentReference: string;
  }) {
    return this.request<any>('POST', '/preferences/resubscribe', { body: input });
  }

  getCampaign(campaignKey: string) {
    return this.request<any>('GET', `/campaigns/${encodeURIComponent(campaignKey)}`);
  }

  listDeliveryEvents(options: {
    campaignKey?: string;
    recipientId?: string;
    externalId?: string;
    messageId?: string;
    providerMessageId?: string;
    type?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    return this.request<any>('GET', '/delivery-events', { query: options });
  }

  getDeliveryEvent(eventId: string) {
    return this.request<any>('GET', `/delivery-events/${encodeURIComponent(eventId)}`);
  }

  listSentMessages(options: {
    source?: string;
    status?: string;
    deliveryStatus?: string;
    recipient?: string;
    sender?: string;
    subject?: string;
    match?: string;
    since?: number;
    until?: number;
    campaignKey?: string;
    taskId?: string;
    providerMessageId?: string;
    q?: string;
    limit?: number;
    offset?: number;
  } = {}) {
    return this.request<any>('GET', '/sent-messages', { query: options });
  }

  getSentMessage(messageId: string) {
    return this.request<any>('GET', `/sent-messages/${encodeURIComponent(messageId)}`);
  }

  replayDeliveryWebhook(eventId: string) {
    return this.request<any>('POST', `/delivery-events/${encodeURIComponent(eventId)}/replay`);
  }

  getDeliveryWebhook() {
    return this.request<any>('GET', '/delivery-webhook');
  }

  setDeliveryWebhook(input: {
    url: string;
    events?: string[];
    signingSecret?: string;
    rotateSecret?: boolean;
    active?: boolean;
  }) {
    return this.request<any>('PUT', '/delivery-webhook', { body: input });
  }

  disableDeliveryWebhook() {
    return this.request<any>('DELETE', '/delivery-webhook');
  }

  getCampaignAudience(campaignKey: string, limit?: number, offset?: number) {
    return this.request<any>('GET', `/campaigns/${encodeURIComponent(campaignKey)}/audience`, {
      query: { limit, offset },
    });
  }

  trackWorkflowEvent(input: {
    event_id: string;
    event_name: string;
    occurred_at: string;
    contact: {
      external_contact_id: string;
      email: string;
      attributes?: Record<string, unknown>;
    };
    properties?: Record<string, unknown>;
  }) {
    return this.request<any>('POST', '/events', { body: input });
  }

  trackWorkflowEvents(events: unknown[]) {
    return this.request<any>('POST', '/events/batch', { body: { events } });
  }

  getWorkflowEvent(eventId: string) {
    return this.request<any>('GET', `/events/${encodeURIComponent(eventId)}`);
  }

  replayWorkflowEvent(eventId: string) {
    return this.request<any>('POST', `/events/${encodeURIComponent(eventId)}/replay`);
  }

  getWorkflowContact(externalContactId: string) {
    return this.request<any>('GET', `/contacts/${encodeURIComponent(externalContactId)}`);
  }

  getWorkflowContactTimeline(externalContactId: string, limit?: number) {
    return this.request<any>('GET', `/contacts/${encodeURIComponent(externalContactId)}/timeline`, {
      query: { limit },
    });
  }

  listContacts(options: { limit?: number; offset?: number; status?: string; tag?: string } = {}) {
    return this.request<any>('GET', '/contacts', { query: options });
  }

  upsertContact(externalContactId: string, input: unknown) {
    return this.request<any>('PUT', `/contacts/${encodeURIComponent(externalContactId)}`, { body: input });
  }

  upsertContacts(contacts: unknown[]) {
    return this.request<any>('POST', '/contacts/batch', { body: { contacts } });
  }

  importContactsCsv(csv: string) {
    return this.request<any>('POST', '/contacts/import', {
      rawBody: csv,
      contentType: 'text/csv; charset=utf-8',
    });
  }

  suppressContact(externalContactId: string, input: { reason?: string; source?: string } = {}) {
    return this.request<any>('POST', `/contacts/${encodeURIComponent(externalContactId)}/suppress`, { body: input });
  }

  deleteContact(externalContactId: string) {
    return this.request<any>('DELETE', `/contacts/${encodeURIComponent(externalContactId)}`);
  }

  getContactHistory(externalContactId: string, limit?: number) {
    return this.request<any>('GET', `/contacts/${encodeURIComponent(externalContactId)}/history`, { query: { limit } });
  }

  getContactAudiences(externalContactId: string) {
    return this.request<any>('GET', `/contacts/${encodeURIComponent(externalContactId)}/audiences`);
  }

  listAudiences(limit?: number, offset?: number) {
    return this.request<any>('GET', '/audiences', { query: { limit, offset } });
  }

  createAudience(input: unknown) {
    return this.request<any>('POST', '/audiences', { body: input });
  }

  getAudience(audienceKey: string) {
    return this.request<any>('GET', `/audiences/${encodeURIComponent(audienceKey)}`);
  }

  updateAudience(audienceKey: string, input: unknown) {
    return this.request<any>('PUT', `/audiences/${encodeURIComponent(audienceKey)}`, { body: input });
  }

  deleteAudience(audienceKey: string) {
    return this.request<any>('DELETE', `/audiences/${encodeURIComponent(audienceKey)}`);
  }

  previewAudience(audienceKey: string, sampleLimit?: number) {
    return this.request<any>('GET', `/audiences/${encodeURIComponent(audienceKey)}/preview`, {
      query: { sampleLimit },
    });
  }

  previewAudienceSelection(input: unknown) {
    return this.request<any>('POST', '/audiences/preview', { body: input });
  }

  updateAudienceMembers(audienceKey: string, externalIds: string[], mode: 'add' | 'replace') {
    return this.request<any>('POST', `/audiences/${encodeURIComponent(audienceKey)}/members`, {
      body: { externalIds, mode },
    });
  }

  removeAudienceMember(audienceKey: string, externalContactId: string) {
    return this.request<any>(
      'DELETE',
      `/audiences/${encodeURIComponent(audienceKey)}/members/${encodeURIComponent(externalContactId)}`,
    );
  }

  listWorkflows() {
    return this.request<any>('GET', '/workflows');
  }

  listEmailTemplates(limit?: number, offset?: number) {
    return this.request<any>('GET', '/templates', { query: { limit, offset } });
  }

  createEmailTemplate(input: { templateKey: string; name: string; definition: unknown }) {
    return this.request<any>('POST', '/templates', { body: input });
  }

  getEmailTemplate(templateKey: string) {
    return this.request<any>('GET', `/templates/${encodeURIComponent(templateKey)}`);
  }

  updateEmailTemplateDraft(templateKey: string, input: { name?: string; definition: unknown }) {
    return this.request<any>('PUT', `/templates/${encodeURIComponent(templateKey)}/draft`, { body: input });
  }

  publishEmailTemplate(templateKey: string) {
    return this.request<any>('POST', `/templates/${encodeURIComponent(templateKey)}/publish`);
  }

  renderEmailTemplate(templateKey: string, input: {
    version?: number;
    draft?: boolean;
    locale?: string;
    variables?: unknown;
  }) {
    return this.request<any>('POST', `/templates/${encodeURIComponent(templateKey)}/render`, { body: input });
  }

  testSendEmailTemplate(templateKey: string, input: {
    to: string;
    version?: number;
    draft?: boolean;
    locale?: string;
    variables?: unknown;
  }) {
    return this.request<any>('POST', `/templates/${encodeURIComponent(templateKey)}/test-send`, { body: input });
  }

  archiveEmailTemplate(templateKey: string) {
    return this.request<any>('POST', `/templates/${encodeURIComponent(templateKey)}/archive`);
  }

  createWorkflow(input: { workflowKey: string; name: string; definition: unknown }) {
    return this.request<any>('POST', '/workflows', { body: input });
  }

  getWorkflow(workflowKey: string) {
    return this.request<any>('GET', `/workflows/${encodeURIComponent(workflowKey)}`);
  }

  updateWorkflowDraft(workflowKey: string, input: { name?: string; definition: unknown }) {
    return this.request<any>('PUT', `/workflows/${encodeURIComponent(workflowKey)}/draft`, { body: input });
  }

  publishWorkflow(workflowKey: string, input: { inFlightPolicy?: 'continue' | 'migrate' } = {}) {
    return this.request<any>('POST', `/workflows/${encodeURIComponent(workflowKey)}/publish`, { body: input });
  }

  workflowAction(workflowKey: string, action: 'pause' | 'resume' | 'archive') {
    return this.request<any>('POST', `/workflows/${encodeURIComponent(workflowKey)}/${action}`);
  }

  listWorkflowRuns(workflowKey: string, options: { status?: string; limit?: number; offset?: number } = {}) {
    return this.request<any>('GET', `/workflows/${encodeURIComponent(workflowKey)}/runs`, { query: options });
  }

  getWorkflowRun(workflowKey: string, runId: string) {
    return this.request<any>(
      'GET',
      `/workflows/${encodeURIComponent(workflowKey)}/runs/${encodeURIComponent(runId)}`,
    );
  }

  campaignAction(campaignKey: string, action: 'pause' | 'resume' | 'cancel' | 'complete') {
    return this.request<any>('POST', `/campaigns/${encodeURIComponent(campaignKey)}/${action}`);
  }

  updateCampaignContent(
    campaignKey: string,
    content: { subject?: string; html?: string | null; text?: string | null },
  ) {
    return this.request<any>('PATCH', `/campaigns/${encodeURIComponent(campaignKey)}/content`, {
      body: content,
    });
  }

  resendUnsentCampaignRecipients(campaignKey: string, options: { dryRun?: boolean } = {}) {
    return this.request<any>('POST', `/campaigns/${encodeURIComponent(campaignKey)}/resend-unsent`, {
      body: options,
    });
  }

  listCampaignRecipients(campaignKey: string, options: { status?: string; limit?: number; offset?: number } = {}) {
    return this.request<any>('GET', `/campaigns/${encodeURIComponent(campaignKey)}/recipients`, {
      query: options,
    });
  }

  getContactCampaignHistory(email: string, options: { limit?: number; offset?: number } = {}) {
    return this.request<any>('GET', '/campaigns/contact-history', {
      query: { email, ...options },
    });
  }

  async downloadCampaignRecipientsCSV(campaignKey: string): Promise<{ filename: string; csv: string }> {
    const path = `/campaigns/${encodeURIComponent(campaignKey)}/recipients.csv`;
    const res = (await this.request<Response>('GET', path, { raw: true })) as Response;
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, `Failed to download campaign recipients (${res.status})`, text);
    }
    const csv = await res.text();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    return { filename: match?.[1] ?? `campaign-${campaignKey}-recipients.csv`, csv };
  }

  sendCode(email: string) {
    return this.request<{ success: boolean; message?: string }>('POST', '/send-code', {
      body: { email },
    });
  }

  verifyCode(email: string, code: string) {
    return this.request<{ success: boolean; message?: string }>('POST', '/verify-code', {
      body: { email, code },
    });
  }

  listLogs(limit?: number, offset?: number) {
    return this.request<{
      success: boolean;
      logs: Array<{
        log_id: string;
        timestamp: string;
        amount_deducted: number;
        caller_email: string;
        target_email?: string | null;
        from_email?: string | null;
        subject?: string | null;
        send_mode?: string | null;
        recipient_count?: number | null;
        task_id?: string | null;
      }>;
      limit: number;
      offset: number;
    }>('GET', '/logs', { query: { limit, offset } });
  }

  async downloadLogsCSV(): Promise<{ filename: string; csv: string }> {
    const res = (await this.request<Response>('GET', '/logs/download', { raw: true })) as Response;
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, `Failed to download logs (${res.status})`, text);
    }
    const csv = await res.text();
    const disposition = res.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] ?? `mailly_logs_${new Date().toISOString().slice(0, 10)}.csv`;
    return { filename, csv };
  }

  listMailDrafts(threadId?: string) {
    return this.request<any>('GET', '/mail-drafts', { query: { thread_id: threadId } });
  }

  getMailDraft(id: string) {
    return this.request<any>('GET', `/mail-drafts/${encodeURIComponent(id)}`);
  }

  saveMailDraft(input: { anchor_email_id: string; text: string; idempotency_key: string }) {
    return this.request<any>('POST', '/mail-drafts', { body: input });
  }

  updateMailDraft(id: string, input: { text: string; revision: number }) {
    return this.request<any>('PATCH', `/mail-drafts/${encodeURIComponent(id)}`, { body: input });
  }

  approveMailDraft(id: string, input: { text: string; revision: number }) {
    return this.request<any>('POST', `/mail-drafts/${encodeURIComponent(id)}/approve`, { body: input });
  }

  discardMailDraft(id: string, revision: number) {
    return this.request<any>('POST', `/mail-drafts/${encodeURIComponent(id)}/discard`, { body: { revision } });
  }

  listAgents() {
    return this.request<{ success: boolean; agents: AgentProfile[] }>('GET', '/agents');
  }

  createAgent(input: AgentInput & { name: string }) {
    return this.request<{ success: boolean; id: string }>('POST', '/agents', { body: input });
  }

  updateAgent(id: string, input: AgentInput) {
    return this.request<{ success: boolean }>('PATCH', `/agents/${encodeURIComponent(id)}`, { body: input });
  }

  createInboxAddress(input: { prefix?: string; domain: string }) {
    return this.request<{
      success: boolean;
      address?: {
        id: string;
        address: string;
        created_at: number;
        message_count: number;
      };
      error?: string;
    }>('POST', '/inbox/addresses', { body: input });
  }

  listInboxAddresses() {
    return this.request<{
      success: boolean;
      domain: string;
      domains: Array<Record<string, unknown>>;
      addresses: InboxAddress[];
    }>('GET', '/inbox/addresses');
  }

  deleteInboxAddress(addressId: string) {
    return this.request<{ success: boolean }>(
      'DELETE',
      `/inbox/addresses/${encodeURIComponent(addressId)}`,
    );
  }

  listInboxMessages(options: InboxListOptions = {}) {
    return this.request<{ success: boolean; messages: InboxMessage[]; cursor: string | null }>(
      'GET',
      '/inbox/messages',
      { query: inboxListQuery(options) },
    );
  }

  getInboxMessage(messageId: string) {
    return this.request<{ success: boolean; message: InboxMessage }>(
      'GET',
      `/inbox/messages/${encodeURIComponent(messageId)}`,
    );
  }

  deleteInboxMessage(messageId: string) {
    return this.request<{ success: boolean }>(
      'DELETE',
      `/inbox/messages/${encodeURIComponent(messageId)}`,
    );
  }

  releaseInboxMessage(messageId: string) {
    return this.request<{ success: boolean }>('POST', `/inbox/messages/${encodeURIComponent(messageId)}/release`);
  }

  listInboxThreads(options: InboxListOptions = {}) {
    return this.request<{
      success: boolean;
      threads: Array<{
        thread_id: string;
        message_count: number;
        unread_count: number;
        last_received_at: number;
        latest_message: InboxMessage | null;
      }>;
      cursor: string | null;
    }>('GET', '/inbox/threads', { query: inboxListQuery(options) });
  }

  getInboxThread(threadId: string, folder?: string) {
    return this.request<{ success: boolean; thread_id: string; messages: InboxMessage[] }>(
      'GET',
      `/inbox/threads/${encodeURIComponent(threadId)}`,
      { query: { folder } },
    );
  }

  setInboxMessageReadState(messageId: string, isRead: boolean) {
    return this.request<{ success: boolean; id: string; is_read: boolean; changed: boolean }>(
      'PATCH',
      `/inbox/messages/${encodeURIComponent(messageId)}/read-state`,
      { body: { is_read: isRead } },
    );
  }

  setInboxThreadReadState(threadId: string, isRead: boolean) {
    return this.request<{
      success: boolean;
      thread_id: string;
      is_read: boolean;
      updated_count: number;
    }>(
      'PATCH',
      `/inbox/threads/${encodeURIComponent(threadId)}/read-state`,
      { body: { is_read: isRead } },
    );
  }

  forwardInboxMessage(messageId: string, input: {
    to: string;
    text?: string;
    html?: string;
    subject?: string;
    fromName?: string;
    includeAttachments?: boolean;
    attachments?: EmailAttachmentPayload[];
  }, idempotencyKey: string) {
    const { includeAttachments, ...rest } = input;
    return this.request<{
      success: boolean;
      status?: 'processing' | 'completed';
      id?: string;
      reply_id?: string;
      thread_id?: string;
      request_id?: string;
      to?: string;
      subject?: string;
      message_id?: string;
      idempotent_replay?: boolean;
    }>(
      'POST',
      `/inbox/messages/${encodeURIComponent(messageId)}/forward`,
      { body: { ...rest, ...(includeAttachments === false ? { include_attachments: false } : {}) }, headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }

  replyToInboxMessage(messageId: string, input: {
    text?: string;
    html?: string;
    subject?: string;
    to?: string;
    fromName?: string;
    attachments?: EmailAttachmentPayload[];
  }, idempotencyKey: string) {
    return this.request<{
      success: boolean;
      status?: 'processing' | 'completed';
      id?: string;
      reply_id?: string;
      thread_id?: string;
      request_id?: string;
      to?: string;
      subject?: string;
      message_id?: string;
      idempotent_replay?: boolean;
    }>(
      'POST',
      `/inbox/messages/${encodeURIComponent(messageId)}/reply`,
      { body: input, headers: { 'Idempotency-Key': idempotencyKey } },
    );
  }

  getInboxReply(requestId: string) {
    return this.request<any>('GET', `/inbox/replies/${encodeURIComponent(requestId)}`);
  }

  async downloadInboxAttachment(messageId: string, attachmentId: string): Promise<{
    filename: string;
    contentType: string;
    bytes: Uint8Array;
  }> {
    const path = `/inbox/messages/${encodeURIComponent(messageId)}`
      + `/attachments/${encodeURIComponent(attachmentId)}`;
    const res = await this.request<Response>('GET', path, { raw: true });
    if (!res.ok) {
      const text = await res.text();
      throw new ApiError(res.status, `Failed to download attachment (${res.status})`, text);
    }
    const disposition = res.headers.get('content-disposition') || '';
    const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1];
    const filename = encoded ? decodeURIComponent(encoded) : plain || `attachment-${attachmentId}`;
    return {
      filename,
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      bytes: new Uint8Array(await res.arrayBuffer()),
    };
  }

  getInboxMessageContent(
    messageId: string,
    options: { format?: InboxBodyFormat; stripQuotes?: boolean } = {},
  ) {
    return this.request<{ success: boolean; content: InboxMessageContent }>(
      'GET',
      `/inbox/messages/${encodeURIComponent(messageId)}/content`,
      {
        query: {
          format: options.format,
          strip_quotes: options.stripQuotes ? 'true' : undefined,
        },
      },
    );
  }

  getInboxWebhook() {
    return this.request<{ success: boolean; webhook: InboxWebhookConfig | null }>(
      'GET',
      '/inbox/webhook',
    );
  }

  setInboxWebhook(input: {
    url: string;
    bodyFormat?: InboxBodyFormat;
    stripQuotes?: boolean;
    signingSecret?: string;
    rotateSecret?: boolean;
  }) {
    return this.request<{
      success: boolean;
      webhook: InboxWebhookConfig;
      signingSecret?: string;
    }>('PUT', '/inbox/webhook', { body: input });
  }

  disableInboxWebhook() {
    return this.request<{ success: boolean; disabled: boolean }>('DELETE', '/inbox/webhook');
  }

  testInboxWebhook() {
    return this.request<{ success: boolean; test: InboxWebhookTestResult }>('POST', '/inbox/webhook/test');
  }

  listInboxWebhookEndpoints(addressId?: string) {
    return this.request<{ success: boolean; endpoints: InboxWebhookEndpoint[] }>(
      'GET',
      '/inbox/webhook/endpoints',
      { query: { address_id: addressId } },
    );
  }

  getInboxWebhookEndpoint(endpointId: string) {
    return this.request<{ success: boolean; endpoint: InboxWebhookEndpoint }>(
      'GET',
      `/inbox/webhook/endpoints/${encodeURIComponent(endpointId)}`,
    );
  }

  createInboxWebhookEndpoint(input: InboxWebhookEndpointInput & { addressId: string; url: string }) {
    return this.request<{ success: boolean; endpoint: InboxWebhookEndpoint; signingSecret?: string }>(
      'POST',
      '/inbox/webhook/endpoints',
      { body: input },
    );
  }

  updateInboxWebhookEndpoint(endpointId: string, input: InboxWebhookEndpointInput) {
    return this.request<{ success: boolean; endpoint: InboxWebhookEndpoint; signingSecret?: string }>(
      'PATCH',
      `/inbox/webhook/endpoints/${encodeURIComponent(endpointId)}`,
      { body: input },
    );
  }

  deleteInboxWebhookEndpoint(endpointId: string) {
    return this.request<{ success: boolean; removed: boolean }>(
      'DELETE',
      `/inbox/webhook/endpoints/${encodeURIComponent(endpointId)}`,
    );
  }

  testInboxWebhookEndpoint(endpointId: string) {
    return this.request<{ success: boolean; test: InboxWebhookTestResult; endpoint: InboxWebhookEndpoint }>(
      'POST',
      `/inbox/webhook/endpoints/${encodeURIComponent(endpointId)}/test`,
    );
  }

  getInboxWebhookAddressSubscription(addressId: string) {
    return this.request<{
      success: boolean;
      subscription: InboxWebhookConfig & { addressId: string; endpointCount?: number } | null;
    }>('GET', `/inbox/webhook/addresses/${encodeURIComponent(addressId)}`);
  }

  setInboxWebhookAddressSubscription(addressId: string, input: {
    url: string;
    bodyFormat?: InboxBodyFormat;
    stripQuotes?: boolean;
    signingSecret?: string;
    rotateSecret?: boolean;
  }) {
    return this.request<{
      success: boolean;
      subscription: InboxWebhookConfig & { addressId: string };
      signingSecret?: string;
    }>('PUT', `/inbox/webhook/addresses/${encodeURIComponent(addressId)}`, { body: input });
  }

  removeInboxWebhookAddressSubscription(addressId: string) {
    return this.request<{ success: boolean; removed: boolean }>(
      'DELETE', `/inbox/webhook/addresses/${encodeURIComponent(addressId)}`,
    );
  }

  listSenderDomains() {
    return this.request<{
      success: boolean;
      domains: Array<{
        id: string;
        domain: string;
        status: string;
        ownershipStatus?: 'pending' | 'verified' | 'rejected';
        outboundStatus?: 'not_configured' | 'pending' | 'verified' | 'rejected';
        isDefault: number;
        inboundStatus?: 'not_configured' | 'pending' | 'verified' | 'misconfigured';
        inboundVerifiedAt?: number | null;
        inboundLastCheckedAt?: number | null;
        inboundError?: string | null;
        outboundMailFromDomain?: string | null;
        outboundSesRegion?: string | null;
        outboundLastCheckedAt?: number | null;
        outboundError?: string | null;
        outboundDnsRecords?: Array<{
          type: 'CNAME' | 'MX' | 'TXT';
          host: string;
          name: string;
          value: string;
          priority?: number;
          purpose: 'dkim' | 'mail_from' | 'mail_from_spf';
          required: boolean;
        }>;
        createdAt: number;
        updatedAt: number;
      }>;
      inboundMxHost?: string;
    }>('GET', '/sender-domains', { query: { include_unverified: 1 } });
  }

  addSenderDomain(domain: string) {
    return this.request<{
      success: boolean;
      message?: string;
      domain?: any;
      error?: string;
    }>('POST', '/sender-domains', { body: { domain } });
  }

  verifyInboundDomain(id: string) {
    return this.request<{
      success: boolean;
      ready: boolean;
      message?: string;
      error?: string;
      expectedMx?: { priority: number; exchange: string };
      records?: Array<{ priority: number; exchange: string }>;
    }>('POST', `/sender-domains/${encodeURIComponent(id)}/verify-inbound`);
  }

  setupOutboundDomain(id: string) {
    return this.request<{
      success: boolean;
      ready: boolean;
      message?: string;
      error?: string;
      outboundStatus?: string;
      outboundDnsRecords?: Array<{
        type: 'CNAME' | 'MX' | 'TXT';
        host: string;
        name: string;
        value: string;
        priority?: number;
        purpose: 'dkim' | 'mail_from' | 'mail_from_spf';
        required: boolean;
      }>;
    }>('POST', `/sender-domains/${encodeURIComponent(id)}/setup-outbound`);
  }

  verifyOutboundDomain(id: string) {
    return this.request<{
      success: boolean;
      ready: boolean;
      message?: string;
      error?: string;
      outboundStatus?: string;
      dkimStatus?: string;
      outboundDnsRecords?: Array<{
        type: 'CNAME' | 'MX' | 'TXT';
        host: string;
        name: string;
        value: string;
        priority?: number;
        purpose: 'dkim' | 'mail_from' | 'mail_from_spf';
        required: boolean;
      }>;
    }>('POST', `/sender-domains/${encodeURIComponent(id)}/verify-outbound`);
  }

  // --- DNS provider token (one-step Cloudflare DNS setup) ---

  getCloudflareTokenStatus() {
    return this.request<{
      success: boolean;
      error?: string;
      status: {
        provider: 'cloudflare';
        configured: boolean;
        tokenHint: string | null;
        updatedAt: number | null;
      };
    }>('GET', '/dns-provider/cloudflare');
  }

  setCloudflareToken(apiToken: string) {
    return this.request<{
      success: boolean;
      message?: string;
      error?: string;
      status: {
        provider: 'cloudflare';
        configured: boolean;
        tokenHint: string | null;
        updatedAt: number;
      };
    }>('PUT', '/dns-provider/cloudflare', { body: { apiToken } });
  }

  removeCloudflareToken() {
    return this.request<{
      success: boolean;
      message?: string;
      error?: string;
      status: {
        provider: 'cloudflare';
        configured: boolean;
        tokenHint: string | null;
        updatedAt: number | null;
      };
    }>('DELETE', '/dns-provider/cloudflare');
  }

  applyDomainDns(id: string, input: { scope?: 'outbound' | 'inbound' | 'all'; apiToken?: string } = {}) {
    return this.request<{
      success: boolean;
      domain: string;
      zone: { id: string; name: string } | null;
      scope: 'outbound' | 'inbound' | 'all';
      message: string;
      error?: string;
      results: Array<{
        type: string;
        name: string;
        content: string;
        priority?: number;
        purpose: string;
        outcome: 'created' | 'existing' | 'conflict' | 'failed';
        error?: string;
      }>;
    }>('POST', `/sender-domains/${encodeURIComponent(id)}/apply-dns`, { body: input });
  }
}
