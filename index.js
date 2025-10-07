import express from "express";
import morgan from "morgan";
// --- top of file ---
const processedEventIds = new Set();
const commentedThreads = new Set();
function remember(set, key, ms) { set.add(key); setTimeout(() => set.delete(key), ms).unref?.(); }

// Fetch latest message on a thread
async function getLatestMessage(threadId) {
  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages?limit=1&sort=-createdAt`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}` } });
  if (!resp.ok) throw new Error(`Get messages ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  const items = Array.isArray(data?.results) ? data.results : (Array.isArray(data) ? data : []);
  return items[0] || null;
}
async function handleHubSpotEvent(ev) {
  const sub = (ev.subscriptionType || "").toLowerCase();
  const eventId = ev.eventId || `${sub}:${ev.objectId}:${ev.occurredAt}`;
  const threadId = ev.objectId;

  // Deduplicate retries (5 min TTL)
  if (processedEventIds.has(eventId)) return;
  remember(processedEventIds, eventId, 5 * 60 * 1000);

  // Only act on thread creation (avoid loops on later messages)
  if (sub !== "conversation.creation") return;
  if (!threadId) return;

  // Comment once per thread (1 hour TTL)
  if (commentedThreads.has(threadId)) return;
  remember(commentedThreads, threadId, 60 * 60 * 1000);

  // Ignore our own posts (and any outgoing system content)
  try {
    const msg = await getLatestMessage(threadId);
    if (msg) {
      const type = (msg.type || "").toUpperCase();      // "MESSAGE" or "COMMENT"
      const dir  = (msg.direction || "").toUpperCase(); // "INCOMING" or "OUTGOING"
      const appId = msg.client?.integrationAppId;       // numeric app id if from an app

      if (type === "COMMENT" || dir === "OUTGOING" || (appId && String(appId) === process.env.HUBSPOT_APP_ID)) {
        return; // do nothing if latest was ours/outgoing
      }
    }
  } catch (e) {
    console.warn("Latest-message check failed:", e.message);
  }

  // Post ONE comment (proof step only)
  if (process.env.AUTO_COMMENT === "true" && process.env.HUBSPOT_TOKEN) {
    await postThreadComment(threadId, "✅ Webhook OK — bot received the message.");
  }
}


  } catch (e) {
    console.warn("Latest-message check failed (continuing cautiously):", e.message);
  }

  // 5) Finally, post ONE comment (if you still want this proof behavior)
  if (process.env.AUTO_COMMENT === "true" && process.env.HUBSPOT_TOKEN) {
    await postThreadComment(threadId, "✅ Webhook OK — bot received the message.");
  }
}

const app = express();
app.use(morgan("tiny"));

// For the webhook route, capture raw body so we can do signature verification later.
app.use("/hubspot/webhook", express.raw({ type: "*/*" }));

app.get("/healthz", (req, res) => res.status(200).send("ok"));

app.post("/hubspot/webhook", async (req, res) => {
  try {
    const bodyText = req.body?.toString("utf8") || "";
    const signature = req.header("X-HubSpot-Signature") || req.header("X-HubSpot-Signature-v3") || "";

    // TODO: if (process.env.VERIFY_SIGNATURE === "true") validate signature using HUBSPOT_APP_SECRET.

    // Always ACK quickly
    res.sendStatus(200);

    let events = [];
    try {
      const parsed = JSON.parse(bodyText || "[]");
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      console.error("JSON parse error:", e);
      return;
    }

    console.log("Webhook events:", JSON.stringify(events, null, 2));

    // Optional: drop a COMMENT to prove write access
    const shouldComment = process.env.AUTO_COMMENT === "true" && process.env.HUBSPOT_TOKEN;

    if (shouldComment) {
      for (const ev of events) {
        const sub = (ev.subscriptionType || "").toLowerCase();
        if (sub.includes("conversation")) {
          const threadId = ev.objectId;
          if (threadId) {
            try {
              await postThreadComment(threadId, "✅ Webhook OK — bot received the message.");
              console.log("Comment posted on thread", threadId);
            } catch (err) {
              console.error("Failed to post comment:", err);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("Webhook handler error:", err);
  }
});

async function postThreadComment(threadId, text) {
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) throw new Error("HUBSPOT_TOKEN not set");

  const url = `https://api.hubapi.com/conversations/v3/conversations/threads/${threadId}/messages`;
  const body = { type: "COMMENT", text };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`HubSpot API error ${resp.status}: ${txt}`);
  }
  return await resp.json().catch(() => ({}));
}

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Listening on", port));
