import { DurableObject } from "cloudflare:workers";

import { createSqlNoteStore, seedSamples as seedSampleNotes, type NoteStore } from "./store.ts";
import type { Env, MeetingNote } from "./types.ts";

export class TeamBrain extends DurableObject<Env> {
  #store: NoteStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#store = createSqlNoteStore(ctx.storage.sql);
  }

  listNotes(): Promise<MeetingNote[]> {
    return this.#store.listNotes();
  }

  upsertNotes(notes: MeetingNote[], nowIso: string): Promise<MeetingNote[]> {
    return this.#store.upsertNotes(notes, nowIso);
  }

  claimEvent(eventId: string, nowIso: string): Promise<boolean> {
    return this.#store.claimEvent(eventId, nowIso);
  }

  listUnannounced(): Promise<MeetingNote[]> {
    return this.#store.listUnannounced();
  }

  markAnnounced(ids: string[], nowIso: string): Promise<void> {
    return this.#store.markAnnounced(ids, nowIso);
  }

  async seedSamples(notes: MeetingNote[], nowIso: string): Promise<void> {
    await seedSampleNotes(this.#store, notes, nowIso);
  }
}
