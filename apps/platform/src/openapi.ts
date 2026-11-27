/**
 * The OpenAPI 3.1 description of the platform API, served at
 * `/openapi.json`. Kept by hand beside `api.ts`; a test checks that every
 * route the API serves is described here.
 */
const error = { $ref: "#/components/responses/Error" };
const ok = (description: string, schema: Record<string, unknown> = { type: "object" }) => ({ description, content: { "application/json": { schema } } });
const idempotency = { $ref: "#/components/parameters/IdempotencyKey" };
const sessionId = { $ref: "#/components/parameters/SessionId" };
const body = (schema: Record<string, unknown>, required = true) => ({ required, content: { "application/json": { schema } } });

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "Mattering platform API",
    version: "1",
    summary: "Sealed-bid auctions, negotiations and limit matches in which nobody, Mattering included, can read a bid before the agreed time.",
    description:
      "Demonstration environment: proof of concept, not security reviewed. Results are not legally binding and no payment is made or arranged. Every response carries `Mattering-Environment: demonstration`. See docs/api.md for a walk-through and docs/api-design.md for the design.",
    license: { name: "MIT" },
  },
  servers: [{ url: "https://mattering.ai/api/v1" }],
  security: [{ apiKey: [] }, { participantToken: [] }, {}],
  paths: {
    "/sessions": {
      get: {
        operationId: "listSessions",
        summary: "This integrator's sessions, newest first",
        security: [{ apiKey: [] }],
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } }, { name: "before", in: "query", description: "The `next` value from the previous page", schema: { type: "integer" } }],
        responses: { "200": ok("Sessions", { type: "object", properties: { sessions: { type: "array", items: { type: "object", properties: { id: { type: "string" }, mechanism: { type: "string" }, createdAt: { type: "string", format: "date-time" } } } }, next: { type: "integer" } } }), "401": error },
      },
      post: {
        operationId: "createSession",
        summary: "Create a session",
        description: "Integrators only. Returns the session as its organiser sees it, with the invitation codes to hand to the participants.",
        security: [{ apiKey: [] }],
        parameters: [idempotency],
        requestBody: body({ $ref: "#/components/schemas/CreateSession" }),
        responses: { "201": ok("The session, with its invitations", { $ref: "#/components/schemas/Session" }), "400": error, "401": error, "429": error },
      },
    },
    "/join": {
      post: {
        operationId: "joinByInvitation",
        summary: "Join the session an invitation names",
        security: [{}],
        parameters: [idempotency],
        requestBody: body({ $ref: "#/components/schemas/Join" }),
        responses: { "201": ok("The participant and its token", { $ref: "#/components/schemas/Joined" }), "400": error, "404": error, "409": error },
      },
    },
    "/sessions/{id}": {
      get: { operationId: "getSession", summary: "The session as the caller may see it", parameters: [sessionId], responses: { "200": ok("The session", { $ref: "#/components/schemas/Session" }), "403": error, "404": error } },
    },
    "/sessions/{id}/join": {
      post: { operationId: "joinSession", summary: "Join with an invitation", security: [{}], parameters: [sessionId, idempotency], requestBody: body({ $ref: "#/components/schemas/Join" }), responses: { "201": ok("The participant and its token", { $ref: "#/components/schemas/Joined" }), "400": error, "404": error, "409": error } },
    },
    "/sessions/{id}/invitation": {
      get: { operationId: "getInvitation", summary: "What an invitation is for: its role and label, and whether it has been used", security: [{}], parameters: [sessionId, { name: "code", in: "query", required: true, schema: { type: "string", pattern: "^inv_" } }], responses: { "200": ok("The invitation", { type: "object", properties: { sessionId: { type: "string" }, role: { enum: ["bidder", "buyer", "seller"] }, label: { type: "string" }, used: { type: "boolean" } } }), "404": error } },
    },
    "/sessions/{id}/check-in": {
      post: { operationId: "checkIn", summary: "A negotiation's side is present; round 1 begins once both are", security: [{ participantToken: [] }], parameters: [sessionId, idempotency], responses: { "200": ok("The session"), "403": error, "409": error } },
    },
    "/sessions/{id}/round": {
      get: { operationId: "getRound", summary: "The current round's policy, which a client-sealed bid must be sealed under", parameters: [sessionId], responses: { "200": ok("The policy and its hash", { type: "object", properties: { round: { type: "integer" }, policy: { type: "object" }, policyHash: { type: "string" }, closesAt: { type: "string", format: "date-time" }, opensAt: { type: "string", format: "date-time" } } }), "409": error } },
    },
    "/sessions/{id}/bids": {
      post: {
        operationId: "submitBid",
        summary: "Seal a bid or an offer",
        description: "One per participant per round. Client-sealed: `{ submission, envelope }` from the SDK, signed by the participant's key; nothing in it reveals the amount. Server-sealed: `{ amount }` (auctions) or `{ price }` (negotiations). A server-sealed limit match takes none.",
        security: [{ participantToken: [] }],
        parameters: [sessionId, idempotency],
        requestBody: body({ oneOf: [{ $ref: "#/components/schemas/SealedBid" }, { type: "object", required: ["amount"], properties: { amount: { type: "integer" } } }, { type: "object", required: ["price"], properties: { price: { type: "integer" } } }] }),
        responses: { "201": ok("The log's receipt for the sealed bid", { $ref: "#/components/schemas/BidReceipt" }), "400": error, "403": error, "409": error },
      },
    },
    "/sessions/{id}/open": {
      post: { operationId: "openSession", summary: "Organiser: open now, rather than at opensAt", security: [{ apiKey: [] }], parameters: [sessionId, idempotency], responses: { "200": ok("The session"), "403": error, "409": error } },
    },
    "/sessions/{id}/cancel": {
      post: { operationId: "cancelSession", summary: "Organiser: cancel. Either side of a negotiation: walk away", parameters: [sessionId, idempotency], responses: { "200": ok("The session"), "403": error, "409": error } },
    },
    "/sessions/{id}/disclose": {
      post: {
        operationId: "disclose",
        summary: "Disclose the file keys of the opened bids, so the result can be published",
        description: "The organiser of an auction sealed to its key, or either side of a negotiation for the round just opened. Checked against the evidence; keys that do not open every bid are refused.",
        parameters: [sessionId, idempotency],
        requestBody: body({ type: "object", required: ["fileKeys"], properties: { fileKeys: { type: "object", additionalProperties: { type: "string" } } } }),
        responses: { "200": ok("The session"), "400": error, "403": error, "409": error },
      },
    },
    "/sessions/{id}/result": {
      get: { operationId: "getResult", summary: "The outcome, the receipt, and the disclosure needed to check it", parameters: [sessionId], responses: { "200": ok("The result", { $ref: "#/components/schemas/Result" }), "403": error, "404": error } },
    },
    "/sessions/{id}/evidence": {
      get: { operationId: "getEvidence", summary: "Every round's evidence from the public log, with file keys for those who may read the bids", parameters: [sessionId], responses: { "200": ok("The evidence bundle (mattering.session-evidence/1)"), "404": error, "409": error } },
    },
    "/sessions/{id}/events": {
      get: {
        operationId: "getEvents",
        summary: "The session's events: JSON after ?after=, or a server-sent event stream with Accept: text/event-stream",
        parameters: [sessionId, { name: "after", in: "query", schema: { type: "integer", minimum: 0 } }, { name: "Last-Event-ID", in: "header", schema: { type: "integer" } }],
        responses: { "200": { description: "Events", content: { "application/json": { schema: { type: "object", properties: { events: { type: "array", items: { $ref: "#/components/schemas/Event" } }, last: { type: "integer" }, phase: { type: "string" } } } }, "text/event-stream": { schema: { type: "string" } } } }, "403": error },
      },
    },
    "/webhooks": {
      post: { operationId: "createWebhook", summary: "Where to send this integrator's session events", security: [{ apiKey: [] }], requestBody: body({ type: "object", required: ["url"], properties: { url: { type: "string", format: "uri" }, events: { type: "array", items: { type: "string" } } } }), responses: { "201": ok("The webhook, with its secret, shown once"), "400": error, "401": error } },
      get: { operationId: "listWebhooks", summary: "This integrator's webhooks", security: [{ apiKey: [] }], responses: { "200": ok("The webhooks, without secrets"), "401": error } },
    },
    "/webhooks/deliveries": {
      get: {
        operationId: "listDeliveries",
        summary: "This integrator's recent webhook deliveries, newest first, including failures and retries",
        security: [{ apiKey: [] }],
        parameters: [{ name: "webhook", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200 } }],
        responses: { "200": ok("Deliveries", { type: "object", properties: { deliveries: { type: "array", items: { type: "object", properties: { at: { type: "string", format: "date-time" }, sessionId: { type: "string" }, webhook: { type: "string" }, event: { type: "string" }, n: { type: "integer" }, ok: { type: "boolean" }, status: { type: ["integer", "null"] }, attempt: { type: "integer" } } } } } }), "401": error },
      },
    },
    "/usage": {
      get: {
        operationId: "getUsage",
        summary: "This integrator's usage per day: sessions created, bids sealed, webhook deliveries and failed attempts",
        security: [{ apiKey: [] }],
        parameters: [{ name: "days", in: "query", schema: { type: "integer", minimum: 1, maximum: 60 } }],
        responses: { "200": ok("Usage", { type: "object", properties: { usage: { type: "array", items: { type: "object", properties: { day: { type: "string", format: "date" }, sessions: { type: "integer" }, bids: { type: "integer" }, deliveries: { type: "integer" }, failedDeliveries: { type: "integer" } } } } } }), "401": error },
      },
    },
    "/webhooks/{webhookId}": {
      delete: { operationId: "deleteWebhook", summary: "Stop sending to a webhook", security: [{ apiKey: [] }], parameters: [{ name: "webhookId", in: "path", required: true, schema: { type: "string", pattern: "^whk_[0-9a-f]{16}$" } }], responses: { "200": ok("Deleted"), "401": error, "404": error } },
    },
  },
  components: {
    securitySchemes: {
      apiKey: { type: "http", scheme: "bearer", description: "An integrator's API key: mk_test_… or mk_live_…" },
      participantToken: { type: "http", scheme: "bearer", description: "A participant's token, tok_…, issued on joining; for its own session only" },
    },
    parameters: {
      SessionId: { name: "id", in: "path", required: true, schema: { type: "string", pattern: "^ses_[0-9a-f]{24}$" } },
      IdempotencyKey: { name: "Idempotency-Key", in: "header", description: "Repeat a POST with the same key and get the first reply, so a retried bid is not a second bid", schema: { type: "string", maxLength: 200 } },
    },
    responses: {
      Error: { description: "Refused", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: { code: { type: "string", examples: ["invalid", "out-of-range", "late", "duplicate", "beyond-mandate", "not-a-participant", "no-quorum", "wrong-phase", "incomplete", "forbidden", "unauthorised", "limit", "idempotency-mismatch"] }, message: { type: "string" } },
          },
        },
      },
      CreateSession: {
        type: "object",
        required: ["mechanism", "terms", "invitations"],
        properties: {
          mechanism: { enum: ["sealed-bid-auction", "negotiation", "limit-match"] },
          terms: {
            oneOf: [
              { title: "Auction", type: "object", required: ["item", "unit", "minBid", "maxBid", "rule"], properties: { item: { type: "string" }, unit: { type: "string", examples: ["bps", "GBP"] }, minBid: { type: "integer" }, maxBid: { type: "integer" }, rule: { enum: ["highest-bid", "lowest-bid"] }, reserve: { type: "integer", description: "Public; no winner unless the best bid reaches it" } } },
              { title: "Negotiation or limit match", type: "object", required: ["item", "unit", "minPrice", "maxPrice"], properties: { item: { type: "string" }, unit: { type: "string" }, minPrice: { type: "integer" }, maxPrice: { type: "integer" }, rounds: { type: "integer", minimum: 1, maximum: 10, description: "Default 3; a limit match has 1" } } },
            ],
          },
          timing: { type: "object", properties: { opensAt: { type: "string", format: "date-time" }, biddingSeconds: { type: "integer", minimum: 30, description: "How long each round stays open; default 600" }, quorumBy: { type: "string", format: "date-time" } } },
          confidentiality: { enum: ["organiser", "parties", "public"], description: "Auctions: organiser (default) or public. Negotiations: parties" },
          sealing: { enum: ["client", "server"], description: "client (default): participants seal on their own machines. server: Mattering holds their keys and says so" },
          organiserRecipient: { type: "string", description: "Client-sealed auctions under organiser confidentiality: the organiser's own age recipient (age1…)" },
          invitations: { type: "array", items: { type: "object", properties: { role: { enum: ["bidder", "buyer", "seller"] }, label: { type: "string" } } } },
        },
      },
      Join: {
        type: "object",
        required: ["invitation"],
        properties: {
          invitation: { type: "string", pattern: "^inv_" },
          publicKey: { type: "string", description: "Client-sealed: the participant's Ed25519 public key, hex" },
          recipient: { type: "string", description: "Client-sealed negotiations: the participant's age recipient" },
          mandate: { type: "object", description: "Client-sealed negotiations, optional: the organisation's signed mandate for publicKey (mattering.mandate/1)" },
          limit: { type: "integer", description: "Server-sealed negotiations: this side's limit, issued as a mandate" },
        },
      },
      Joined: { type: "object", properties: { participant: { type: "object" }, token: { type: "string", description: "Keep secret: it acts for this participant" }, session: { $ref: "#/components/schemas/Session" } } },
      SealedBid: { type: "object", required: ["submission", "envelope"], properties: { submission: { type: "object" }, envelope: { type: "object" } } },
      BidReceipt: { type: "object", properties: { round: { type: "integer" }, receipt: { type: "object" }, closesAt: { type: "string", format: "date-time" }, closeRound: { type: "integer" }, opensAt: { type: "string", format: "date-time" }, releaseRound: { type: "integer" } } },
      Session: {
        type: "object",
        properties: {
          id: { type: "string" },
          environment: { const: "demonstration" },
          mechanism: { type: "string" },
          phase: { enum: ["created", "open", "closed", "released", "finished", "cancelled", "expired"] },
          terms: { type: "object" },
          confidentiality: { type: "string" },
          sealing: { type: "string" },
          trust: { type: "string", description: "Who could have read or forged a bid" },
          round: { type: "object" },
          outcome: { type: "object" },
          receipt: { type: "object" },
          awaiting: { type: "string" },
        },
      },
      Result: { type: "object", properties: { id: { type: "string" }, phase: { type: "string" }, outcome: { type: ["object", "null"] }, receipt: { type: ["object", "null"] }, disclosure: { type: "object", properties: { fileKeys: { type: "object" } } } } },
      Event: { type: "object", properties: { n: { type: "integer" }, type: { type: "string" }, at: { type: "integer" }, data: { type: "object" } } },
    },
  },
} as const;
