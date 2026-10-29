import { SQL, type SqlCursor, type SqlDatabase } from "../src/store.ts";

type Row = Record<string, string | null>;

function cursor(rows: Row[]): SqlCursor {
  return { toArray: () => rows };
}

export function createMemorySql(): SqlDatabase {
  const notes = new Map<string, Row>();
  const events = new Map<string, Row>();
  const announcements = new Map<string, Row>();

  return {
    exec(query: string, ...bindings: unknown[]) {
      const params = bindings.map((value) => (value == null ? null : String(value)));
      if (
        query === SQL.createNotes ||
        query === SQL.createAnnouncements ||
        query === SQL.createEvents
      ) {
        return cursor([]);
      }
      if (query === SQL.selectNoteById) {
        const row = notes.get(params[0] ?? "");
        return cursor(row ? [{ id: row.id }] : []);
      }
      if (query === SQL.insertNote) {
        const [id, path, date, title, status, body, source_url, transcript_path, updated_at] = params;
        if (!id) throw new Error("note id is required");
        notes.set(id, { id, path, date, title, status, body, source_url, transcript_path, updated_at });
        return cursor([]);
      }
      if (query === SQL.selectNotes) {
        return cursor(
          [...notes.values()].sort((a, b) => `${a.date}${a.id}`.localeCompare(`${b.date}${b.id}`)),
        );
      }
      if (query === SQL.selectEvent) {
        const row = events.get(params[0] ?? "");
        return cursor(row ? [{ event_id: row.event_id }] : []);
      }
      if (query === SQL.insertEvent) {
        const id = params[0];
        if (!id) throw new Error("event id is required");
        events.set(id, { event_id: id, received_at: params[1] });
        return cursor([]);
      }
      if (query === SQL.selectUnannounced) {
        return cursor(
          [...notes.values()]
            .filter((note) => !announcements.has(note.id ?? ""))
            .sort((a, b) => `${a.date}${a.id}`.localeCompare(`${b.date}${b.id}`)),
        );
      }
      if (query === SQL.insertAnnouncement) {
        const id = params[0];
        if (!id) throw new Error("announcement id is required");
        announcements.set(id, { id, announced_at: params[1] });
        return cursor([]);
      }
      throw new Error(`unexpected sql: ${query}`);
    },
  };
}
