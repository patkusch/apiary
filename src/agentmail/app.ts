import { Webhook } from "svix";

let initialized = false;
let webhookSecret: string | null = null;

export function isAgentMailEnabled(): boolean {
  const disabled = process.env.AGENTMAIL_DISABLE;
  if (disabled === "true" || disabled === "1") {
    return false;
  }

  return !!process.env.AGENTMAIL_WEBHOOK_SECRET;
}

export function resetAgentMail(): void {
  initialized = false;
  webhookSecret = null;
}

export function initAgentMail(): boolean {
  if (initialized) {
    console.log("[AgentMail] Already initialized, skipping");
    return isAgentMailEnabled();
  }
  initialized = true;

  const disabled = process.env.AGENTMAIL_DISABLE;
  if (disabled === "true" || disabled === "1") {
    console.log("[AgentMail] Disabled via AGENTMAIL_DISABLE");
    return false;
  }

  webhookSecret = process.env.AGENTMAIL_WEBHOOK_SECRET ?? null;

  if (!webhookSecret) {
    console.log("[AgentMail] Missing AGENTMAIL_WEBHOOK_SECRET, AgentMail integration disabled");
    return false;
  }

  console.log("[AgentMail] Webhook handler initialized");
  return true;
}

/**
 * Verify AgentMail webhook signature using Svix
 * Returns the verified payload on success, null on failure
 */
export function verifyAgentMailWebhook(
  rawBody: string,
  headers: Record<string, string>,
): unknown | null {
  if (!webhookSecret) {
    console.log("[AgentMail] Signature verification failed: no webhook secret configured");
    return null;
  }

  try {
    const wh = new Webhook(webhookSecret);
    // svix 2.x's verify() only checks the signature and returns undefined on
    // success — v1.x also parsed and returned the payload. Parsing is now the
    // caller's job; do it here so this function's own contract ("returns the
    // verified payload") stays true instead of quietly starting to return
    // undefined, which the HTTP handler's `if (!verified)` would then reject
    // as an invalid signature even though it verified correctly.
    wh.verify(rawBody, headers);
    return JSON.parse(rawBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(`[AgentMail] Signature verification failed: ${message}`);
    return null;
  }
}
