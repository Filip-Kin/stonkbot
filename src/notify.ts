// #region notify
// Push notifications to ntfy and/or Home Assistant. Fails soft: a broken alert
// channel must never crash the trader. Sends to every configured channel.
import { config } from "./config";

// A short single buzz. Android companion-app format: comma-separated
// milliseconds (delay, vibrate, delay, ...). One 120ms pulse, nothing more.
const SHORT_BUZZ = "0, 120";

export interface NotifyOpts {
  tags?: string[]; // ntfy emoji tags, e.g. ["moneybag"]
  priority?: number; // ntfy priority 1..5 (default 3)
}

export async function notify(title: string, message: string, opts: NotifyOpts = {}): Promise<void> {
  const sent = await Promise.all([sendNtfy(title, message, opts), sendHa(title, message)]);
  if (!sent.some(Boolean)) console.log(`[notify:noop] ${title} - ${message}`);
}

async function sendNtfy(title: string, message: string, opts: NotifyOpts): Promise<boolean> {
  if (!config.ntfy.topic) return false;
  const headers: Record<string, string> = { Title: `stonkbot: ${title}` };
  if (opts.tags?.length) headers.Tags = opts.tags.join(",");
  if (opts.priority) headers.Priority = String(opts.priority);
  // Tapping the notification opens the live dashboard.
  headers.Click = config.dashboardUrl;
  if (config.ntfy.token) headers.Authorization = `Bearer ${config.ntfy.token}`;
  try {
    const res = await fetch(`${config.ntfy.url}/${config.ntfy.topic}`, {
      method: "POST",
      headers,
      body: message,
    });
    if (!res.ok) console.error(`[notify] ntfy ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`[notify] ntfy failed:`, err);
  }
  return true;
}

async function sendHa(title: string, message: string): Promise<boolean> {
  if (!config.ha.token) return false;
  const service = config.ha.notifyService.replace("notify.", "");
  const url = `${config.ha.baseUrl}/api/services/notify/${service}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.ha.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        title: `stonkbot: ${title}`,
        message,
        // Android companion app: open the dashboard on tap, and use a single
        // short buzz instead of the default (longer) notification vibration.
        data: { clickAction: config.dashboardUrl, url: config.dashboardUrl, vibrationPattern: SHORT_BUZZ },
      }),
    });
    if (!res.ok) console.error(`[notify] HA ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`[notify] HA failed:`, err);
  }
  return true;
}
// #endregion
