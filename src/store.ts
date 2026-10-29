import type { MeetingNote, ReviewStatus } from "./types.ts";

export interface SqlCursor {
  toArray(): Record<string, string | null>[];
}

export interface SqlDatabase {
  exec(query: string, ...bindings: unknown[]): SqlCursor;
}

export const SQL = {
  createNotes: `CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  date TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  source_url TEXT,
  transcript_path TEXT,
  updated_at TEXT NOT NULL
)`,
  createAnnouncements: `CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  announced_at TEXT NOT NULL
)`,
  createEvents: `CREATE TABLE IF NOT EXISTS slack_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
)`,
  selectNoteById: `SELECT id FROM notes WHERE id = ?`,
  insertNote: `INSERT OR REPLACE INTO notes (
  id, path, date, title, status, body, source_url, transcript_path, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  selectNotes: `SELECT id, path, date, title, status, body, source_url, transcript_path
FROM notes ORDER BY date, id`,
  selectEvent: `SELECT event_id FROM slack_events WHERE event_id = ?`,
  insertEvent: `INSERT INTO slack_events (event_id, received_at) VALUES (?, ?)`,
  selectUnannounced: `SELECT n.id, n.path, n.date, n.title, n.status, n.body, n.source_url, n.transcript_path
FROM notes n LEFT JOIN announcements a ON a.id = n.id
WHERE a.id IS NULL ORDER BY n.date, n.id`,
  insertAnnouncement: `INSERT OR REPLACE INTO announcements (id, announced_at) VALUES (?, ?)`,
} as const;

export interface NoteStore {
  listNotes(): Promise<MeetingNote[]>;
  upsertNotes(notes: MeetingNote[], nowIso: string): Promise<MeetingNote[]>;
  claimEvent(eventId: string, nowIso: string): Promise<boolean>;
  listUnannounced(): Promise<MeetingNote[]>;
  markAnnounced(ids: string[], nowIso: string): Promise<void>;
}

function asStatus(value: string | null): ReviewStatus {
  return value === "reviewed" ? "reviewed" : "needs-review";
}

function toNote(row: Record<string, string | null>): MeetingNote {
  return {
    id: row.id ?? "",
    path: row.path ?? "",
    date: row.date ?? "",
    title: row.title ?? "",
    status: asStatus(row.status),
    body: row.body ?? "",
    sourceUrl: row.source_url || undefined,
    transcriptPath: row.transcript_path || undefined,
  };
}

export function createSqlNoteStore(sql: SqlDatabase): NoteStore {
  for (const statement of [SQL.createNotes, SQL.createAnnouncements, SQL.createEvents]) {
    sql.exec(statement);
  }

  return {
    async listNotes() {
      return sql.exec(SQL.selectNotes).toArray().map(toNote);
    },
    async upsertNotes(notes, nowIso) {
      const inserted: MeetingNote[] = [];
      for (const note of notes) {
        const existing = sql.exec(SQL.selectNoteById, note.id).toArray();
        sql.exec(
          SQL.insertNote,
          note.id,
          note.path,
          note.date,
          note.title,
          note.status,
          note.body,
          note.sourceUrl ?? null,
          note.transcriptPath ?? null,
          nowIso,
        );
        if (existing.length === 0) inserted.push(note);
      }
      return inserted;
    },
    async claimEvent(eventId, nowIso) {
      if (sql.exec(SQL.selectEvent, eventId).toArray().length > 0) return false;
      sql.exec(SQL.insertEvent, eventId, nowIso);
      return true;
    },
    async listUnannounced() {
      return sql.exec(SQL.selectUnannounced).toArray().map(toNote);
    },
    async markAnnounced(ids, nowIso) {
      for (const id of ids) sql.exec(SQL.insertAnnouncement, id, nowIso);
    },
  };
}

export async function seedSamples(store: NoteStore, notes: MeetingNote[], nowIso: string): Promise<void> {
  const inserted = await store.upsertNotes(notes, nowIso);
  await store.markAnnounced(
    inserted.map((note) => note.id),
    nowIso,
  );
}
