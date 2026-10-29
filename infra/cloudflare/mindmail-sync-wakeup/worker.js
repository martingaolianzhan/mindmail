const worker = {
  /**
   * Owner-configured later: MINDMAIL_SYNC_URL is a normal variable; the other
   * bindings are separate secrets for MindMail auth and Vercel protection bypass.
   * @param {unknown} _controller
   * @param {{ MINDMAIL_SYNC_URL: string, MINDMAIL_CRON_SECRET: string, VERCEL_AUTOMATION_BYPASS_SECRET: string }} env
   */
  async scheduled(_controller, env) {
    const bypassSecret = env.VERCEL_AUTOMATION_BYPASS_SECRET;
    let target;
    try {
      target = new URL(env.MINDMAIL_SYNC_URL);
    } catch {
      throw new Error("MindMail sync wake-up failed.");
    }
    if (
      target.protocol !== "https:" ||
      target.pathname !== "/api/cron/sync" ||
      target.username || target.password || target.search || target.hash ||
      !env.MINDMAIL_CRON_SECRET || /\s/.test(env.MINDMAIL_CRON_SECRET) ||
      !bypassSecret || /\s/.test(bypassSecret) ||
      Array.from(bypassSecret).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    ) {
      throw new Error("MindMail sync wake-up failed.");
    }

    let response;
    try {
      response = await fetch(target.toString(), {
        method: "POST",
        redirect: "manual",
        headers: {
          Authorization: `Bearer ${env.MINDMAIL_CRON_SECRET}`,
          "x-vercel-protection-bypass": bypassSecret,
        },
      });
    } catch {
      throw new Error("MindMail sync wake-up failed.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error("MindMail sync wake-up failed.");
    }
  },
};

export default worker;
