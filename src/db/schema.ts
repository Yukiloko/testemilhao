import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const createdAt = () => integer("created_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch('subsec') * 1000)`);
const updatedAt = () => integer("updated_at", { mode: "timestamp_ms" }).notNull().default(sql`(unixepoch('subsec') * 1000)`);
const ts = (name: string) => integer(name, { mode: "timestamp_ms" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const FUNNELS = ["customer", "affiliate"] as const;
export type Funnel = (typeof FUNNELS)[number];

export const CUSTOMER_PIPELINE = [
  "discovered",
  "qualified",
  "contacted",
  "replied",
  "interested",
  "whatsapp_handoff",
  "registered",
  "active_customer",
  "closed",
] as const;

export const AFFILIATE_PIPELINE = [
  "discovered",
  "qualified",
  "contacted",
  "replied",
  "interested",
  "joined_affiliate_group",
  "active_affiliate",
  "generated_customer",
  "closed",
] as const;

export type CustomerStatus = (typeof CUSTOMER_PIPELINE)[number];
export type AffiliateStatus = (typeof AFFILIATE_PIPELINE)[number];
export type PipelineStatus = CustomerStatus | AffiliateStatus;

export const CHANNEL_STATES = [
  "browser_contact_pending",
  "browser_contact_sent",
  "waiting_inbound_reply",
  "api_eligible",
  "api_active",
  "api_window_closed",
  "human_review_required",
  "do_not_contact",
  "blocked",
  "completed",
] as const;
export type ChannelState = (typeof CHANNEL_STATES)[number];

export const CHANNEL_OWNERS = ["none", "browser", "api", "human"] as const;
export type ChannelOwner = (typeof CHANNEL_OWNERS)[number];

export const LEAD_ROLES = ["store", "employee", "owner", "decision_maker", "creator", "unknown"] as const;
export type LeadRole = (typeof LEAD_ROLES)[number];

export type ProfileSignals = {
  recentCaptions?: string[];
  hashtags?: string[];
  relatedHandles?: string[];
  isBusiness?: boolean;
  isPrivate?: boolean;
  language?: string;
  engagementRate?: number;
};

export const leads = sqliteTable(
  "leads",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    handle: text("handle").notNull(),
    funnel: text("funnel", { enum: FUNNELS }).notNull(),
    pipelineStatus: text("pipeline_status").$type<PipelineStatus>().notNull().default("discovered"),
    displayName: text("display_name"),
    bio: text("bio"),
    category: text("category"),
    location: text("location"),
    externalUrl: text("external_url"),
    followers: integer("followers"),
    following: integer("following"),
    postsCount: integer("posts_count"),
    signals: json<ProfileSignals>("signals").notNull().default({}),
    source: text("source", { enum: ["hashtag", "related", "keyword", "import", "referral"] }).notNull(),
    sourceDetail: text("source_detail"),
    niche: text("niche"),
    tags: json<string[]>("tags").notNull().default([]),
    score: real("score"),
    scoreReasons: json<string[]>("score_reasons").notNull().default([]),
    role: text("role", { enum: LEAD_ROLES }).notNull().default("unknown"),
    priority: integer("priority").notNull().default(0),
    bestSendHour: integer("best_send_hour"),
    nextAction: text("next_action"),
    nextActionAt: ts("next_action_at"),
    transactedVolume: real("transacted_volume").notNull().default(0),
    referredByLeadId: integer("referred_by_lead_id").references((): AnySQLiteColumn => leads.id),
    closedReason: text("closed_reason"),
    contactedAt: ts("contacted_at"),
    repliedAt: ts("replied_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("leads_handle_unique").on(t.handle),
    index("leads_funnel_status_idx").on(t.funnel, t.pipelineStatus),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    channelState: text("channel_state", { enum: CHANNEL_STATES }).notNull().default("browser_contact_pending"),
    channelOwner: text("channel_owner", { enum: CHANNEL_OWNERS }).notNull().default("none"),
    metaIgsid: text("meta_igsid"),
    lastInboundAt: ts("last_inbound_at"),
    lastOutboundAt: ts("last_outbound_at"),
    windowExpiresAt: ts("window_expires_at"),
    followupsSent: integer("followups_sent").notNull().default(0),
    nextFollowupAt: ts("next_followup_at"),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("conversations_lead_unique").on(t.leadId), uniqueIndex("conversations_igsid_unique").on(t.metaIgsid)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    direction: text("direction", { enum: ["outbound", "inbound"] }).notNull(),
    channel: text("channel", { enum: ["browser", "api", "whatsapp"] }).notNull(),
    kind: text("kind", { enum: ["opening", "followup", "reply", "inbound"] }).notNull(),
    body: text("body").notNull(),
    status: text("status", { enum: ["pending", "sent", "failed", "blocked", "received"] }).notNull(),
    dedupeKey: text("dedupe_key"),
    externalId: text("external_id"),
    experimentId: integer("experiment_id").references(() => experiments.id),
    variantId: integer("variant_id").references(() => experimentVariants.id),
    error: text("error"),
    sentAt: ts("sent_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_dedupe_unique").on(t.dedupeKey),
    uniqueIndex("messages_external_unique").on(t.externalId),
    index("messages_lead_idx").on(t.leadId, t.createdAt),
  ],
);

export const doNotContact = sqliteTable(
  "do_not_contact",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    handle: text("handle"),
    metaIgsid: text("meta_igsid"),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("dnc_handle_unique").on(t.handle), uniqueIndex("dnc_igsid_unique").on(t.metaIgsid)],
);

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "dead", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull().default({}),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    runAt: ts("run_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseUntil: ts("lease_until"),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    idempotencyKey: text("idempotency_key"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("jobs_idempotency_unique").on(t.idempotencyKey), index("jobs_ready_idx").on(t.status, t.runAt)],
);

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    type: text("type").notNull(),
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
    jobId: integer("job_id"),
    actor: text("actor", { enum: ["system", "ai", "operator", "webhook", "browser"] }).notNull(),
    payload: json<Record<string, unknown>>("payload").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("events_lead_idx").on(t.leadId, t.createdAt), index("events_type_idx").on(t.type, t.createdAt)],
);

export const aiCalls = sqliteTable(
  "ai_calls",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    purpose: text("purpose").notNull(),
    model: text("model").notNull(),
    leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    latencyMs: integer("latency_ms").notNull().default(0),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_calls_created_idx").on(t.createdAt)],
);

export const aiDecisions = sqliteTable("ai_decisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
  inboundMessageId: integer("inbound_message_id").references(() => messages.id),
  intent: text("intent").notNull(),
  action: text("action").notNull(),
  confidence: real("confidence").notNull(),
  reasoning: text("reasoning").notNull(),
  reply: text("reply"),
  outcome: text("outcome", { enum: ["sent", "blocked_by_claims", "escalated", "no_reply", "failed"] }).notNull(),
  createdAt: createdAt(),
});

export const EXPERIMENT_VARIABLES = ["opening", "presentation", "cta", "followup_cadence", "send_hour"] as const;
export type ExperimentVariable = (typeof EXPERIMENT_VARIABLES)[number];

export const experiments = sqliteTable("experiments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  funnel: text("funnel", { enum: FUNNELS }).notNull(),
  variable: text("variable", { enum: EXPERIMENT_VARIABLES }).notNull(),
  hypothesis: text("hypothesis").notNull(),
  primaryMetric: text("primary_metric").$type<PipelineStatus>().notNull().default("replied"),
  status: text("status", { enum: ["running", "paused", "concluded"] }).notNull().default("running"),
  minSamplePerVariant: integer("min_sample_per_variant").notNull().default(50),
  explorationRate: real("exploration_rate").notNull().default(0.1),
  winnerVariantId: integer("winner_variant_id"),
  createdAt: createdAt(),
  concludedAt: ts("concluded_at"),
});

export type VariantContent = { template?: string; instructions?: string; followupDays?: number[]; sendHour?: number };

export const experimentVariants = sqliteTable(
  "experiment_variants",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    experimentId: integer("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    isControl: integer("is_control", { mode: "boolean" }).notNull().default(false),
    weight: real("weight").notNull().default(1),
    content: json<VariantContent>("content").notNull(),
    createdBy: text("created_by", { enum: ["operator", "ai"] }).notNull().default("operator"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("variants_key_unique").on(t.experimentId, t.key)],
);

export const experimentAssignments = sqliteTable(
  "experiment_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    experimentId: integer("experiment_id").notNull().references(() => experiments.id, { onDelete: "cascade" }),
    variantId: integer("variant_id").notNull().references(() => experimentVariants.id, { onDelete: "cascade" }),
    leadId: integer("lead_id").notNull().references(() => leads.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("assignments_unique").on(t.experimentId, t.leadId)],
);

export const strategyChanges = sqliteTable("strategy_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["variant_weight", "setting", "experiment_concluded", "variant_added"] }).notNull(),
  target: text("target").notNull(),
  before: json<unknown>("before"),
  after: json<unknown>("after"),
  reason: text("reason").notNull(),
  actor: text("actor", { enum: ["ai", "operator", "system"] }).notNull(),
  status: text("status", { enum: ["applied", "reverted"] }).notNull().default("applied"),
  createdAt: createdAt(),
  revertedAt: ts("reverted_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: updatedAt(),
});

export const alerts = sqliteTable("alerts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  severity: text("severity", { enum: ["info", "warning", "critical"] }).notNull(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  payload: json<Record<string, unknown>>("payload").notNull().default({}),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
});

export const exceptions = sqliteTable("exceptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  reason: text("reason").notNull(),
  payload: json<Record<string, unknown>>("payload").notNull().default({}),
  status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
  resolvedAt: ts("resolved_at"),
  createdAt: createdAt(),
});

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    externalId: text("external_id").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    processedAt: ts("processed_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("webhook_events_external_unique").on(t.externalId)],
);

export const browserArtifacts = sqliteTable("browser_artifacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: integer("job_id"),
  leadId: integer("lead_id").references(() => leads.id, { onDelete: "set null" }),
  url: text("url"),
  error: text("error").notNull(),
  screenshotPath: text("screenshot_path"),
  snapshotPath: text("snapshot_path"),
  consoleErrors: json<string[]>("console_errors").notNull().default([]),
  networkFailures: json<string[]>("network_failures").notNull().default([]),
  createdAt: createdAt(),
});

export const locks = sqliteTable("locks", {
  name: text("name").primaryKey(),
  owner: text("owner").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type Experiment = typeof experiments.$inferSelect;
export type ExperimentVariant = typeof experimentVariants.$inferSelect;
