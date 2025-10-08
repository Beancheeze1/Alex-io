import express from "express";
import morgan from "morgan";

const app = express();
app.use(morgan("tiny"));
app.use("/hubspot/webhook", express.raw({ type: "*/*" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ===== Utilities =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

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
    recipients: toEmail
      ? [{
          recipientField: "TO",
          deliveryIdentifier: { type: "HS_EMAIL_ADDRESS", value: toEmail }
        }]
      : [],
  };
  const resp = await hubspotFetch(url, { method: "POST", body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`POST message ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json().catch(() => ({}));
}

async function getRecentMessages(threadId, limit = 15) {
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
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      console.warn("Actor fetch failed", resp.status, t);
      return null;
    }
    return await resp.json().catch(() => ({}));
  } catch (e) {
    console.warn("Actor fetch error", e.message);
    return null;
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
    // object form
    const di = s?.deliveryIdentifier;
    if (di && typeof di === "object") {
      // either singular object or array-like
      if (Array.isArray(di)) {
        for (const x of di) {
          if (x?.type === "HS_EMAIL_ADDRESS" && x?.value) return x.value;
        }
      } else {
        if (di?.type === "HS_EMAIL_ADDRESS" && di?.value) return di.value;
      }
    }
    // alternate fields seen occasionally
    if (s?.email) return s.email;
    if (s?.address) return s.address;
  }
  return null;
}

// Robust extractor from an inbound message object
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

  // 4) Last resort: fetch the actor (V-####) and scan
  const actorId = (inbound?.senders && inbound.senders[0]?.actorId) || inbound?.createdBy || null;
  if (actorId && /^V-\d+/.test(String(actorId))) {
    const actor = await getActor(actorId);
    const actorEmail = pickEmailFromObject(actor);
    if (actorEmail) return actorEmail;
  }

  return null;
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

    console.log("Events:", events.map(e => ({
      sub: e.subscriptionType, obj: e.objectId, id: e.eventId, when: e.occurredAt
    })));

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
  console.log("HANDLE", { sub, threadId, eventId, AUTO_COMMENT: process.env.AUTO_COMMENT, AUTO_REPLY: process.env.AUTO_REPLY });

  if (processedEventIds.has(eventId)) return;
  remember(processedEventIds, eventId, 5 * 60 * 1000);

  if (sub === "conversation.creation") {
    if (!threadId || commentedThreads.has(threadId)) return;
    remember(commentedThreads, threadId, 60 * 60 * 1000);
    if (process.env.AUTO_COMMENT === "true") {
      try {
        console.log("ACTION", { type: "COMMENT", threadId });
        await postThreadComment(threadId, "✅ Webhook OK — bot received the message.");
        console.log("Comment posted on thread", threadId);
      } catch (e) {
        console.error("Failed to post comment:", e);
      }
    }
    return;
  }

  if (sub !== "conversation.newmessage" || !threadId) return;
  if (process.env.AUTO_REPLY !== "true") return;

  await sleep(700); // give indexing time
  let messages = [];
  try {
    messages = await getRecentMessages(threadId, 25);
  } catch (e) {
    console.error("Failed to fetch messages:", e);
    return;
  }

  console.log("RECENTS", messages.map(m => ({
    id: m.id || m.messageId,
    t: m.type,
    d: m.direction,
    app: m.client?.integrationAppId,
    ch: m.channelId,
    acc: m.channelAccountId,
    senders: (Array.isArray(m.senders) && m.senders.map(s => s.actorId)) || []
  })));

  const inbound = findLatestInboundEmail(messages);
  if (!inbound) {
    console.log("No inbound MESSAGE found to reply to (skipping).");
    return;
  }

  console.log("INBOUND", JSON.stringify(inbound, null, 2));

  const channelId = inbound.channelId || messages.find(m => m.channelId)?.channelId;
  const channelAccountId = inbound.channelAccountId || messages.find(m => m.channelAccountId)?.channelAccountId;

  let senderActorId = process.env.SENDER_ACTOR_ID;
  if (!senderActorId) {
    senderActorId = findLatestAgentActorId(messages);
    if (senderActorId) console.log("Derived senderActorId from previous OUTGOING:", senderActorId);
  }

  const toEmail = await extractSenderEmail(inbound);
  if (!channelId || !channelAccountId || !senderActorId || !toEmail) {
    console.error("Missing required fields to send:", {
      channelId, channelAccountId, senderActorId, toEmail
    });
    try {
      await postThreadComment(threadId, "⚠️ Bot is connected but needs configuration: missing channel/account/sender or recipient email. See logs.");
    } catch {}
    return;
  }

  const ttlHours = Number(process.env.REPLY_TTL_HOURS || 12);
  if (repliedThreads.has(threadId)) return;
  remember(repliedThreads, threadId, Math.max(1, ttlHours) * 60 * 60 * 1000);

  const calendly = process.env.CALENDLY_URL || "<YOUR-CALENDLY-LINK>";
  const text = [
    `Thanks for reaching out — happy to help!`,
    `Could you share a bit more detail (volume, timeline, and any specs)?`,
    `If convenient, you can also grab a quick call: ${calendly}`,
    ``,
    `If you’d prefer not to hear from us, reply “unsubscribe.”`
  ].join("\n");
  const subject = "Re: your message";

  try {
    console.log("ACTION", { type: "MESSAGE", threadId, toEmail, senderActorId, channelId, channelAccountId });
    await sendThreadMessage(threadId, { text, subject, toEmail, senderActorId, channelId, channelAccountId });
    console.log("Auto-reply sent to thread", threadId, "to", toEmail);
  } catch (e) {
    console.error("Failed to send auto-reply:", e);
  }
}

// ===== Start server =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
