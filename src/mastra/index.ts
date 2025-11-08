import { Mastra } from '@mastra/core';

import { commerceInfluencerWorkflow } from './workflows/commerce-influencer';

export const mastra = new Mastra({
  workflows: {
    commerceInfluencerWorkflow,
  },
});
