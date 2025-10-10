import express from "express";
import morgan from "morgan";

const app = express();
app.use(morgan("tiny"));
app.use("/hubspot/webhook", express.raw({ type: "*/*" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ===== Utilities =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const nowIso = () => new Date().toISOString();

// ===== In-memory state with TTL =====
const processedEventIds = new Set();
const commentedThreads = new Set();
const repliedThreads = new Set();
function remember(set, key, ms) {
  set.add(key);
  const t = setTimeout(() => set.delete(key), ms);
  if (typeof t.unref === "function") t.unref();
}

// ===== HubSpot API helpers =====
async function hubspotFetch(url, init) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not set");
  const resp = await fetch(url, {
    ...(init || {}),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  return resp;
}

async function postThreadComment(threadId, text) {
  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages`;
  const resp = await hubspotFetch(url, { method: "POST", body: JSON.stringify({ type: "COMMENT", text }) });
  if (!resp.ok) throw new Error(`POST comment ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json().catch(() => ({}));
}

async function sendThreadMessage(threadId, { text, subject, toEmail, senderActorId, channelId, channelAccountId }) {
  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages`;
  const body = {
    type: "MESSAGE",
    text,
    subject,
    senderActorId,
    channelId,
    channelAccountId,
    recipients: [{
      recipientField: "TO",
      deliveryIdentifier:  { type: "HS_EMAIL_ADDRESS", value: toEmail },
      deliveryIdentifiers: [{ type: "HS_EMAIL_ADDRESS", value: toEmail }]
    }],
  };
  const resp = await hubspotFetch(url, { method: "POST", body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`POST message ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json().catch(() => ({}));
}

async function getRecentMessages(threadId, limit = 20) {
  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages?limit=${limit}&sort=-createdAt`;
  const resp = await hubspotFetch(url, { method: "GET", headers: {} });
  if (!resp.ok) throw new Error(`GET messages ${resp.status}: ${await resp.text().catch(() => "")}`);
  const data = await resp.json().catch(() => ({}));
  const items = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
  return items;
}

async function getActor(actorId) {
  if (!actorId) return null;
  try {
    const url = `https://api.hubapi.com/conversations/v3/conversations/actors/${actorId}`;
    const resp = await hubspotFetch(url, { method: "GET", headers: {} });
    if (!resp.ok) return null;
    return await resp.json().catch(() => ({}));
  } catch {
    return null;
  }
}

// ===== CRM helpers (contact tagging) =====
async function findContactByEmail(email) {
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/contacts/search`;
    const body = {
      filterGroups: [{
        filters: [{ propertyName: "email", operator: "EQ", value: email }]
      }],
      properties: ["email"]
    };
    const resp = await hubspotFetch(url, { method: "POST", body: JSON.stringify(body) });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn("Search contact failed", resp.status, t);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    const first = data?.results?.[0];
    return first?.id || null;
  } catch (e) {
    console.warn("Search contact error", e?.message || e);
    return null;
  }
}

async function createContact(email, props = {}) {
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/contacts`;
    const body = { properties: { email, ...props } };
    const resp = await hubspotFetch(url, { method: "POST", body: JSON.stringify(body) });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn("Create contact failed", resp.status, t);
      return null;
    }
    const data = await resp.json().catch(() => ({}));
    return data?.id || null;
  } catch (e) {
    console.warn("Create contact error", e?.message || e);
    return null;
  }
}

async function updateContact(contactId, props) {
  try {
    const url = `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`;
    const body = { properties: props };
    const resp = await hubspotFetch(url, { method: "PATCH", body: JSON.stringify(body) });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn("Update contact failed", resp.status, t);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("Update contact error", e?.message || e);
    return false;
  }
}

async function tagIntentOnContact(email, intent) {
  if (!email || !EMAIL_RE.test(email)) return;
  const propName = process.env.INTENT_PROPERTY || "bot_intent";
  const timeProp = process.env.INTENT_TIME_PROPERTY || "bot_last_reply_at";
  // 1) find or create contact
  let id = await findContactByEmail(email);
  if (!id) {
    id = await createContact(email);
    if (!id) return;
  }
  // 2) update properties
  const ok = await updateContact(id, { [propName]: String(intent), [timeProp]: nowIso() });
  if (!ok) {
    // leave a breadcrumb comment if property is missing schema
    console.warn(`Tagging failed — ensure contact properties "${propName}" (text) and "${timeProp}" (datetime) exist.`);
  }
}

// ===== Email extraction helpers =====
function pickEmailFromObject(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && EMAIL_RE.test(v)) return (v.match(EMAIL_RE) || [null])[0];
    if (v && typeof v === "object") {
      const nested = pickEmailFromObject(v);
      if (nested) return nested;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        const nested = pickEmailFromObject(item);
        if (nested) return nested;
      }
    }
  }
  return null;
}

function extractEmailFromSendersArray(senders) {
  if (!Array.isArray(senders)) return null;
  for (const s of senders) {
    const di = s?.deliveryIdentifier;
    if (di) {
      if (Array.isArray(di)) {
        for (const x of di) {
          if (x?.type === "HS_EMAIL_ADDRESS" && x?.value) return x.value;
        }
      } else {
        if (di?.type === "HS_EMAIL_ADDRESS" && di?.value) return di.value;
      }
    }
    if (s?.email) return s.email;
    if (s?.address) return s.address;
  }
  return null;
}

async function extractSenderEmail(inbound) {
  // 1) Preferred: senders[].deliveryIdentifier.value
  const fromSenders = extractEmailFromSendersArray(inbound?.senders);
  if (fromSenders) return fromSenders;

  // 2) Common alternates
  if (inbound?.from?.email) return inbound.from.email;
  if (inbound?.origin?.from?.email) return inbound.origin.from.email;
  if (inbound?.message?.from?.email) return inbound.message.from.email;
  if (inbound?.replyTo?.email) return inbound.replyTo.email;

  // 3) Headers or nested blobs that include the address
  const headerGuess = pickEmailFromObject(inbound?.headers) || pickEmailFromObject(inbound?.emailHeaders);
  if (headerGuess) return headerGuess;

  // 4) Last resort: fetch the actor (V-####) and scan for any email-like string
  const actorId = (inbound?.senders && inbound.senders[0]?.actorId) || inbound?.createdBy || null;
  if (actorId && /^V-\d+/.test(String(actorId))) {
    const actor = await getActor(actorId);
    const actorEmail = pickEmailFromObject(actor);
    if (actorEmail) return actorEmail;
  }

  return null;
}

// ===== Bounce/NDR guard =====
const isBounce = (m) => {
  const s = (m.subject || "").toLowerCase();
  const n = (m.senders?.[0]?.name || "").toLowerCase();
  return s.startsWith("undeliverable") ||
         s.includes("delivery status notification") ||
         n.includes("mail delivery subsystem") ||
         n.includes("microsoft outlook");
};

// ===== Simple intent templates =====
const TEMPLATES = {
  pricing: (calendly) => [
    "Thanks for reaching out! Here’s a quick overview of pricing:",
    "• Starter: from $299/mo",
    "• Growth: from $799/mo (includes HubSpot integration + rules)",
    "• Scale: custom (SLA + advanced routing)",
    "",
    `Happy to tailor it — book a quick call: ${calendly}`,
    "",
    "If you’d prefer not to hear from us, reply “unsubscribe.”"
  ].join("\n"),

  demo: (calendly) => [
    "Awesome — we’d love to show you a demo.",
    `Grab a time here: ${calendly}`,
    "",
    "If you share your use case (inbox volume, team size, goals), we’ll tailor the walkthrough."
  ].join("\n"),

  support: () => [
    "Thanks for reaching out to support!",
    "Could you share the steps to reproduce, any error messages, and a screenshot?",
    "We’ll take a look and get you unblocked."
  ].join("\n"),

  fallback: (calendly) => [
    "Thanks for reaching out — happy to help!",
    "Could you share a bit more detail (volume, timeline, and any specs)?",
    `If convenient, you can also grab a quick call: ${calendly}`,
    "",
    "If you’d prefer not to hear from us, reply “unsubscribe.”"
  ].join("\n"),
};

const KEYWORDS = {
  pricing: ["price", "pricing", "cost", "quote", "rate", "rates"],
  demo: ["demo", "walkthrough", "trial", "show", "meeting", "call", "book"],
  support: ["error", "bug", "issue", "broken", "doesn't work", "help", "support"],
  unsubscribe: ["unsubscribe", "opt out", "stop emailing", "remove me"]
};

function detectIntent(inbound) {
  const txt = `${(inbound.subject||"")} ${inbound.text||""}`.toLowerCase();
  for (const k of KEYWORDS.unsubscribe) if (txt.includes(k)) return "unsubscribe";
  for (const k of KEYWORDS.pricing) if (txt.includes(k)) return "pricing";
  for (const k of KEYWORDS.demo) if (txt.includes(k)) return "demo";
  for (const k of KEYWORDS.support) if (txt.includes(k)) return "support";
  return "fallback";
}

function makeReply(inbound, calendly) {
  const intent = detectIntent(inbound);
  if (intent === "unsubscribe") {
    return {
      subject: `Re: ${inbound.subject || "your message"}`,
      text: [
        "You’re unsubscribed from our emails. We won’t reach out again.",
        "If this was a mistake, reply with “resubscribe.”"
      ].join("\n"),
      intent
    };
  }
  const builder = TEMPLATES[intent] || TEMPLATES.fallback;
  return {
    subject: `Re: ${inbound.subject || "your message"}`,
    text: builder(calendly),
    intent
  };
}

function findLatestInboundEmail(messages) {
  const myAppId = process.env.HUBSPOT_APP_ID && String(process.env.HUBSPOT_APP_ID);
  for (const m of messages) {
    const type = (m.type || "").toUpperCase();
    const dir  = (m.direction || "").toUpperCase();
    const appId = m.client?.integrationAppId;
    if (type !== "MESSAGE") continue;
    if (dir === "OUTGOING") continue;
    if (appId && myAppId && String(appId) === myAppId) continue;
    return m;
  }
  return null;
}

function findLatestAgentActorId(messages) {
  for (const m of messages) {
    const type = (m.type || "").toUpperCase();
    const dir  = (m.direction || "").toUpperCase();
    if (type === "MESSAGE" && dir === "OUTGOING" && Array.isArray(m.senders) && m.senders[0]?.actorId) {
      const a = m.senders[0].actorId;
      if (typeof a === "string" && a.startsWith("A-")) return a;
    }
  }
  return null;
}

app.post("/hubspot/webhook", async (req, res) => {
  try {
    const bodyText = req.body?.toString("utf8") || "[]";
    res.sendStatus(200); // ACK fast

    let events = [];
    try {
      const parsed = JSON.parse(bodyText);
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error("JSON parse error:", e);
      return;
    }

    for (const ev of events) {
      await handleHubSpotEvent(ev);
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

async function handleHubSpotEvent(ev) {
  const sub = (ev.subscriptionType || "").toLowerCase();
  const threadId = ev.objectId;
  const eventId = ev.eventId || `${sub}:${threadId}:${ev.occurredAt}`;

  // Minimal, helpful logs
  console.log("HANDLE", { sub, threadId });

  if (processedEventIds.has(eventId)) return;
  remember(processedEventIds, eventId, 5 * 60 * 1000);

  if (sub === "conversation.creation") {
    if (!threadId || commentedThreads.has(threadId)) return;
    remember(commentedThreads, threadId, 60 * 60 * 1000);
    if (process.env.AUTO_COMMENT === "true") {
      try {
        await postThreadComment(threadId, "✅ Webhook OK — bot received the message.");
      } catch {}
    }
    return;
  }

  if (sub !== "conversation.newmessage" || !threadId) return;

  // Optional review mode: only draft comments
  const REVIEW_MODE = (process.env.REPLY_MODE || "auto").toLowerCase() === "review";

  await sleep(700);
  let messages = [];
  try {
    messages = await getRecentMessages(threadId, 20);
  } catch {
    return;
  }

  const inbound = findLatestInboundEmail(messages);
  if (!inbound) return;

  // Skip NDR/bounce
  if (isBounce(inbound)) return;

  const channelId = inbound.channelId || messages.find(m => m.channelId)?.channelId;
  const channelAccountId = inbound.channelAccountId || messages.find(m => m.channelAccountId)?.channelAccountId;

  let senderActorId = process.env.SENDER_ACTOR_ID;
  if (!senderActorId) senderActorId = findLatestAgentActorId(messages);

  const toEmail = await extractSenderEmail(inbound);
  const calendly = process.env.CALENDLY_URL || "<YOUR-CALENDLY-LINK>";
  const reply = makeReply(inbound, calendly);

  // Tag the contact with intent (even in review mode)
  if (toEmail && reply.intent !== "unsubscribe") {
    tagIntentOnContact(toEmail, reply.intent).catch(() => {});
  }

  const ttlHours = Number(process.env.REPLY_TTL_HOURS || 12);
  if (repliedThreads.has(threadId)) return;

  if (reply.intent === "unsubscribe") {
    try {
      await postThreadComment(threadId, "🛑 Contact asked to unsubscribe. Bot did not reply.");
    } catch {}
    return;
  }

  if (REVIEW_MODE) {
    try {
      await postThreadComment(threadId, `📝 Bot draft (${reply.intent}):\n\nSubject: ${reply.subject}\n\n${reply.text}`);
      remember(repliedThreads, threadId, Math.max(1, ttlHours) * 60 * 60 * 1000);
    } catch (e) {
      console.error("Failed to post draft comment:", e?.message || e);
    }
    return;
  }

  if (process.env.AUTO_REPLY === "true") {
    if (!channelId || !channelAccountId || !senderActorId || !toEmail) return;
    try {
      const resp = await sendThreadMessage(threadId, {
        text: reply.text,
        subject: reply.subject,
        toEmail,
        senderActorId,
        channelId,
        channelAccountId
      });
      console.log("ACTION", { type: "MESSAGE", threadId, intent: reply.intent });
      if (resp?.status?.statusType) console.log("STATUS", resp.status.statusType);
      remember(repliedThreads, threadId, Math.max(1, ttlHours) * 60 * 60 * 1000);
    } catch (e) {
      console.error("Failed to send auto-reply:", e?.message || e);
    }
  }
}

// ===== Start server =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
