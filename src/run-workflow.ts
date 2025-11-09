/**
 * Market Research Workflow Runner (汎用マーケットリサーチワークフロー実行ファイル)
 *
 * このファイルはワークフローを実行するためのエントリーポイントです。
 *
 * 使用方法:
 * 1. デフォルトパラメータで実行:
 *    npm run workflow
 *
 * 2. focusKeywordを指定して実行:
 *    npm run workflow '{"focusKeyword": "SaaS x AI"}'
 *
 * 3. 複数パラメータを指定:
 *    npm run workflow '{"focusKeyword": "D2C x SNS", "geography": "USA", "language": "en"}'
 */

import './env';

import {
  marketResearchWorkflow,
  type MarketResearchWorkflowInput,
  type MarketResearchWorkflowResult,
} from './mastra/workflows/market-research';

/**
 * デフォルト入力パラメータ
 * コマンドライン引数で上書き可能
 */
const defaultInput: MarketResearchWorkflowInput = {
  focusKeyword: 'コマース x インフルエンサー',  // デフォルトキーワード
  geography: 'Japan',
  minExamples: 3,
  language: 'ja',
  metricFocus: ['売上', 'GMV', 'CVR'],
  includeSources: true,
};

/**
 * マーケットリサーチワークフローを実行
 *
 * @param overrides - デフォルト値を上書きするパラメータ
 * @returns ワークフローの実行結果
 */
export async function runMarketResearchWorkflow(
  overrides: Partial<MarketResearchWorkflowInput> = {}
): Promise<MarketResearchWorkflowResult> {
  // デフォルト値とユーザー指定値をマージ
  const input = { ...defaultInput, ...overrides } as MarketResearchWorkflowInput;

  console.log('='.repeat(60));
  console.log('Market Research Workflow - Starting');
  console.log('='.repeat(60));
  console.log('Focus Keyword:', input.focusKeyword);
  console.log('Geography:', input.geography);
  console.log('Language:', input.language);
  console.log('Min Examples:', input.minExamples);
  console.log('='.repeat(60));

  // ワークフローの実行
  const run = await marketResearchWorkflow.createRunAsync();
  const execution = await run.start({ inputData: input });

  // 実行結果のチェック
  if (execution.status !== 'success') {
    if (execution.status === 'failed') {
      throw execution.error;
    }

    throw new Error('Workflow suspended before completion. Check the Mastra dashboard for details.');
  }

  // 結果の表示
  console.log('\n--- Market Research Workflow Result ---');
  console.log(JSON.stringify(execution.result, null, 2));

  return execution.result;
}

/**
 * コマンドライン実行時のエントリーポイント
 *
 * 引数としてJSONオブジェクトを受け取り、デフォルト値を上書きします
 * 例: npm run workflow '{"focusKeyword": "AI x Healthcare"}'
 */
if (require.main === module) {
  const customArg = process.argv[2];

  const overrides = customArg ? (JSON.parse(customArg) as Partial<MarketResearchWorkflowInput>) : undefined;

  runMarketResearchWorkflow(overrides).catch((error) => {
    console.error('\n❌ Workflow execution failed:');
    console.error(error);
    process.exitCode = 1;
  });
}
