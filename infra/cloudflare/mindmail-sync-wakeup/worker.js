const worker = {
  /**
   * @param {unknown} _controller
   * @param {{ MINDMAIL_SYNC_URL: string, MINDMAIL_CRON_SECRET: string }} env
   */
  async scheduled(_controller, env) {
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
      !env.MINDMAIL_CRON_SECRET || /\s/.test(env.MINDMAIL_CRON_SECRET)
    ) {
      throw new Error("MindMail sync wake-up failed.");
    }

    let response;
    try {
      response = await fetch(target.toString(), {
        method: "POST",
        redirect: "manual",
        headers: { Authorization: `Bearer ${env.MINDMAIL_CRON_SECRET}` },
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
