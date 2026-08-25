import { ref, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { toMongoCollectionKind } from "@/lib/sidebar/mongoCollectionMutation";
import type { CollectionInfo, ConnectionConfig } from "@/types/database";
import type { QuickOpenItem } from "@/composables/useQuickOpen";
import type { MongoQuickOpenItem } from "@/lib/app/mongoQuickOpenNavigation";

// Bound fan-out in both dimensions, mirroring REMOTE_SEARCH_MAX_REQUESTS /
// REMOTE_SEARCH_CONCURRENCY in useQuickOpen.ts: MAX_CONNECTIONS caps how many
// mongo connections a single search scans, MAX_DATABASES_PER_CONNECTION caps
// how many databases within one connection get their collections listed.
//
// Raised from 8 to 50: measured against a live cluster, a single connection
// had 38 databases, and the database holding the searched-for collection
// ("person", in "risk-management") sat at index 32 — past the old cap, so it
// was never scanned and the search found nothing. 50 comfortably covers that
// measured reality with headroom for growth.
const MAX_CONNECTIONS = 8;
const MAX_DATABASES_PER_CONNECTION = 50;
const MAX_ITEMS = 100;
// How long a listed database name stays trusted. Short enough that a database
// created since the last search shows up within a few seconds; long enough
// that a burst of keystrokes still hits the cache. Collections use a dynamic
// TTL instead — see computeCollectionsCacheTtlMs below — but databases stay
// on this fixed floor: listing databases is one cheap call per connection,
// and freshness here matters for discovering newly created databases.
const DATABASE_CACHE_TTL_MS = 30_000;

// A full collections sweep costs one listCollections call per database
// scanned, so holding the collections cache proportionally longer as a
// connection's database count grows keeps the amortised refresh cost roughly
// flat as a deployment grows, instead of an ever-growing sweep repeating on
// the same short fixed TTL. The 30s floor preserves today's freshness for
// small deployments; the 300s (5 minute) ceiling stops a renamed or dropped
// collection from staying stale indefinitely on a very large deployment. At
// the measured 38-database production connection this yields 114s — close to
// the flat 120s fallback considered for deployments where this isn't
// derivable.
const COLLECTIONS_TTL_PER_DATABASE_MS = 3_000;
const COLLECTIONS_TTL_FLOOR_MS = 30_000;
const COLLECTIONS_TTL_CEILING_MS = 300_000;

export function computeCollectionsCacheTtlMs(databaseCount: number): number {
  return Math.min(Math.max(databaseCount * COLLECTIONS_TTL_PER_DATABASE_MS, COLLECTIONS_TTL_FLOOR_MS), COLLECTIONS_TTL_CEILING_MS);
}

// How many loadCollections calls run concurrently per connection once the
// target loop below is parallelised. Bounded (not a plain Promise.all over
// all targets) because MAX_CONNECTIONS * MAX_DATABASES_PER_CONNECTION is now
// 8 * 50 = 400 potential concurrent metadata calls if every connection fanned
// out unbounded at once; 8 per connection keeps a single cold-cache keystroke
// from spiking that high while still cutting a 50-database cold sweep from up
// to 50 sequential round trips down to ceil(50 / 8) batches.
//
// This bound is per `search()` invocation, not a global ceiling — it is NOT
// true that the app-wide peak is MAX_CONNECTIONS * COLLECTIONS_LOAD_CONCURRENCY
// (8 * 8 = 64). useQuickOpen.ts calls `mongoSource.search` synchronously on
// every keystroke with no debounce (unlike the SQL remote path a few lines
// below it, which debounces at REMOTE_SEARCH_DEBOUNCE_MS = 180ms), so several
// `search()` calls can be in flight at once, each running its own 8-per-
// connection pool. Overlapping searches mostly track each other closely
// because they share the same in-flight cache, but once their target orders
// diverge (as the needle grows and name-matched databases shift between
// searches), a single connection's aggregate in-flight count can exceed 8 —
// realistically by roughly `8 + k` for `k` overlapping searches, not a hard
// multiple of 8.
const COLLECTIONS_LOAD_CONCURRENCY = 8;

type CacheEntry<T> = { value: Promise<T>; storedAt: number };

/**
 * Drop what the sidebar tree also hides (see `loadMongoCollections` in
 * connectionStore.ts): GridFS buckets are not openable as collections, and
 * their `${bucket}.files` / `${bucket}.chunks` backing collections are MongoDB
 * internals the user never wants to browse directly.
 */
function visibleCollections(collections: CollectionInfo[]): CollectionInfo[] {
  const bucketNames = collections.filter((collection) => collection.kind === "bucket" && collection.bucketName).map((collection) => collection.bucketName as string);
  const hidden = new Set(bucketNames.flatMap((bucketName) => [`${bucketName}.files`, `${bucketName}.chunks`]));
  return collections.filter((collection) => collection.kind !== "bucket" && !hidden.has(collection.name));
}

type MongoSource = {
  items: Ref<QuickOpenItem[]>;
  search(query: string): Promise<void>;
  reset(): void;
};

/**
 * Quick-open candidates for MongoDB.
 *
 * MongoDB sits in `REMOTE_SEARCH_UNSUPPORTED_TYPES` in useQuickOpen because the
 * generic remote search goes through SQL metadata endpoints that do not apply
 * here. This source uses the dedicated mongo endpoints instead, so databases
 * and collections are searchable without expanding the sidebar tree first.
 *
 * Id shapes mirror useQuickOpen's conventions for databases and remote tables
 * (`db-${connId}-${database}`, `table-${connId}-${database}-${schema}-${name}`
 * with an empty schema) so dedup via `quickOpenItemKey` would line up correctly
 * *if* mongo tree nodes ever start producing quick-open items. As of this
 * writing they do not: mongo tree nodes use `type: "mongo-db"` /
 * `"mongo-collection"` (see connectionStore.ts), and useQuickOpen's
 * `processDatabaseTreeNodes` has no branch for either type, so there is
 * nothing to dedup against yet.
 *
 * The `database` / `table` types are chosen for matching and dedup only — they
 * do NOT mean the generic SQL open handlers apply. Opening a MongoDB item goes
 * through `openMongoQuickOpenTarget` in lib/app/mongoQuickOpenNavigation.ts.
 */
export function useMongoQuickOpenSource(): MongoSource {
  const connectionStore = useConnectionStore();
  const items = ref<QuickOpenItem[]>([]);

  // Cache the in-flight promise (not just its resolved value) so repeated
  // keystrokes against the same cold connection/database reuse one request
  // instead of piling up. A rejection evicts its entry so a transient failure
  // does not poison the cache forever — the next search retries.
  //
  // Entries expire after the given ttlMs (per-call, not a shared module-level
  // constant — see computeCollectionsCacheTtlMs). QuickOpenDialog is mounted
  // for the whole app lifetime (App.vue binds `:open`, not `v-if`), so this
  // composable is instantiated once and an unbounded cache would keep serving
  // names from the first search forever — missing collections created since,
  // and offering dropped ones that then fail to open.
  const databasesByConnection = new Map<string, CacheEntry<string[]>>();
  const collectionsByDatabase = new Map<string, CacheEntry<CollectionInfo[]>>();
  let generation = 0;

  function cached<T>(store: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>, ttlMs: number): Promise<T> {
    const entry = store.get(key);
    if (entry && Date.now() - entry.storedAt < ttlMs) return entry.value;
    const value = load();
    store.set(key, { value, storedAt: Date.now() });
    value.catch(() => {
      if (store.get(key)?.value === value) store.delete(key);
    });
    return value;
  }

  function loadDatabases(connectionId: string): Promise<string[]> {
    return cached(databasesByConnection, connectionId, () => api.mongoListDatabases(connectionId), DATABASE_CACHE_TTL_MS);
  }

  function loadCollections(connectionId: string, database: string, ttlMs: number): Promise<CollectionInfo[]> {
    return cached(collectionsByDatabase, `${connectionId}:${database}`, () => api.mongoListCollections(connectionId, database).then(visibleCollections), ttlMs);
  }

  // Runs `task` over `entries` with at most `concurrency` calls in flight at
  // once, returning settled results indexed by the item's original position
  // (not push-on-resolve) so callers can flatten in source order regardless
  // of which call happens to finish first. Each item's outcome is captured
  // independently, so one rejecting task does not abort the others — unlike a
  // bare `Promise.all`, which would reject as a whole the instant any one
  // task rejected.
  async function mapWithConcurrencyLimit<T, R>(entries: T[], concurrency: number, task: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
    const results: PromiseSettledResult<R>[] = new Array(entries.length);
    let nextIndex = 0;
    async function worker(): Promise<void> {
      for (;;) {
        const index = nextIndex++;
        if (index >= entries.length) return;
        try {
          results[index] = { status: "fulfilled", value: await task(entries[index], index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }
    // Guard concurrency <= 0: Math.min(0-or-negative, entries.length) would
    // spawn zero workers, leaving `results` a sparse array of holes and every
    // caller's `result.status` read throwing on `undefined`. Unreachable today
    // (concurrency is the hard-coded COLLECTIONS_LOAD_CONCURRENCY below), but
    // cheap to close off in case this helper is ever reused with a configurable
    // value.
    await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), entries.length) }, worker));
    return results;
  }

  function databaseItem(connectionId: string, connectionName: string, database: string): QuickOpenItem {
    return {
      id: `db-${connectionId}-${database}`,
      type: "database",
      label: database,
      description: connectionName,
      connectionId,
      database,
      connectionName,
      searchText: `${connectionName} ${database}`,
    };
  }

  function collectionItem(connectionId: string, connectionName: string, database: string, collection: CollectionInfo): MongoQuickOpenItem {
    return {
      // Matches the id shape useQuickOpen builds for remote tables:
      // `table-${connectionId}-${database}-${schema}-${name}`, schema empty.
      id: `table-${connectionId}-${database}--${collection.name}`,
      type: "table",
      label: collection.name,
      description: `${connectionName} / ${database}`,
      connectionId,
      database,
      tableName: collection.name,
      connectionName,
      searchText: `${connectionName} ${database} ${collection.name}`,
      // Carried so the open path can tell a view/timeseries from a plain
      // collection without re-listing; see mongoQuickOpenNavigation.ts.
      mongoCollectionKind: toMongoCollectionKind(collection.kind),
    };
  }

  async function searchConnection(connectionId: string, connectionName: string, needle: string): Promise<QuickOpenItem[]> {
    const databases = await loadDatabases(connectionId);
    const collectionsTtlMs = computeCollectionsCacheTtlMs(databases.length);
    const collected: QuickOpenItem[] = [];

    // Single partition pass: computes the "does this database's name match"
    // predicate exactly once per database (previously it was evaluated up to
    // three times), builds nameMatched/remaining directly instead of deriving
    // remaining via an O(n·m) `nameMatched.includes(database)` re-scan, and
    // sidesteps the duplicate-name edge case that re-scan had (a repeated name
    // would get excluded from remaining entirely instead of just from the one
    // matching slot).
    const nameMatched: string[] = [];
    const remaining: string[] = [];
    for (const database of databases) {
      if (database.toLowerCase().includes(needle)) {
        collected.push(databaseItem(connectionId, connectionName, database));
        nameMatched.push(database);
      } else {
        remaining.push(database);
      }
    }

    // Prioritize databases whose name matches, but still fill remaining slots
    // with the rest so a collection-only query (e.g. a collection living in a
    // database whose own name doesn't match) isn't starved just because some
    // *other* database's name happened to match the same needle. This is
    // still bounded by MAX_DATABASES_PER_CONNECTION: if nameMatched.length
    // alone reaches the cap, `remaining` is squeezed out entirely and a
    // collection living only in an unmatched database goes unreached again —
    // an existing limit of the cap, not something this ordering fixes.
    const targets = [...nameMatched, ...remaining].slice(0, MAX_DATABASES_PER_CONNECTION);

    // Bounded concurrency, not sequential and not a plain Promise.all. A cold
    // sweep now issues one loadCollections call per target regardless of how
    // much MAX_ITEMS has already been filled elsewhere or which generation is
    // current, and with the cap raised to 50 that made a fully sequential
    // sweep 38-50 round trips deep on a real deployment — real-cluster latency
    // data (the 38-database production connection this fix was built for)
    // justifies parallelising it. A bare Promise.all over all targets was
    // rejected for the reason the old comment here already gave: it would fan
    // out to up to MAX_CONNECTIONS * MAX_DATABASES_PER_CONNECTION (8*50 = 400)
    // concurrent metadata calls on a cold-cache keystroke. Capping each
    // connection's own fan-out at COLLECTIONS_LOAD_CONCURRENCY keeps that
    // single-invocation fan-out bounded (see the note on COLLECTIONS_LOAD_
    // CONCURRENCY above: this cap is per `search()` call, not a global
    // semaphore, since `search()` itself is not debounced) while still cutting
    // a 50-database sweep to a handful of sequential batches instead of 50.
    // mapWithConcurrencyLimit indexes
    // results by target position (not push-on-resolve) so ordering here stays
    // identical to what the old sequential loop produced, and it settles each
    // target independently so one rejecting database can't wipe out
    // collections already found for the others on this connection — an
    // improvement over the old loop, where an unhandled rejection from
    // loadCollections propagated out of this whole function and the caller's
    // catch discarded every result collected for this connection so far.
    const settled = await mapWithConcurrencyLimit(targets, COLLECTIONS_LOAD_CONCURRENCY, (database) => loadCollections(connectionId, database, collectionsTtlMs));
    for (const [index, result] of settled.entries()) {
      if (result.status === "rejected") continue;
      const database = targets[index];
      for (const collection of result.value) {
        if (collection.name.toLowerCase().includes(needle)) collected.push(collectionItem(connectionId, connectionName, database, collection));
      }
    }

    return collected;
  }

  // Same priority as remoteSearchContexts() in useQuickOpen.ts: the active
  // connection first, then connected ones, then the rest — so when there are
  // more mongo connections than MAX_CONNECTIONS, the ones the user is most
  // likely to care about win the cap.
  function orderedMongoConnections(): ConnectionConfig[] {
    const mongoConnections = connectionStore.connections.filter((connection) => connection.db_type === "mongodb");
    const priority = (connection: ConnectionConfig): number => {
      if (connection.id === connectionStore.activeConnectionId) return 0;
      if (connectionStore.connectedIds.has(connection.id)) return 1;
      return 2;
    };
    return [...mongoConnections].sort((left, right) => priority(left) - priority(right)).slice(0, MAX_CONNECTIONS);
  }

  async function search(query: string): Promise<void> {
    const needle = query.trim().toLowerCase();
    const current = ++generation;
    items.value = [];
    if (!needle) return;

    const mongoConnections = orderedMongoConnections();
    if (mongoConnections.length === 0) return;

    // One slot per connection, filled in as each settles. Rendering after
    // every settle (not just once at the end) means a slow or hung connection
    // never delays the healthy ones from showing up.
    const groups: QuickOpenItem[][] = mongoConnections.map(() => []);

    function render(): void {
      if (current !== generation) return;
      items.value = groups.flat().slice(0, MAX_ITEMS);
    }

    await Promise.allSettled(
      mongoConnections.map(async (connection, index) => {
        try {
          const results = await searchConnection(connection.id, connection.name, needle);
          groups[index] = results;
          render();
        } catch {
          // A disconnected or unreachable mongo must not break quick-open.
        }
      }),
    );
  }

  function reset(): void {
    generation++;
    items.value = [];
  }

  return { items, search, reset };
}
