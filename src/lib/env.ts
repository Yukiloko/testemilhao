import { z } from "zod";

const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;

const envSchema = z
  .object({
    OPENAI_API_KEY: z.string().min(1),
    OPENAI_MODEL: z.string().min(1),
    OPENAI_MODEL_FAST: z.string().min(1),
    OPENAI_MONTHLY_BUDGET_USD: z.coerce.number().positive(),
    OPENAI_MODEL_INPUT_USD_PER_1M: z.coerce.number().nonnegative(),
    OPENAI_MODEL_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative(),
    OPENAI_MODEL_FAST_INPUT_USD_PER_1M: z.coerce.number().nonnegative(),
    OPENAI_MODEL_FAST_OUTPUT_USD_PER_1M: z.coerce.number().nonnegative(),

    CHROME_CDP_URL: z.url(),
    CHROME_PROFILE_DIR: z.string().min(1),
    INSTAGRAM_WEB_URL: z.url().default("https://www.instagram.com"),

    INSTAGRAM_APP_SECRET: z.string().min(1),
    INSTAGRAM_PAGE_ACCESS_TOKEN: z.string().min(1),
    INSTAGRAM_WEBHOOK_VERIFY_TOKEN: z.string().min(1),
    INSTAGRAM_BUSINESS_ACCOUNT_ID: z.string().min(1),
    INSTAGRAM_GRAPH_API_URL: z.url().default("https://graph.facebook.com/v23.0"),

    DATABASE_URL: z.string().min(1).default("./data/app.db"),
    BACKUP_DIR: z.string().min(1).default("./backups"),
    ARTIFACTS_DIR: z.string().min(1).default("./artifacts"),
    APP_ENCRYPTION_KEY: z
      .string()
      .refine((v) => Buffer.from(v, "base64").length === 32, "must be 32 bytes encoded as base64"),

    MAX_DMS_PER_DAY: z.coerce.number().int().positive().max(200),
    MIN_SECONDS_BETWEEN_DMS: z.coerce.number().int().min(30),
    MAX_SECONDS_BETWEEN_DMS: z.coerce.number().int().min(30),
    OPERATING_HOURS: z
      .string()
      .refine((v) => {
        const [start, end] = v.split("-");
        return !!start && !!end && hhmm.test(start) && hhmm.test(end) && start < end;
      }, "expected HH:MM-HH:MM"),
    OPERATING_TIMEZONE: z.string().refine(isValidTimezone, "unknown IANA timezone"),

    BROWSER_SEND_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((v) => v === "true"),
  })
  .refine((e) => e.MIN_SECONDS_BETWEEN_DMS <= e.MAX_SECONDS_BETWEEN_DMS, {
    message: "MIN_SECONDS_BETWEEN_DMS must be <= MAX_SECONDS_BETWEEN_DMS",
    path: ["MIN_SECONDS_BETWEEN_DMS"],
  });

export type Env = z.infer<typeof envSchema>;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

let cached: Env | undefined;

/** Validates process.env once. Throws a readable error listing every invalid variable. */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}
