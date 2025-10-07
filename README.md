# HubSpot Conversations Webhook — Node + Express (Render + GoDaddy)

This minimal server receives HubSpot webhooks at `/hubspot/webhook` and can post a **COMMENT** to the same thread to prove write access.

## Local run
```bash
npm install
cp config.example.env .env
npm start
```

Test locally:
```bash
curl -X POST http://localhost:3000/hubspot/webhook \
  -H "Content-Type: application/json" \
  -d '[{"subscriptionType":"conversation.newMessage","objectId":"12345"}]'
```

## Deploy on Render
1) Push this repo to GitHub  
2) Render → New → Web Service → pick your repo  
3) Build: `npm install`  
   Start: `npm start`  
4) Add Env Vars:
   - HUBSPOT_TOKEN=pat-xxxx
   - AUTO_COMMENT=true
   - VERIFY_SIGNATURE=false
   - HUBSPOT_APP_SECRET=... (for later)
5) Deploy; note your URL like `https://yourapp.onrender.com`

## Add custom domain on Render
- Render → Service → Settings → Custom Domains → `api.yourdomain.com`
- Render shows a **CNAME** target like `yourapp.onrender.com`

## GoDaddy DNS
- Add **CNAME**:
  - Name/Host: `api`
  - Value: `yourapp.onrender.com`
- Wait a few minutes; Render verifies and provisions HTTPS

Your endpoint becomes: `https://api.yourdomain.com/hubspot/webhook`

## HubSpot Webhooks
- HubSpot → Settings → Integrations → Private apps → Webhooks  
- Subscriptions:
  - conversation.creation
  - conversation.newMessage
- Target URL: `https://api.yourdomain.com/hubspot/webhook`

## Next steps
- Implement signature v3 verification (set VERIFY_SIGNATURE=true)
- Fetch full message text, classify, draft, and post a `MESSAGE` reply
