import express from "express";
import morgan from "morgan";

/**
 * Loop-proof HubSpot Conversations webhook handler.
 * - ACKs fast (200)
 * - De-dupes retries by eventId (5 min TTL)
 * - Comments ONLY on conversation.creation (proof step)
 * - Posts at most ONE comment per thread (1 hour TTL)
 * - Ignores own/outgoing messages (COMMENT/OUTGOING/integrationAppId == HUBSPOT_APP_ID)
 *
 * Env vars (Render → Service → Environment):
 *   HUBSPOT_TOKEN=pat-xxxx            # Private App token (required to write back)
 *   AUTO_COMMENT=true|false           # true only while proving write access
 *   HUBSPOT_APP_ID=123456             # (optional) your app's numeric id to ignore self
 *   VERIFY_SIGNATURE=false            # (later) enforce X-HubSpot-Signature v3
 *   HUBSPOT_APP_SECRET=...            # used when VERIFY_SIGNATURE=true
 *   PORT=3000
 */

const app = express();
app.use(morgan("tiny"));

// Capture raw body for signature verification; we'll parse JSON manually.
app.use("/hubspot/webhook", express.raw({ type: "*/*" }));

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// ===== Loop-prevention state (in-memory with TTL) =====
const processedEventIds = new Set();
const commentedThreads = new Set();

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
  // Data can be {results:[...] } or an array on some responses
  const items = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
  return items[0] || null;
}

// ===== Main webhook route =====
app.post("/hubspot/webhook", async (req, res) => {
  try {
    // TODO: add X-HubSpot-Signature v3 verification when VERIFY_SIGNATURE === "true"
    // We ACK immediately to avoid retries/timeouts.
    res.sendStatus(200);

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
    // We already ACKed 200 above.
  }
});

// ===== Event handler with loop guards =====
async function handleHubSpotEvent(ev) {
  const sub = (ev.subscriptionType || "").toLowerCase(); // e.g., conversation.creation
  const threadId = ev.objectId;
  const eventId = ev.eventId || `${sub}:${threadId}:${ev.occurredAt}`;

  // 1) De-dupe HubSpot retries for 5 minutes
  if (processedEventIds.has(eventId)) return;
  remember(processedEventIds, eventId, 5 * 60 * 1000);

  // 2) Only act on thread creation (avoid loops on later messages)
  if (sub !== "conversation.creation") return;
  if (!threadId) return;

  // 3) At most one comment per thread for the next hour
  if (commentedThreads.has(threadId)) return;
  remember(commentedThreads, threadId, 60 * 60 * 1000);

  // 4) Ignore our own/outgoing content
  try {
    const latest = await getLatestMessage(threadId);
    if (latest) {
      const type = (latest.type || "").toUpperCase();        // "MESSAGE" or "COMMENT"
      const direction = (latest.direction || "").toUpperCase(); // "INCOMING" or "OUTGOING"
      const appId = latest.client?.integrationAppId;         // numeric ID when posted by an app
      const myAppId = process.env.HUBSPOT_APP_ID && String(process.env.HUBSPOT_APP_ID);

      // Bail if the newest item is a COMMENT, an OUTGOING item, or from our own app
      if (type === "COMMENT" || direction === "OUTGOING" || (appId && myAppId && String(appId) === myAppId)) {
        return;
      }
    }
  } catch (e) {
    console.warn("Latest-message check failed (continuing cautiously):", e.message);
  }

  // 5) Post a single proof comment (optional)
  if (process.env.AUTO_COMMENT === "true" && process.env.HUBSPOT_TOKEN) {
    try {
      await postThreadComment(threadId, "✅ Webhook OK — bot received the message.");
      console.log("Comment posted on thread", threadId);
    } catch (e) {
      console.error("Failed to post comment:", e);
    }
  }
}

// ===== Start server =====
const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
