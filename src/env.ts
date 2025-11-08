import { config } from 'dotenv';
import { z } from 'zod';

config();

const envSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, 'OPENAI_API_KEY is required'),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  SLACK_WEBHOOK_URL: z.string().url().optional(),
  SLACK_USERNAME: z.string().optional(),
});

export const env = envSchema.parse(process.env);
