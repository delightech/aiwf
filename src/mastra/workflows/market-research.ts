/**
 * Market Research Workflow (汎用マーケットリサーチワークフロー)
 * 
 * このワークフローは任意のキーワードで市場調査を実行できる汎用的な設計です:
 * 1. ChatGPTから指定キーワードに関連する事例を収集
 * 2. 各事例に売上・KPIなどの数値データを追加
 * 3. 結果を整形してSlackに通知
 * 
 * Mastraワークフローの基本構造:
 * - Schema定義: Zodを使用してデータ構造を定義
 * - Step作成: createStepで各処理ステップを定義
 * - Workflow作成: createWorkflowでステップを連結
 * - 実行: workflow.createRunAsync()でワークフローを実行
 */

// Slack通知用のWebhookクライアント
import { IncomingWebhook } from '@slack/webhook';
// AI SDK: OpenAIモデルとの通信用
import { generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
// Mastraのワークフロー作成関数
import { createStep, createWorkflow } from '@mastra/core/workflows';
// Zodスキーマ: データ構造の定義とバリデーション
import { z } from 'zod';

// 環境変数(APIキー、モデル名など)
import { env } from '../../env';

// ============================================================================
// Zodスキーマ定義: データ構造の型安全性を確保
// ============================================================================

/**
 * 言語スキーマ: 日本語または英語
 * ワークフロー全体で使用される言語設定
 */
const languageSchema = z.enum(['ja', 'en']);

/**
 * インフルエンサー情報のスキーマ
 * 各キャンペーンで起用されたインフルエンサーの詳細
 */
const influencerSchema = z.object({
  name: z.string(),                    // インフルエンサー名
  platform: z.string().optional(),     // プラットフォーム(Instagram, YouTube等)
  handle: z.string().optional(),       // アカウントハンドル(@username)
  followers: z.string().optional(),    // フォロワー数
  positioning: z.string().optional(),  // ポジショニング(ファッション、美容等)
});

/**
 * 基本事例スキーマ
 * Step 1で収集される事例の基本情報
 */
const baseCaseSchema = z.object({
  brand: z.string(),                              // ブランド名
  campaignName: z.string(),                       // キャンペーン名
  geography: z.string(),                          // 地域(Japan等)
  timeframe: z.string().optional(),               // 実施期間
  summary: z.string(),                            // 概要説明
  productFocus: z.string().optional(),            // 商品カテゴリ
  offerType: z.string().optional(),               // オファータイプ
  influencers: z.array(influencerSchema).min(1),  // インフルエンサーリスト(最低1人)
  sources: z.array(z.string()).min(1).optional(), // 情報源URL
});

/**
 * メトリクス(KPI)スキーマ
 * Step 2で追加される数値データ
 */
const metricSchema = z.object({
  metric: z.string(),                         // メトリクス名(売上、GMV、CVR等)
  value: z.string(),                          // 値
  currency: z.string().nullable().optional(), // 通貨(JPY, USD等)
  timeframe: z.string().optional(),           // 期間
  note: z.string().optional(),                // 備考・説明
});

/**
 * 拡張事例スキーマ
 * Step 2で基本事例にメトリクスを追加した完全版
 */
const enrichedCaseSchema = baseCaseSchema.extend({
  metrics: z.array(metricSchema).min(1), // KPIリスト(最低1つ)
});

/**
 * TypeScript型定義
 * Zodスキーマから自動的に型を推論
 */
type BaseCase = z.infer<typeof baseCaseSchema>;
type EnrichedCase = z.infer<typeof enrichedCaseSchema>;
type CaseList = z.infer<typeof caseListSchema>;
type EnrichedCaseList = z.infer<typeof enrichedCaseListSchema>;

/**
 * 事例リストスキーマ(基本版)
 * Step 1の出力: 最大6件の事例
 */
const caseListSchema = z.object({
  cases: z.array(baseCaseSchema).max(6),
});

/**
 * 事例リストスキーマ(拡張版)
 * Step 2の出力: メトリクス付き事例リスト
 */
const enrichedCaseListSchema = z.object({
  cases: z.array(enrichedCaseSchema),
});

// ============================================================================
// OpenAI クライアント設定
// ============================================================================

/**
 * OpenAIクライアントの初期化
 * 環境変数からAPIキーを読み込んで設定
 */
const openaiClient = createOpenAI({
  apiKey: env.OPENAI_API_KEY,
});

/**
 * 使用するモデル名(環境変数から取得)
 * 例: gpt-4o-mini, gpt-5-search-api等
 */
const MODEL_NAME = env.OPENAI_MODEL;

/**
 * Structured Outputs API非対応モデルの判定
 * 以下のモデルはgenerateObject APIに非対応のため、generateTextを使用:
 * - 検索モデル (gpt-5-search-api等、名前に'search'を含む)
 * - GPT-5シリーズ (gpt-5, gpt-5-mini等)
 */
const isNonStructuredModel = MODEL_NAME.includes('search') || MODEL_NAME.startsWith('gpt-5');

/**
 * モデル別の構造化データ生成関数
 * 
 * この関数は指定されたモデルに応じて最適な方法でAIから構造化データを取得します:
 * 
 * 【標準モデルの場合】(gpt-4o-mini, gpt-4o等)
 *   - generateObject APIを使用
 *   - OpenAIのStructured Outputs機能を利用
 *   - スキーマに厳密に従ったJSONを直接取得
 *
 * 【非対応モデルの場合】(gpt-5, gpt-5-mini, gpt-5-search-api等)
 *   - generateText APIを使用
 *   - プロンプトでJSON形式を指示
 *   - レスポンスをパースしてZodスキーマでバリデーション
 * 
 * @param params.model - 使用するモデル名
 * @param params.schema - Zodスキーマ(データ構造の定義)
 * @param params.system - システムプロンプト(AIの役割定義)
 * @param params.prompt - ユーザープロンプト(具体的な指示)
 * @returns スキーマに従った構造化データ
 */
async function generateStructuredObject<T>(params: {
  model: string;
  schema: z.ZodType<T>;
  system: string;
  prompt: string;
}): Promise<T> {
  if (isNonStructuredModel) {
    // 非対応モデル: 構造化出力APIに非対応のため、テキスト生成を使用
    const { text } = await generateText({
      model: openaiClient(params.model),
      system: `${params.system}

IMPORTANT: You MUST respond with valid JSON only. Do not include any explanatory text, only valid JSON.`,
      prompt: `${params.prompt}

Respond with valid JSON only, no additional text.`,
    });

    // JSONパースとZodバリデーション
    try {
      const parsed = JSON.parse(text);
      return params.schema.parse(parsed);
    } catch (error) {
      console.error('❌ Model response that failed to parse:');
      console.error(text);
      console.error('\n❌ Parse error:');
      throw new Error(`Failed to parse non-structured model response as valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    // 標準モデル: Structured Outputs APIを使用
    const { object } = await generateObject({
      model: openaiClient(params.model),
      schema: params.schema as any,
      system: params.system,
      prompt: params.prompt,
    });
    return object as T;
  }
}

/**
 * Slack Webhook クライアント
 * 環境変数にSLACK_WEBHOOK_URLが設定されている場合のみ初期化
 * 設定されていない場合はnullとなり、Step 3でSlack通知がスキップされる
 */
const slackWebhook = env.SLACK_WEBHOOK_URL
  ? new IncomingWebhook(env.SLACK_WEBHOOK_URL, {
      username: env.SLACK_USERNAME ?? 'mastra-commerce-workflow',
    })
  : null;

// ============================================================================
// Step 1: 他社事例の収集
// ============================================================================

/**
 * Step 1: ChatGPTから事例を収集
 * 
 * Mastra Step の構造:
 * - id: ステップの一意識別子(ログやデバッグで使用)
 * - description: ステップの説明(人間が読むため)
 * - inputSchema: 入力データのZodスキーマ(型安全性とバリデーション)
 * - outputSchema: 出力データのZodスキーマ(次のステップに渡されるデータ)
 * - execute: 実際の処理ロジック(非同期関数)
 */
const collectCasesStep = createStep({
  id: 'collect-cases',
  description: 'ChatGPT で指定キーワードに関連する事例を抽出',
  
  /**
   * 入力スキーマ: ワークフロー開始時に受け取るパラメータ
   * focusKeywordは必須パラメータ(デフォルト値なし)として汎用化
   * 他のパラメータにはデフォルト値を設定
   */
  inputSchema: z.object({
    focusKeyword: z.string().min(1, 'focusKeyword is required'),  // 検索キーワード(必須)
    geography: z.string().default('Japan'),                        // 対象地域
    minExamples: z.number().int().min(1).max(6).default(3),       // 最小事例数
    language: languageSchema.default('ja'),                        // 言語(日本語/英語)
    metricFocus: z.array(z.string()).min(1).default(['売上', 'GMV', 'CVR']), // 注目するKPI
    includeSources: z.boolean().default(true),                     // 情報源URLを含めるか
  }),
  
  /**
   * 出力スキーマ: このステップが返すデータ
   * 次のStep(enrichCasesWithMetricsStep)の入力になる
   */
  outputSchema: z.object({
    cases: z.array(baseCaseSchema).min(1),      // 収集した事例リスト(最低1件)
    metricFocus: z.array(z.string()).min(1),    // KPIフォーカス(次のステップに引き継ぎ)
    language: languageSchema,                    // 言語設定(次のステップに引き継ぎ)
    includeSources: z.boolean(),                 // ソース含有フラグ(次のステップに引き継ぎ)
  }),
  
  /**
   * 実行ロジック
   * @param inputData - inputSchemaで定義された入力データ
   * @returns outputSchemaで定義された出力データ
   */
  execute: async ({ inputData }) => {
    const { focusKeyword, geography, minExamples, language, metricFocus, includeSources } = inputData;

    /**
     * AIモデルを使用して事例を収集
     * generateStructuredObject関数がモデルに応じた最適な方法を自動選択
     */
    const structured = await generateStructuredObject<CaseList>({
      model: MODEL_NAME,              // 環境変数で指定されたモデル
      schema: caseListSchema,         // 出力データの構造定義
      system:
        'You are a professional market research analyst. Research real-world case studies and collaborations from 2021 onward. Focus on factual information with verifiable sources. Prioritize Japan/APAC region unless specified otherwise. You MUST respond with a JSON object containing a "cases" array, not a bare array.',
      prompt: `Research topic: ${focusKeyword}
Target region: ${geography}. Find at least ${minExamples} distinct case studies that match the research topic.

Respond in ${language === 'ja' ? 'Japanese' : 'English'}.

IMPORTANT: Your response must be a JSON object with the following exact structure:
{
  "cases": [
    {
      "brand": "Brand name",
      "campaignName": "Campaign name",
      "geography": "${geography}",
      "timeframe": "2021-2023 (optional)",
      "summary": "Detailed summary of the initiative",
      "productFocus": "Product category (optional)",
      "offerType": "Offer type (optional)",
      "influencers": [
        {
          "name": "Influencer name",
          "platform": "Instagram/YouTube/etc (optional)",
          "handle": "@username (optional)",
          "followers": "1M followers (optional)",
          "positioning": "Fashion/Beauty/etc (optional)"
        }
      ],
      "sources": ["https://source1.com", "https://source2.com"]
    }
  ]
}

Each case MUST include: brand, campaignName, geography, summary, and at least one influencer.`,
    });

    /**
     * 出力データの返却
     * - cases: AIが収集した事例リスト
     * - 他のフィールドは次のステップに引き継ぐためそのまま返す
     */
    return {
      cases: structured.cases,
      metricFocus,
      language,
      includeSources,
    };
  },
});

// ============================================================================
// Step 2: KPIデータの追加
// ============================================================================

/**
 * Step 2: 収集した事例にKPI・数値データを追加
 * 
 * Step 1で収集した基本事例に対して、売上・GMV・CVRなどの
 * 具体的な数値データを追加して情報を充実させます。
 */
const enrichCasesWithMetricsStep = createStep({
  id: 'enrich-cases-with-metrics',
  description: '1 の事例に売上やKPIなどの数値情報を追加',
  
  /**
   * 入力スキーマ: Step 1の出力がそのまま入力になる
   * Mastraは自動的にステップ間でデータを受け渡す
   */
  inputSchema: z.object({
    cases: z.array(baseCaseSchema).min(1),      // Step 1で収集した基本事例
    metricFocus: z.array(z.string()).min(1),    // 注目するKPI(Step 1から引き継ぎ)
    language: languageSchema,                    // 言語設定(Step 1から引き継ぎ)
    includeSources: z.boolean(),                 // ソース含有フラグ(Step 1から引き継ぎ)
  }),
  
  /**
   * 出力スキーマ: メトリクス付き事例
   * baseCaseSchemaからenrichedCaseSchemaに変換
   */
  outputSchema: z.object({
    cases: z.array(enrichedCaseSchema).min(1),  // KPI付き事例リスト
    metricFocus: z.array(z.string()).min(1),    // KPIフォーカス(次のステップに引き継ぎ)
    language: languageSchema,                    // 言語設定(次のステップに引き継ぎ)
    includeSources: z.boolean(),                 // ソース含有フラグ(次のステップに引き継ぎ)
  }),
  
  execute: async ({ inputData }) => {
    const { cases, metricFocus, language, includeSources } = inputData;

    /**
     * AIモデルを使用してKPIデータを抽出・追加
     * Step 1の事例データをJSONとして渡し、メトリクスを追加してもらう
     */
    const structured = await generateStructuredObject<EnrichedCaseList>({
      model: MODEL_NAME,
      schema: enrichedCaseListSchema,  // メトリクス付きスキーマを指定
      system:
        'Act as a revenue operations analyst. Enrich each case with concrete numeric KPIs (sales, GMV, conversion, ROI). Quote actual historical numbers when publicly reported and note the currency/timeframe. If unavailable, write "情報なし" and explain the gap. You MUST respond with a JSON object containing a "cases" array, not a bare array.',
      prompt: `Here is JSON for competitor cases: ${JSON.stringify(cases)}. Focus your numeric extraction on: ${metricFocus.join(', ')}. Write explanations in ${language === 'ja' ? 'Japanese' : 'English'}.

IMPORTANT: Your response must be a JSON object with a "cases" property containing an array, like this:
{
  "cases": [
    {
      "brand": "...",
      "campaignName": "...",
      "geography": "...",
      "summary": "...",
      "influencers": [...],
      "metrics": [
        {
          "metric": "売上 or GMV or CVR",
          "value": "actual value or 情報なし",
          "currency": "JPY/USD (optional)",
          "timeframe": "2021-2023 (optional)",
          "note": "explanation if unavailable"
        }
      ]
    }
  ]
}`,
    });

    /**
     * 出力データの返却
     * - cases: メトリクスが追加された充実した事例リスト
     * - 他のフィールドは次のステップに引き継ぐためそのまま返す
     */
    return {
      cases: structured.cases,
      metricFocus,
      language,
      includeSources,
    };
  },
});

// ============================================================================
// Step 3: 結果の整形とSlack通知
// ============================================================================

/**
 * Step 3: 最終結果の整形とSlack通知
 * 
 * Step 2で得られたKPI付き事例を人間が読みやすい形式に整形し、
 * Slack Webhookを使用してチームに通知します。
 */
const summarizeAndNotifyStep = createStep({
  id: 'summarize-and-notify',
  description: '結果を整形してSlack通知',
  
  /**
   * 入力スキーマ: Step 2の出力
   */
  inputSchema: z.object({
    cases: z.array(enrichedCaseSchema).min(1),  // KPI付き事例リスト
    metricFocus: z.array(z.string()).min(1),    // KPIフォーカス
    language: languageSchema,                    // 言語設定
    includeSources: z.boolean(),                 // ソース含有フラグ
  }),
  
  /**
   * 出力スキーマ: ワークフロー全体の最終出力
   * これがworkflow.createRunAsync().start()の返り値になる
   */
  outputSchema: z.object({
    summary: z.string(),                         // 整形されたサマリーテキスト
    sentToSlack: z.boolean(),                    // Slack送信成功フラグ
    cases: z.array(enrichedCaseSchema).min(1),  // 完全な事例データ
  }),
  
  execute: async ({ inputData }) => {
    const { cases, language, includeSources } = inputData;

    /**
     * サマリーテキストの生成
     * 各事例を番号付きリストとして整形
     */
    const bulletLabel = language === 'ja' ? '主要KPI' : 'Key KPIs';
    const summary = cases
      .map((c, idx) => {
        // 各事例のメトリクスを箇条書きに整形
        const metrics = c.metrics
          .map((metric) => `- ${metric.metric}: ${metric.value}${metric.currency ? ` ${metric.currency}` : ''}${metric.timeframe ? ` (${metric.timeframe})` : ''}${metric.note ? `｜${metric.note}` : ''}`)
          .join('\n');
        // 情報源URLの追加(オプション)
        const sources = includeSources && c.sources?.length ? `\n${language === 'ja' ? '参考' : 'Sources'}: ${c.sources.join(', ')}` : '';
        return `${idx + 1}. ${c.brand} / ${c.campaignName}\n${c.summary}\n${bulletLabel}:\n${metrics}${sources}`;
      })
      .join('\n\n');

    /**
     * Slack通知の実行
     * slackWebhookがnullの場合(環境変数未設定)はスキップ
     */
    let sentToSlack = false;

    if (slackWebhook) {
      /**
       * Slack Block Kit形式でメッセージを構築
       * - header: タイトルブロック
       * - section: 各事例のブロック(最大50ブロックまで)
       */
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
            text: `*${idx + 1}. ${c.brand} — ${c.campaignName}*
${c.summary}
${bulletLabel}: ${c.metrics
              .map((metric) => `${metric.metric}: ${metric.value}`)
              .join(' / ')}`,
          },
        })),
      ].slice(0, 50);  // Slackの制限(最大50ブロック)に対応

      // Webhookでメッセージ送信
      await slackWebhook.send({
        text: summary,    // フォールバック用プレーンテキスト
        blocks,           // リッチなBlock Kit UI
      });

      sentToSlack = true;
    } else {
      console.warn('SLACK_WEBHOOK_URL が設定されていないため、Slack 送信をスキップしました。');
    }

    /**
     * ワークフロー全体の最終出力
     * この返り値がworkflow実行結果として取得できる
     */
    return {
      summary,      // 整形されたサマリー
      sentToSlack,  // Slack送信成功フラグ
      cases,        // 完全な事例データ
    };
  },
});

// ============================================================================
// ワークフロー定義: ステップの連結と実行フロー
// ============================================================================

/**
 * Commerce x Influencer Workflow の定義
 * 
 * Mastraワークフローの構造:
 * 1. createWorkflow()でワークフローオブジェクトを作成
 * 2. .then()でステップを順次連結(チェーン)
 * 3. .commit()でワークフローを確定
 * 
 * データフロー:
 * 入力データ → Step 1 → Step 2 → Step 3 → 出力データ
 * 
 * 各ステップの出力は自動的に次のステップの入力になります。
 * Mastraが型安全性を保証し、スキーマの不一致があればエラーになります。
 */
export const marketResearchWorkflow = createWorkflow({
  id: 'market-research-workflow',
  inputSchema: collectCasesStep.inputSchema,   // 最初のステップの入力スキーマ
  outputSchema: summarizeAndNotifyStep.outputSchema,     // 最後のステップの出力スキーマ
})
  .then(collectCasesStep)      // Step 1: 事例収集
  .then(enrichCasesWithMetricsStep)      // Step 2: KPI追加
  .then(summarizeAndNotifyStep);         // Step 3: 整形&通知

/**
 * ワークフローの確定
 * commit()を呼ぶことでワークフローが実行可能になります
 */
marketResearchWorkflow.commit();

/**
 * 各ステップのエクスポート
 * 個別にステップをテストしたい場合に使用可能
 */
export const steps = {
  collectCasesStep,
  enrichCasesWithMetricsStep,
  summarizeAndNotifyStep,
};

/**
 * TypeScript型定義のエクスポート
 * ワークフローの入出力型を他のファイルで使用するため
 */
export type MarketResearchWorkflowResult = z.infer<typeof summarizeAndNotifyStep.outputSchema>;
export type MarketResearchWorkflowInput = z.infer<typeof collectCasesStep.inputSchema>;
