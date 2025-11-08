import './env';

import {
  commerceInfluencerWorkflow,
  type CommerceInfluencerWorkflowInput,
  type CommerceInfluencerWorkflowResult,
} from './mastra/workflows/commerce-influencer';

const defaultInput: CommerceInfluencerWorkflowInput = {
  focusKeyword: 'コマース x インフルエンサー',
  geography: 'Japan',
  minExamples: 3,
  language: 'ja',
  metricFocus: ['売上', 'GMV', 'CVR'],
  includeSources: true,
};

export async function runCommerceInfluencerWorkflow(
  overrides: Partial<CommerceInfluencerWorkflowInput> = {}
): Promise<CommerceInfluencerWorkflowResult> {
  const input = { ...defaultInput, ...overrides } as CommerceInfluencerWorkflowInput;
  const run = await commerceInfluencerWorkflow.createRunAsync();
  const execution = await run.start({ inputData: input });

  if (execution.status !== 'success') {
    if (execution.status === 'failed') {
      throw execution.error;
    }

    throw new Error('Workflow suspended before completion. Check the Mastra dashboard for details.');
  }

  console.log('--- Commerce x Influencer Workflow Result ---');
  console.log(JSON.stringify(execution.result, null, 2));

  return execution.result;
}

if (require.main === module) {
  const customArg = process.argv[2];

  const overrides = customArg ? (JSON.parse(customArg) as Partial<CommerceInfluencerWorkflowInput>) : undefined;

  runCommerceInfluencerWorkflow(overrides).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
