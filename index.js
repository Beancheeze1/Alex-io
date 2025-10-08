import express from "express";
import morgan from "morgan";

/**
 * HubSpot Conversations webhook server (Node + Express)
 * Improvements in this version:
 *  - Handles event ordering/race conditions by briefly waiting, then scanning
 *    the last 10 messages for the newest inbound MESSAGE from the customer.
 *  - Extra diagnostics to print message types/directions it saw.
 *  - Keeps loop guards (dedupe, TTL, ignore self/outgoing).
 *
 * Env vars (Render → Service → Environment):
 *   HUBSPOT_TOKEN=pat-xxxx
 *   AUTO_COMMENT=false|true
 *   AUTO_REPLY=false|true
 *   HUBSPOT_APP_ID=123456   # optional: helps ignore your own posts
 *   REPLY_TTL_HOURS=12
 *   PORT=3000
 */

const app = express();
app.use(morgan("tiny"));

// Capture raw body for signature verification later; parse JSON manually
app.use("/hubspot/webhook", express.raw({ type: "*/*" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ===== Utilities =====
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function sendThreadMessage(threadId, { text, subject, toEmail }) {
  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages`;
  const body = {
    type: "MESSAGE",
    text,
    subject,
    recipients: toEmail ? [{ deliveryIdentifiers: [{ type: "TO", value: toEmail }] }] : undefined,
  };
  const resp = await hubspotFetch(url, { method: "POST", body: JSON.stringify(body) });
  if (!resp.ok) throw new Error(`POST message ${resp.status}: ${await resp.text().catch(() => "")}`);
  return resp.json().catch(() => ({}));
}

async function getRecentMessages(threadId, limit = 10) {
  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages?limit=${limit}&sort=-createdAt`;
  const resp = await hubspotFetch(url, { method: "GET", headers: {} });
  if (!resp.ok) throw new Error(`GET messages ${resp.status}: ${await resp.text().catch(() => "")}`);
  const data = await resp.json().catch(() => ({}));
  const items = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
  return items;
}

function extractSenderEmail(msg) {
  return (
    msg?.from?.email ||
    msg?.origin?.from?.email ||
    msg?.message?.from?.email ||
    null
  );
}

function findLatestInboundEmail(messages) {
  const myAppId = process.env.HUBSPOT_APP_ID && String(process.env.HUBSPOT_APP_ID);
  for (const m of messages) {
    const type = (m.type || "").toUpperCase();        // "MESSAGE" or "COMMENT"
    const dir  = (m.direction || "").toUpperCase();   // "INCOMING" or "OUTGOING"
    const appId = m.client?.integrationAppId;
    if (type !== "MESSAGE") continue;                 // ignore comments/system
    if (dir === "OUTGOING") continue;                 // ignore our responses
    if (appId && myAppId && String(appId) === myAppId) continue; // ignore our own
    return m; // this is the newest inbound email from the customer
  }
  return null;
}

// ===== Webhook route =====
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

// ===== Event handler with loop guards and race handling =====
async function handleHubSpotEvent(ev) {
  const sub = (ev.subscriptionType || "").toLowerCase();
  const threadId = ev.objectId;
  const eventId = ev.eventId || `${sub}:${threadId}:${ev.occurredAt}`;
  console.log("HANDLE", { sub, threadId, eventId, AUTO_COMMENT: process.env.AUTO_COMMENT, AUTO_REPLY: process.env.AUTO_REPLY });

  // 1) De-dupe HubSpot retries (5 min TTL)
  if (processedEventIds.has(eventId)) return;
  remember(processedEventIds, eventId, 5 * 60 * 1000);

  // 2) Optional: proof comment once on creation
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

  // 3) Auto-reply only on NEW inbound messages
  if (sub !== "conversation.newmessage" || !threadId) return;
  if (process.env.AUTO_REPLY !== "true") return;

  // Race handling: tiny wait to let the inbound message persist, then fetch last 10
  await sleep(350);
  let messages = [];
  try {
    messages = await getRecentMessages(threadId, 10);
  } catch (e) {
    console.error("Failed to fetch messages:", e);
    return;
  }

  // Log what we saw (types/directions) to aid debugging
  console.log("RECENTS", messages.map(m => ({
    id: m.id || m.messageId,
    t: m.type,
    d: m.direction,
    app: m.client?.integrationAppId
  })));

  const inbound = findLatestInboundEmail(messages);
  if (!inbound) {
    console.log("No inbound MESSAGE found to reply to (skipping).");
    return;
  }

  // TTL: don't reply repeatedly to same thread
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
  const toEmail = extractSenderEmail(inbound);

  try {
    console.log("ACTION", { type: "MESSAGE", threadId, toEmail });
    await sendThreadMessage(threadId, { text, subject, toEmail });
    console.log("Auto-reply sent to thread", threadId, "to", toEmail || "(thread recipients)");
  } catch (e) {
    console.error("Failed to send auto-reply:", e);
  }
}

// ===== Start server =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
