# Agente Lia | Conversational AI

**Focus:** Conversational AI, retrieval-augmented generation, workflow orchestration, and CRM integration.  
**Status:** Previously deployed in production, as documented in the project records.  
**Stack:** n8n, GPT-4o, Pinecone, Redis, WhatsApp API, CRM integration.

## Problem

An automotive sales team needed to respond to incoming inquiries, provide product information, qualify leads, and transfer relevant conversations to human sales representatives.

## Implementation

- Incoming WhatsApp messages triggered an n8n workflow.
- Pinecone retrieved relevant product catalog information for the language model.
- Redis maintained conversational session state.
- The agent answered product questions and supported lead qualification, CRM handoff, and escalation to the sales team.

```text
WhatsApp webhook -> n8n -> Redis session + Pinecone retrieval -> LLM
Response -> WhatsApp | qualified lead -> CRM / human escalation
```

## Engineering approach

Use retrieval for product context, explicit session state for multi-turn interactions, and workflow routing for human escalation. The agent supports sales representatives rather than replacing every sales decision.

## Scope and limitations

This is a retrospective technical case study, not a runnable workflow export or a live service-status report. No independently verified latency benchmark, conversion uplift, or unlimited processing capacity is claimed. Customer data, credentials, internal endpoints, and client-specific configuration are excluded.

[Back to portfolio](../README.md)
