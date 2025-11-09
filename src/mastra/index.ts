import { Mastra } from '@mastra/core';

import { marketResearchWorkflow } from './workflows/market-research';

export const mastra = new Mastra({
  workflows: {
    marketResearchWorkflow,
  },
});
