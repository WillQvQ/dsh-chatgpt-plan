import { createRequire } from 'node:module';
const root = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
const require = createRequire(`${root}/package.json`);
export const networkAgents = require('undici');
export const [{ PiAiAdapter }, responses, llm] = await Promise.all([
  import(require.resolve('@deepseek-ai/dsh-llm-pi-ai')),
  import(`${root}/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`),
  import(require.resolve('@deepseek-ai/dsh-llm')),
]);
