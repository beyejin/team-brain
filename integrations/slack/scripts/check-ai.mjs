import { getPlatformProxy } from 'wrangler';
import { answerQuestion } from '../src/worker.mjs';

// 실제 Cloudflare AI 호출입니다. Slack에는 보내지 않지만 AI 사용량이 발생합니다.
const platform = await getPlatformProxy({ configPath: './wrangler.jsonc', persist: false });
try {
  const AI = {
    async run(...arguments_) {
      const result = await platform.env.AI.run(...arguments_);
      if (process.argv.includes('--inspect-shape')) {
        console.log(JSON.stringify({
          keys: Object.keys(result ?? {}),
          responseType: typeof result?.response,
          responseKeys: result?.response && typeof result.response === 'object' ? Object.keys(result.response) : undefined,
          choices: result?.choices?.map((choice) => ({
            finishReason: choice.finish_reason,
            messageKeys: Object.keys(choice.message ?? {}),
            contentType: typeof choice.message?.content,
            contentLength: typeof choice.message?.content === 'string' ? choice.message.content.length : undefined,
          })),
          output: result?.output?.map((item) => ({ type: item.type, contentTypes: item.content?.map((part) => part.type) })),
        }, null, 2));
      }
      return result;
    },
  };
  const reply = await answerQuestion({ text: '팀 이름이 확정됐나요?' }, { AI });
  console.log(JSON.stringify(reply, null, 2));
} finally {
  await platform.dispose();
}
