import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { nowMonotonicUs } from "../core/clock.js";

export interface DomainEvent {
  kind: string;
  signal?: string;
  actor?: string;
  payload?: unknown;
}

export interface LoggedEvent extends DomainEvent {
  session_id: string;
  n: number;
  t_us: number;
}

export interface SessionInfo {
  id: string;
  configHash: string;
  startedAtWall: string;
  tickMs: number;
}

// SQLite en WAL, persistido antes de enviar por WebSocket
// (docs/implementacion/observabilidad.md). "n" es monotono POR SESION, no
// global: cada recarga de configuracion abre una sesion nueva
// (docs/ui/editor.md#la-recarga-arranca-sesion-nueva) via beginSession(),
// sin reabrir el fichero SQLite.
export class EventLog {
  private readonly db: Database.Database;
  private readonly insertEvent: Database.Statement;
  private readonly insertSession: Database.Statement;
  private session!: SessionInfo;
  private nextN = 1;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        config_hash TEXT NOT NULL,
        started_at_wall TEXT NOT NULL,
        tick_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        n INTEGER NOT NULL,
        t_us INTEGER NOT NULL,
        kind TEXT NOT NULL,
        signal TEXT,
        actor TEXT,
        payload TEXT,
        PRIMARY KEY (session_id, n)
      );
      CREATE INDEX IF NOT EXISTS idx_events_t ON events(session_id, t_us);
      CREATE INDEX IF NOT EXISTS idx_events_sig ON events(session_id, signal, t_us);
    `);

    this.insertSession = this.db.prepare(
      "INSERT INTO sessions (id, config_hash, started_at_wall, tick_ms) VALUES (?, ?, ?, ?)",
    );
    this.insertEvent = this.db.prepare(
      "INSERT INTO events (session_id, n, t_us, kind, signal, actor, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
  }

  // Abre una sesion: nueva fila en "sessions", "n" reiniciado a 1. Debe
  // llamarse una vez antes de usar log()/getSince(), y de nuevo en cada
  // recarga de configuracion (docs/ui/editor.md#la-recarga-arranca-sesion-nueva).
  beginSession(configHash: string, tickMs: number): SessionInfo {
    this.session = {
      id: randomUUID(),
      configHash,
      startedAtWall: new Date().toISOString(),
      tickMs,
    };
    this.nextN = 1;
    this.insertSession.run(
      this.session.id,
      this.session.configHash,
      this.session.startedAtWall,
      this.session.tickMs,
    );
    return this.session;
  }

  get sessionInfo(): SessionInfo {
    return this.session;
  }

  // Insercion de una fila: microsegundos con better-sqlite3+WAL, no el lazo
  // de tick que este metodo nunca toca (AGENTS.md: el tick nunca bloquea).
  log(event: DomainEvent): LoggedEvent {
    const n = this.nextN++;
    const t_us = nowMonotonicUs();
    const payloadJson = event.payload !== undefined ? JSON.stringify(event.payload) : null;
    this.insertEvent.run(
      this.session.id,
      n,
      t_us,
      event.kind,
      event.signal ?? null,
      event.actor ?? null,
      payloadJson,
    );
    return { ...event, session_id: this.session.id, n, t_us };
  }

  getSince(n: number): LoggedEvent[] {
    const rows = this.db
      .prepare(
        "SELECT session_id, n, t_us, kind, signal, actor, payload FROM events WHERE session_id = ? AND n > ? ORDER BY n ASC",
      )
      .all(this.session.id, n) as Array<{
      session_id: string;
      n: number;
      t_us: number;
      kind: string;
      signal: string | null;
      actor: string | null;
      payload: string | null;
    }>;
    return rows.map((r) => ({
      session_id: r.session_id,
      n: r.n,
      t_us: r.t_us,
      kind: r.kind,
      signal: r.signal ?? undefined,
      actor: r.actor ?? undefined,
      payload: r.payload ? JSON.parse(r.payload) : undefined,
    }));
  }

  // Para la descarga de sesion (docs/ui/operacion.md#registro-de-eventos-en-vivo).
  exportSessionEvents(): LoggedEvent[] {
    return this.getSince(0);
  }

  close(): void {
    this.db.close();
  }
}
