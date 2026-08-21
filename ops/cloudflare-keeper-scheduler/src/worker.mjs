import { runScheduledBackup } from './dispatch.mjs';

export default {
  scheduled(controller, env, context) {
    const task = runScheduledBackup({
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      token: env.CLOUDFLARE_GITHUB_TOKEN,
    });
    context.waitUntil(task);
  },
};
