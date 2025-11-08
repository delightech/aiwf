import { IncomingWebhook } from '@slack/webhook';
import { generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { env } from '../../env';

const languageSchema = z.enum(['ja', 'en']);

const influencerSchema = z.object({
  name: z.string(),
  platform: z.string().optional(),
  handle: z.string().optional(),
  followers: z.string().optional(),
  positioning: z.string().optional(),
});

const baseCaseSchema = z.object({
  brand: z.string(),
  campaignName: z.string(),
  geography: z.string(),
  timeframe: z.string().optional(),
  summary: z.string(),
  productFocus: z.string().optional(),
  offerType: z.string().optional(),
  influencers: z.array(influencerSchema).min(1),
  sources: z.array(z.string()).min(1).optional(),
});

const metricSchema = z.object({
  metric: z.string(),
  value: z.string(),
  currency: z.string().optional(),
  timeframe: z.string().optional(),
  note: z.string().optional(),
});

const enrichedCaseSchema = baseCaseSchema.extend({
  metrics: z.array(metricSchema).min(1),
});

type BaseCase = z.infer<typeof baseCaseSchema>;
type EnrichedCase = z.infer<typeof enrichedCaseSchema>;

type CaseList = z.infer<typeof caseListSchema>;
type EnrichedCaseList = z.infer<typeof enrichedCaseListSchema>;

const caseListSchema = z.object({
  cases: z.array(baseCaseSchema).max(6),
});

const enrichedCaseListSchema = z.object({
  cases: z.array(enrichedCaseSchema),
});

const openaiClient = createOpenAI({
  apiKey: env.OPENAI_API_KEY,
});

const MODEL_NAME = env.OPENAI_MODEL;
const isSearchModel = MODEL_NAME.includes('search');

/**
 * Generate structured object with model-specific handling
 */
async function generateStructuredObject<T>(params: {
  model: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
}): Promise<T> {
  if (isSearchModel) {
    // Search models don't support json_schema format, use text generation + parsing
    const { text } = await generateText({
      model: openaiClient(params.model),
      system: `${params.system}

IMPORTANT: You MUST respond with valid JSON only. Do not include any explanatory text, only valid JSON.`,
      prompt: `${params.prompt}

Respond with valid JSON only, no additional text.`,
    });

    // Parse and validate JSON response
    try {
      const parsed = JSON.parse(text);
      return params.schema.parse(parsed);
    } catch (error) {
      throw new Error(`Failed to parse search model response as valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    // Standard models support structured output
    const { object } = await generateObject({
      model: openaiClient(params.model),
      schema: params.schema as any,
      system: params.system,
      prompt: params.prompt,
    });
    return object as T;
  }
}

const slackWebhook = env.SLACK_WEBHOOK_URL
  ? new IncomingWebhook(env.SLACK_WEBHOOK_URL, {
      username: env.SLACK_USERNAME ?? 'mastra-commerce-workflow',
    })
  : null;

const collectCompetitorCasesStep = createStep({
  id: 'collect-competitor-cases',
  description: 'ChatGPT でコマース x インフルエンサーの他社事例を抽出',
  inputSchema: z.object({
    focusKeyword: z.string().default('コマース x インフルエンサー'),
    geography: z.string().default('Japan'),
    minExamples: z.number().int().min(1).max(6).default(3),
    language: languageSchema.default('ja'),
    metricFocus: z.array(z.string()).min(1).default(['売上', 'CVR', 'ROI']),
    includeSources: z.boolean().default(true),
  }),
  outputSchema: z.object({
    cases: z.array(baseCaseSchema).min(1),
    metricFocus: z.array(z.string()).min(1),
    language: languageSchema,
    includeSources: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { focusKeyword, geography, minExamples, language, metricFocus, includeSources } = inputData;

    const structured = await generateStructuredObject<CaseList>({
      model: MODEL_NAME,
      schema: caseListSchema,
      system:
        'You are a GTM analyst who researches commerce x influencer collaborations. Return only vetted cases from 2021 onward, prioritizing Japan/APAC brands unless told otherwise.',
      prompt: `Focus keyword: ${focusKeyword}
Priority region: ${geography}. Provide at least ${minExamples} distinct competitor case studies that match the focus. Return concise factual summaries, channels, creator roles, and reliable source URLs. Respond in ${language === 'ja' ? 'Japanese' : 'English'}.`,
    });

    return {
      cases: structured.cases,
      metricFocus,
      language,
      includeSources,
    };
  },
});

const enrichCasesWithMetricsStep = createStep({
  id: 'enrich-cases-with-metrics',
  description: '1 の事例に売上やKPIなどの数値情報を追加',
  inputSchema: z.object({
    cases: z.array(baseCaseSchema).min(1),
    metricFocus: z.array(z.string()).min(1),
    language: languageSchema,
    includeSources: z.boolean(),
  }),
  outputSchema: z.object({
    cases: z.array(enrichedCaseSchema).min(1),
    metricFocus: z.array(z.string()).min(1),
    language: languageSchema,
    includeSources: z.boolean(),
  }),
  execute: async ({ inputData }) => {
    const { cases, metricFocus, language, includeSources } = inputData;

    const structured = await generateStructuredObject<EnrichedCaseList>({
      model: MODEL_NAME,
      schema: enrichedCaseListSchema,
      system:
        'Act as a revenue operations analyst. Enrich each case with concrete numeric KPIs (sales, GMV, conversion, ROI). Quote actual historical numbers when publicly reported and note the currency/timeframe. If unavailable, write "情報なし" and explain the gap.',
      prompt: `Here is JSON for competitor cases: ${JSON.stringify(cases)}. Focus your numeric extraction on: ${metricFocus.join(', ')}. Write explanations in ${language === 'ja' ? 'Japanese' : 'English'}.`,
    });

    return {
      cases: structured.cases,
      metricFocus,
      language,
      includeSources,
    };
  },
});

const summarizeAndNotifyStep = createStep({
  id: 'summarize-and-notify',
  description: '結果を整形してSlack通知',
  inputSchema: z.object({
    cases: z.array(enrichedCaseSchema).min(1),
    metricFocus: z.array(z.string()).min(1),
    language: languageSchema,
    includeSources: z.boolean(),
  }),
  outputSchema: z.object({
    summary: z.string(),
    sentToSlack: z.boolean(),
    cases: z.array(enrichedCaseSchema).min(1),
  }),
  execute: async ({ inputData }) => {
    const { cases, language, includeSources } = inputData;

    const bulletLabel = language === 'ja' ? '主要KPI' : 'Key KPIs';
    const summary = cases
      .map((c, idx) => {
        const metrics = c.metrics
          .map((metric) => `- ${metric.metric}: ${metric.value}${metric.currency ? ` ${metric.currency}` : ''}${metric.timeframe ? ` (${metric.timeframe})` : ''}${metric.note ? `｜${metric.note}` : ''}`)
          .join('\n');
        const sources = includeSources && c.sources?.length ? `\n${language === 'ja' ? '参考' : 'Sources'}: ${c.sources.join(', ')}` : '';
        return `${idx + 1}. ${c.brand} / ${c.campaignName}\n${c.summary}\n${bulletLabel}:\n${metrics}${sources}`;
      })
      .join('\n\n');

    let sentToSlack = false;

    if (slackWebhook) {
      const blocks = [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: language === 'ja' ? 'コマース x インフルエンサー他社事例' : 'Commerce x Influencer Scan',
          },
        },
        ...cases.map((c, idx) => ({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${idx + 1}. ${c.brand} — ${c.campaignName}*\n${c.summary}\n${bulletLabel}: ${c.metrics
              .map((metric) => `${metric.metric}: ${metric.value}`)
              .join(' / ')}`,
          },
        })),
      ].slice(0, 50);

      await slackWebhook.send({
        text: summary,
        blocks,
      });

      sentToSlack = true;
    } else {
      console.warn('SLACK_WEBHOOK_URL が設定されていないため、Slack 送信をスキップしました。');
    }

    return {
      summary,
      sentToSlack,
      cases,
    };
  },
});

export const commerceInfluencerWorkflow = createWorkflow({
  id: 'commerce-influencer-workflow',
  inputSchema: collectCompetitorCasesStep.inputSchema,
  outputSchema: summarizeAndNotifyStep.outputSchema,
})
  .then(collectCompetitorCasesStep)
  .then(enrichCasesWithMetricsStep)
  .then(summarizeAndNotifyStep);

commerceInfluencerWorkflow.commit();

export const steps = {
  collectCompetitorCasesStep,
  enrichCasesWithMetricsStep,
  summarizeAndNotifyStep,
};

export type CommerceInfluencerWorkflowResult = z.infer<typeof summarizeAndNotifyStep.outputSchema>;

export type CommerceInfluencerWorkflowInput = z.infer<typeof collectCompetitorCasesStep.inputSchema>;
