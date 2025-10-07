import express from "express";
import morgan from "morgan";

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
