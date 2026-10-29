const canonicalId = value => String(value ?? '').replace(/^collection:\/\//, '').replaceAll('-', '');
const withoutMetadata = content => content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '');
const shorten = (value, limit) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

function sourcePage(document, env) {
  const expected = canonicalId(env?.NOTION_DATA_SOURCE_ID);
  if (!expected || canonicalId(document.notion_data_source) !== expected) return null;
  try {
    const url = new URL(document.notion_page);
    if (url.protocol !== 'https:' || url.username || url.password ||
        !['www.notion.so', 'notion.so', 'app.notion.com'].includes(url.hostname)) return null;
    const match = url.pathname.match(/([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i);
    const pageId = match && canonicalId(match[1]).toLowerCase();
    return pageId ? { pageId, url: `https://www.notion.so/${pageId}` } : null;
  } catch { return null; }
}

export function selectMeeting(document, env) {
  if (!/^[CG][A-Z0-9]+$/.test(env.SLACK_MEETING_CHANNEL_ID ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(env.SLACK_MEETING_START_DATE ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(document.date ?? '') ||
      document.date < env.SLACK_MEETING_START_DATE || typeof document.content !== 'string') return null;
  const source = sourcePage(document, env);
  return source && { ...document, ...source };
}

export function formatMeeting(document) {
  const candidates = [];
  let section = '', skipDepth = null;
  const body = withoutMetadata(document.content).replace(/<transcript\b[^>]*>[\s\S]*?<\/transcript>/gi, '');
  for (const raw of body.split(/\r?\n/)) {
    const heading = raw.match(/^\s*(#{1,6})\s+(.+)/);
    if (heading) {
      if (skipDepth !== null && heading[1].length <= skipDepth) skipDepth = null;
      if (/전사|대화 기록|transcript/i.test(heading[2])) skipDepth = heading[1].length;
      section = heading[2];
      continue;
    }
    if (skipDepth !== null || !raw.trim() || /^\s*(>|<|\|?[\s:|-]+\|?$)/.test(raw)) continue;
    const listed = /^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/.test(raw);
    const clean = raw.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, '')
      .replace(/\[\^[^\]]+\]/g, '').replace(/\\([~*_[\]])/g, '$1')
      .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, '')
      .replace(/<[^>]*>/g, '').replace(/^\||\|$/g, '').replace(/\s*\|\s*/g, ' · ').trim();
    if (!clean || clean === document.title || /^(?:원본|출처|일시|검토 상태)\s*[:：]/.test(clean)) continue;
    const priority = /액션|할 일|다음 단계|후속|action/i.test(section) ? 0 :
      /회의\s*개요|overview/i.test(section) ? 1 : listed ? 2 : 3;
    if (priority < 3) candidates.push({ text: shorten(clean, 200), priority });
  }
  const selected = [
    ...candidates.filter(item => item.priority === 1).slice(-2),
    ...candidates.filter(item => item.priority === 0).slice(0, 2),
    ...candidates.filter(item => item.priority === 2).slice(0, candidates.some(item => item.priority < 2) ? 0 : 5),
  ];
  const excerpts = [...new Set(selected.map(item => item.text))].slice(0, 5);
  if (!excerpts.length) return null;
  const review = document.status === 'needs-review'
    ? 'needs-review · 팀원 검토 전 기록이며 현재 합의로 확정할 수 없습니다.'
    : `검토 상태: ${document.status}`;
  const text = `${document.date} ${shorten(String(document.title), 100)}\n${review}\n\n` +
    excerpts.map(line => `• ${line}`).join('\n') + '\n\n전체 내용은 Notion 원본에서 확인해 주세요.';
  return {
    text: `${text}\n${document.url}`,
    blocks: [
      { type: 'section', text: { type: 'plain_text', text, emoji: false } },
      { type: 'section', text: { type: 'mrkdwn', text: `<${document.url}|Notion 회의록 원본 보기>`, verbatim: true } },
    ],
  };
}

export class MeetingShareJob {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.env = env;
    this.queue = Promise.resolve();
  }

  fetch(request) {
    const task = this.queue.then(() => this.publish(request));
    this.queue = task.catch(() => {});
    return task;
  }

  async publish(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/publish') return new Response('Not found', { status: 404 });
    const document = selectMeeting(await request.json(), this.env);
    if (!document || !this.env.SLACK_BOT_TOKEN) return new Response('Disabled or ineligible', { status: 403 });
    const message = formatMeeting(document);
    if (!message) return new Response('No summary', { status: 200 });
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([
      document.title, document.date, document.status, document.url, withoutMetadata(document.content),
    ])));
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const previous = await this.storage.get('publication');
    const channel = this.env.SLACK_MEETING_CHANNEL_ID;
    if (previous && previous.channel !== channel) return new Response('Channel changed; review required', { status: 409 });
    if (previous?.ts && previous.hash === hash) return new Response('Unchanged');
    if (previous && !previous.ts) return new Response('Previous send requires review', { status: 409 });
    // Reserve the first send before calling Slack. An ambiguous failure must not create a second message.
    if (!previous) await this.storage.put('publication', { channel, hash, state: 'sending' });
    const method = previous?.ts ? 'chat.update' : 'chat.postMessage';
    let response, posted;
    try {
      response = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, ...message, ...(previous?.ts ? { ts: previous.ts } : { mrkdwn: false, unfurl_links: false, unfurl_media: false }), parse: 'none', link_names: false }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.status === 429) {
        if (!previous) await this.storage.delete('publication');
        return new Response('Slack rate limited; retry next cron', { status: 503 });
      }
      posted = await response.json();
    } catch { return new Response('Slack result unknown; review required', { status: 503 }); }
    if (!response.ok || !posted.ok) {
      // Explicit rejections can retry at the next cron; server/transport errors may have posted already.
      if (!previous && response.status < 500 && posted.ok === false && !['internal_error', 'fatal_error'].includes(posted.error)) {
        await this.storage.delete('publication');
      }
      return new Response('Slack rejected publication', { status: 503 });
    }
    const ts = previous?.ts ?? posted.ts;
    if (!/^\d{1,16}\.\d{1,8}$/.test(ts ?? '')) return new Response('Slack timestamp missing; review required', { status: 503 });
    await this.storage.put('publication', { channel, hash, ts, state: 'published' });
    return new Response(previous ? 'Updated' : 'Published');
  }
}

export async function shareMeetings(documents, env) {
  if (!env.SLACK_MEETING_CHANNEL_ID || !env.SLACK_BOT_TOKEN) return;
  let failures = 0;
  for (const document of documents) {
    const meeting = selectMeeting(document, env);
    if (!meeting) continue;
    try {
      const job = env.MEETING_SHARES.get(env.MEETING_SHARES.idFromName(meeting.pageId));
      const response = await job.fetch('https://meeting-share/publish', { method: 'POST', body: JSON.stringify(document) });
      if (!response.ok) {
        failures++;
        console.error('team_brain_meeting_share_failed', { pageId: meeting.pageId, status: response.status });
      }
    } catch {
      failures++;
      console.error('team_brain_meeting_share_failed', { pageId: meeting.pageId });
    }
  }
  if (failures) throw new Error(`meeting_share_failed: ${failures}`);
}
