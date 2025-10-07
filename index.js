import express from "express";
import morgan from "morgan";

/**
 * HubSpot Conversations webhook server (Node + Express)
 * Features:
 *  - ACKs fast (200) to avoid timeouts
 *  - De-dupes retries by eventId (5 min TTL)
 *  - Optional proof COMMENT once on conversation.creation (AUTO_COMMENT)
 *  - Real MESSAGE reply once per thread on inbound conversation.newMessage (AUTO_REPLY)
 *  - Ignores own/outgoing content using latest message check
 *
 * Env vars (Render → Service → Environment):
 *   HUBSPOT_TOKEN=pat-xxxx            # Private App token (required to write back)
 *   AUTO_COMMENT=false|true           # proof step only; default false
 *   AUTO_REPLY=false|true             # set true to send real replies
 *   HUBSPOT_APP_ID=123456             # (optional) your app's numeric id to ignore self
 *   REPLY_TTL_HOURS=12                # don't auto-reply to same thread again within N hours
 *   VERIFY_SIGNATURE=false            # (later) enforce X-HubSpot-Signature v3
 *   HUBSPOT_APP_SECRET=...            # used when VERIFY_SIGNATURE=true
 *   CALENDLY_URL=https://calendly.com/yourlink   # optional for CTA
 *   PORT=3000
 */

const app = express();
app.use(morgan("tiny"));

// Capture raw body for signature verification later; parse JSON manually
app.use("/hubspot/webhook", express.raw({ type: "*/*" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ===== In-memory state with TTL =====
const processedEventIds = new Set(); // for deduping retries
const commentedThreads = new Set();  // proof-comment once per thread
const repliedThreads = new Set();    // avoid multiple auto-replies per thread

function remember(set, key, ms) {
  set.add(key);
  const t = setTimeout(() => set.delete(key), ms);
  if (typeof t.unref === "function") t.unref();
}

// ===== HubSpot API helpers =====
async function postThreadComment(threadId, text) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not set");

  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages`;
  const body = { type: "COMMENT", text };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HubSpot POST comment ${resp.status}: ${txt}`);
  }
  return resp.json().catch(() => ({}));
}

async function sendThreadMessage(threadId, { text, subject, toEmail }) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not set");

  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages`;
  const body = {
    type: "MESSAGE",
    text,
    subject,
    recipients: toEmail
      ? [{ deliveryIdentifiers: [{ type: "TO", value: toEmail }] }]
      : undefined,
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HubSpot POST message ${resp.status}: ${txt}`);
  }
  return resp.json().catch(() => ({}));
}

async function getLatestMessage(threadId) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not set");

  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages?limit=1&sort=-createdAt`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`HubSpot GET messages ${resp.status}: ${txt}`);
  }

  const data = await resp.json().catch(() => ({}));
  const items = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
  return items[0] || null;
}

function extractSenderEmail(msg) {
  return (
    msg?.from?.email ||
    msg?.origin?.from?.email ||
    msg?.message?.from?.email ||
    null
  );
}

// ===== Webhook route =====
app.post("/hubspot/webhook", async (req, res) => {
  try {
    // TODO: add X-HubSpot-Signature v3 verification when VERIFY_SIGNATURE === "true"
    res.sendStatus(200); // ACK fast

    const bodyText = req.body?.toString("utf8") || "[]";
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

// ===== Event handler with loop guards =====
async function handleHubSpotEvent(ev) {
  const sub = (ev.subscriptionType || "").toLowerCase();
  const threadId = ev.objectId;
  const eventId = ev.eventId || `${sub}:${threadId}:${ev.occurredAt}`;

  // 1) De-dupe HubSpot retries for 5 minutes
  if (processedEventIds.has(eventId)) return;
  remember(processedEventIds, eventId, 5 * 60 * 1000);

  // 2) Optional: proof comment on thread creation (once)
  if (sub === "conversation.creation") {
    if (!threadId || commentedThreads.has(threadId)) return;
    remember(commentedThreads, threadId, 60 * 60 * 1000);

    const latest = await getLatestMessage(threadId).catch(() => null);
    const type = (latest?.type || "").toUpperCase();
    const dir  = (latest?.direction || "").toUpperCase();
    const appId = latest?.client?.integrationAppId;
    const myAppId = process.env.HUBSPOT_APP_ID && String(process.env.HUBSPOT_APP_ID);
    if (type === "COMMENT" || dir === "OUTGOING" || (appId && myAppId && String(appId) === myAppId)) return;

    if (process.env.AUTO_COMMENT === "true") {
      try {
        await postThreadComment(threadId, "✅ Webhook OK — bot received the message.");
        console.log("Comment posted on thread", threadId);
      } catch (e) {
        console.error("Failed to post comment:", e);
      }
    }
    return;
  }

  // 3) Real replies only on NEW inbound messages
  if (sub !== "conversation.newMessage" || !threadId) return;

  const latest = await getLatestMessage(threadId).catch(() => null);
  if (!latest) return;

  const type = (latest.type || "").toUpperCase();      // "MESSAGE" or "COMMENT"
  const dir  = (latest.direction || "").toUpperCase(); // "INCOMING" or "OUTGOING"
  const appId = latest.client?.integrationAppId;
  const myAppId = process.env.HUBSPOT_APP_ID && String(process.env.HUBSPOT_APP_ID);

  // Ignore anything that isn't a customer's inbound email
  if (type !== "MESSAGE" || dir !== "INCOMING") return;
  if (appId && myAppId && String(appId) === myAppId) return; // ignore our own posts

  // Respect TTL (don't auto-reply to same thread repeatedly)
  const ttlHours = Number(process.env.REPLY_TTL_HOURS || 12);
  if (repliedThreads.has(threadId)) return;
  remember(repliedThreads, threadId, Math.max(1, ttlHours) * 60 * 60 * 1000);

  // Only auto-reply when explicitly enabled
  if (process.env.AUTO_REPLY !== "true") return;

  // TODO: Replace with classifier + KB retrieval
  const calendly = process.env.CALENDLY_URL || "<YOUR-CALENDLY-LINK>";
  const text = [
    `Thanks for reaching out — happy to help!`,
    `Could you share a bit more detail (volume, timeline, and any specs)?`,
    `If convenient, you can also grab a quick call: ${calendly}`,
    ``,
    `If you’d prefer not to hear from us, reply “unsubscribe.”`
  ].join("\n");
  const subject = "Re: your message";

  const toEmail = extractSenderEmail(latest);
  try {
    await sendThreadMessage(threadId, { text, subject, toEmail });
    console.log("Auto-reply sent to thread", threadId, "to", toEmail || "(thread recipients)");
  } catch (e) {
    console.error("Failed to send auto-reply:", e);
  }
}

// ===== Start server =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
