# 🤖 Agente Lia — WhatsApp AI Agent

> Production conversational AI agent for **Leapmotor Santo André** (Grupo Toriba) — an electric vehicle dealership in São Paulo, Brazil.

[![Status](https://img.shields.io/badge/status-production-brightgreen?style=flat)]()
[![Stack](https://img.shields.io/badge/stack-n8n%20·%20GPT--4o%20·%20Pinecone%20·%20Redis-0A0A0F?style=flat)]()
[![Channel](https://img.shields.io/badge/channel-WhatsApp%20Business%20API-25D366?style=flat&logo=whatsapp&logoColor=white)]()

---

## 📌 Overview

Agente Lia is a fully automated WhatsApp AI agent that handles the entire top-of-funnel sales process for an EV dealership — from first contact to CRM handoff — without any human intervention.

**The business problem it solves:**
- Each converted lead represents ~R$200,000 in vehicle revenue
- Manual follow-up averaged several hours per lead response
- Sales team was spending most of their time on repetitive qualification tasks

**What Lia does:**
- Responds to inbound leads in under 30 seconds, 24/7
- Answers natural language questions about vehicles using RAG over the full product catalog
- Qualifies leads, captures intent, and hands off to the CRM automatically
- Initiates proactive outreach to new leads via interactive WhatsApp messages
- Escalates to a human sales agent when needed

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        INBOUND FLOW                         │
│                                                             │
│  Lead sends WhatsApp message                                │
│          │                                                  │
│          ▼                                                  │
│   Whapi Webhook  ──────────────────►  n8n Cloud            │
│                                         │                  │
│                              ┌──────────┼──────────┐       │
│                              │          │          │       │
│                              ▼          ▼          ▼       │
│                           Redis      Pinecone   OpenAI     │
│                          (memory)    (RAG)      (GPT-4o)   │
│                              │          │          │       │
│                              └──────────┼──────────┘       │
│                                         │                  │
│                              ┌──────────┼──────────┐       │
│                              │                     │       │
│                              ▼                     ▼       │
│                         Whapi API             Syonet CRM   │
│                     (send response)         (lead handoff) │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                       PROACTIVE FLOW                        │
│                                                             │
│  New lead enters Syonet                                     │
│          │                                                  │
│          ▼                                                  │
│   n8n Manual/Webhook Trigger                                │
│          │                                                  │
│          ▼                                                  │
│   Redis SET (session init)                                  │
│          │                                                  │
│          ▼                                                  │
│   Whapi Interactive Message                                 │
│   (buttons: "Yes, tell me more" / "No, thanks")            │
└─────────────────────────────────────────────────────────────┘
```

---

## 🛠️ Tech Stack

| Layer | Technology | Purpose |
|---|---|---|
| Orchestration | **n8n Cloud** | Workflow engine, webhook handling, conditional routing |
| LLM | **OpenAI GPT-4o** | Natural language understanding and response generation |
| WhatsApp | **Whapi.cloud** | WhatsApp Business API gateway (send/receive messages) |
| Memory | **Upstash Redis** | Session memory — multi-turn conversation history |
| Vector Search | **Pinecone** | RAG over vehicle catalog PDFs |
| Chatbot UI | **Typebot** | Structured qualification flows (future expansion) |
| CRM | **Syonet** | Lead registration and commercial team handoff |

---

## 🔄 n8n Workflow Structure

### Receptive Flow (handles incoming messages)

```
Webhook
  └─► If: not a group chat?
        └─► If: has text or button reply?
              ├─► If: button = "btn_sim"?
              │     └─► Send Typebot link
              ├─► If: button = "btn_nao"?
              │     └─► Close conversation gracefully
              └─► AI Agent Fallback
                    ├─► Redis GET (fetch session history)
                    ├─► Pinecone Query (RAG context)
                    ├─► GPT-4o (generate response)
                    ├─► Redis SET (update session)
                    └─► Whapi (send response)
```

### Proactive Flow (initiates outreach)

```
Manual Trigger (lead data: name, phone, model, type, salesperson)
  └─► Redis SET (initialize session)
        └─► Whapi Interactive Message (buttons)
```

---

## 📦 Key Implementation Details

### Whapi Payload Structure

```json
// Incoming message fields
{
  "messages[0].from": "+5511999999999",
  "messages[0].from_name": "Lead Name",
  "messages[0].text.body": "typed message",
  "messages[0].reply.buttons_reply.id": "btn_sim",
  "messages[0].chat_id": "5511999999999@s.whatsapp.net"
}

// Outgoing text message
{
  "to": "+5511999999999",
  "body": "Lia's response here"
}
```

### Redis Session Structure

```json
// Key: phone number (from field)
// TTL: 30 minutes
[
  { "role": "user", "content": "Quero saber sobre o C10" },
  { "role": "assistant", "content": "O Leapmotor C10 é um SUV elétrico..." }
]
```

### RAG Pipeline

```
Vehicle catalog PDFs
        │
        ▼
  Text extraction + chunking (512 tokens, 50 overlap)
        │
        ▼
  OpenAI text-embedding-3-small
        │
        ▼
  Pinecone index (upsert)
        │
        ▼
  At query time: embed user message → top_k=3 chunks → inject into GPT-4o system prompt
```

### Group Chat Filter

```javascript
// Ignore all group messages
if ($json.messages[0].chat_id.includes("@g.us")) {
  // stop execution
}
```

---

## 🧠 System Prompt Design

Lia's prompt is engineered for:
- **Brevity** — 2-3 sentences max per response (WhatsApp UX)
- **Brand voice** — friendly, knowledgeable, non-pushy
- **Graceful fallback** — redirects off-topic messages back to qualification
- **Language** — Brazilian Portuguese, informal register

---

## ⚠️ Known Gotchas

| Issue | Solution |
|---|---|
| n8n JSON Body ignores `={{ }}` expressions | Use Raw Body + `JSON.stringify()` |
| Whapi uses `to` + `body` fields | Not `phone` + `message` like Z-API |
| Button titles with emojis/accents render as arrows | Use plain ASCII for button labels |
| n8n Pinned Data uses stale data in executions | Always click Unpin before live testing |
| WhatsApp group messages trigger webhook | Filter by `@g.us` in chat_id |

---

## 📈 Results

| Metric | Before | After |
|---|---|---|
| First response time | 2–6 hours | < 30 seconds |
| Coverage | Business hours only | 24/7 |
| Leads handled per day | Limited by headcount | Unlimited |
| Sales team time on qualification | High | Near zero |

---

## 🗂️ Repository Structure

```
agente-lia/
├── workflows/
│   ├── lia_receptive_flow.json     # n8n workflow — handles incoming messages
│   └── lia_proactive_flow.json     # n8n workflow — initiates outreach
├── prompts/
│   └── lia_system_prompt.md        # Lia's system prompt (PT-BR)
├── docs/
│   ├── architecture.md             # Detailed architecture notes
│   └── whapi_payload_reference.md  # Whapi field reference
└── README.md
```

---

## 🏢 About ClaunX

**ClaunX Automation & AI** — *Unlocking Intelligence. Prosperity Through Automation.*

We build production-grade AI agents and automation systems for businesses that are done doing things manually.

[claunx.com](https://claunx.com) · [LinkedIn](https://linkedin.com/in/brunoantoniassi)

---

*Built by [Bruno Antoniassi](https://github.com/BrunoAntoniassiClaunX) · ClaunX Automation & AI · São Paulo, Brazil*
