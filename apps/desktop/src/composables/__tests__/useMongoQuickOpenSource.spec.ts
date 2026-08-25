import { beforeEach, describe, expect, it, vi } from "vitest";

const mongoListDatabases = vi.fn();
const mongoListCollections = vi.fn();

vi.mock("@/lib/backend/api", () => ({
  mongoListDatabases: (...args: unknown[]) => mongoListDatabases(...args),
  mongoListCollections: (...args: unknown[]) => mongoListCollections(...args),
}));

const connections = vi.hoisted(() => ({ value: [] as any[] }));

// activeConnectionId/connectedIds back the active-first, connected-next
// priority useQuickOpen.ts's remoteSearchContexts() uses. Fixed defaults are
// enough here: no test below depends on reordering, only on the cap.
vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => ({
    get connections() {
      return connections.value;
    },
    activeConnectionId: null,
    connectedIds: new Set<string>(),
  }),
}));

import { computeCollectionsCacheTtlMs, useMongoQuickOpenSource } from "@/composables/useMongoQuickOpenSource";

describe("useMongoQuickOpenSource", () => {
  beforeEach(() => {
    mongoListDatabases.mockReset();
    mongoListCollections.mockReset();
    connections.value = [
      { id: "c1", name: "生产 Mongo", db_type: "mongodb" },
      { id: "c2", name: "本地 PG", db_type: "postgres" },
    ];
  });

  it("ignores connections that are not mongodb", async () => {
    mongoListDatabases.mockResolvedValue(["shop"]);
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    await source.search("shop");

    expect(mongoListDatabases).toHaveBeenCalledTimes(1);
    expect(mongoListDatabases).toHaveBeenCalledWith("c1");
  });

  it("produces a database item for every matching database", async () => {
    mongoListDatabases.mockResolvedValue(["shop", "logs"]);
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    await source.search("shop");

    const databaseItems = source.items.value.filter((item) => item.type === "database");
    expect(databaseItems).toHaveLength(1);
    expect(databaseItems[0]).toMatchObject({
      id: "db-c1-shop",
      type: "database",
      label: "shop",
      connectionId: "c1",
      database: "shop",
    });
  });

  // `type: "table"` is for matching and dedup only. Opening one goes through
  // openMongoQuickOpenTarget (lib/app/mongoQuickOpenNavigation.ts), NOT the
  // generic SQL open path.
  it("produces collection items typed as table, carrying the collection kind", async () => {
    mongoListDatabases.mockResolvedValue(["shop"]);
    mongoListCollections.mockResolvedValue([
      { name: "orders", id: "orders" },
      { name: "orders_view", id: "orders_view", kind: "view" },
    ]);

    const source = useMongoQuickOpenSource();
    await source.search("ord");

    const collectionItems = source.items.value.filter((item) => item.type === "table");
    expect(collectionItems).toHaveLength(2);
    expect(collectionItems[0]).toMatchObject({
      id: "table-c1-shop--orders",
      type: "table",
      label: "orders",
      connectionId: "c1",
      database: "shop",
      tableName: "orders",
      mongoCollectionKind: "collection",
    });
    expect(collectionItems[1]).toMatchObject({ label: "orders_view", mongoCollectionKind: "view" });
  });

  // Mirrors the sidebar tree filter in connectionStore.loadMongoCollections:
  // a bucket is not openable as a collection, and its .files/.chunks backing
  // collections are MongoDB internals.
  it("hides GridFS buckets and their .files/.chunks backing collections", async () => {
    mongoListDatabases.mockResolvedValue(["shop"]);
    mongoListCollections.mockResolvedValue([
      { name: "fs", id: "fs", kind: "bucket", bucketName: "fs" },
      { name: "fs.files", id: "fs.files" },
      { name: "fs.chunks", id: "fs.chunks" },
      { name: "fs_orders", id: "fs_orders" },
    ]);

    const source = useMongoQuickOpenSource();
    await source.search("fs");

    expect(source.items.value.filter((item) => item.type === "table").map((item) => item.label)).toEqual(["fs_orders"]);
  });

  it("lists collections of every database when the query matches none by name", async () => {
    mongoListDatabases.mockResolvedValue(["shop", "logs"]);
    mongoListCollections.mockResolvedValue([{ name: "orders", id: "orders" }]);

    const source = useMongoQuickOpenSource();
    await source.search("ord");

    expect(mongoListCollections).toHaveBeenCalledWith("c1", "shop");
    expect(mongoListCollections).toHaveBeenCalledWith("c1", "logs");
  });

  // Regression: a query that happens to match a database's NAME (e.g. "task"
  // matching a database literally called "task") must not exclude other
  // databases from the collection scan. Previously, once any database name
  // matched, targets became *only* the name-matched databases, so a
  // collection like "risk-management".taskState was never even looked at,
  // even though it also satisfies the collection-name filter.
  it("still scans collections of a non-name-matching database when another database's name matches", async () => {
    mongoListDatabases.mockResolvedValue(["task", "risk-management"]);
    mongoListCollections.mockImplementation((_connectionId: string, database: string) => {
      if (database === "task") return Promise.resolve([{ name: "taskHistory", id: "taskHistory" }]);
      if (database === "risk-management") return Promise.resolve([{ name: "taskState", id: "taskState" }]);
      return Promise.resolve([]);
    });

    const source = useMongoQuickOpenSource();
    await source.search("task");

    const collectionLabels = source.items.value.filter((item) => item.type === "table").map((item) => item.label);
    expect(collectionLabels).toContain("taskHistory");
    expect(collectionLabels).toContain("taskState");
  });

  // Pins the fix's stated intent (see the "Prioritize databases whose name
  // matches" comment in useMongoQuickOpenSource.ts): name-matched databases go
  // into `targets` first. Without this, swapping the spread order to
  // `[...remaining, ...nameMatched]` would leave every other test green while
  // silently reintroducing the bug for any database beyond the cap. Using 51
  // databases (one more than MAX_DATABASES_PER_CONNECTION) forces the cap to
  // actually exclude something: if name-matched databases were not prioritized,
  // "needle" — the 51st and only name-matching database — would be squeezed out
  // by the fifty non-matching ones and its collection would never be listed.
  it("scans name-matched databases before others when the database count exceeds the cap", async () => {
    const nonMatching = Array.from({ length: 50 }, (_, index) => `db${index}`);
    mongoListDatabases.mockResolvedValue([...nonMatching, "needle"]);
    mongoListCollections.mockImplementation((_connectionId: string, database: string) => {
      if (database === "needle") return Promise.resolve([{ name: "onlyInNeedle", id: "onlyInNeedle" }]);
      return Promise.resolve([]);
    });

    const source = useMongoQuickOpenSource();
    await source.search("needle");

    const collectionLabels = source.items.value.filter((item) => item.type === "table").map((item) => item.label);
    expect(collectionLabels).toContain("onlyInNeedle");
  });

  // Regression test for the real production defect: a search for "person"
  // against a connection with 38 databases found nothing because
  // "risk-management" — the database containing the "person" collection —
  // sat at index 32, past the old cap of 8. Modelling the measured shape
  // (38 databases, target database well beyond the old cap, no database name
  // itself containing "person") pins the fix at the actual scale that broke.
  it("finds a collection in a database beyond the old 8-database cap (38-database production case)", async () => {
    const databases = Array.from({ length: 38 }, (_, index) => `db${index}`);
    databases[32] = "risk-management";
    mongoListDatabases.mockResolvedValue(databases);
    mongoListCollections.mockImplementation((_connectionId: string, database: string) => {
      if (database === "risk-management") {
        return Promise.resolve([
          { name: "person", id: "person" },
          { name: "personPepInfo", id: "personPepInfo" },
          { name: "personSanctionInfo", id: "personSanctionInfo" },
        ]);
      }
      return Promise.resolve([]);
    });

    const source = useMongoQuickOpenSource();
    await source.search("person");

    const collectionLabels = source.items.value.filter((item) => item.type === "table").map((item) => item.label);
    expect(collectionLabels).toEqual(expect.arrayContaining(["person", "personPepInfo", "personSanctionInfo"]));
  });

  // The cap moved from 8 to 50, but it must still bound work: with more
  // databases than the cap, no more than MAX_DATABASES_PER_CONNECTION get
  // scanned for collections.
  it("still bounds scanning at the new cap of 50 when there are more than 50 databases", async () => {
    const databases = Array.from({ length: 60 }, (_, index) => `db${index}`);
    mongoListDatabases.mockResolvedValue(databases);
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    await source.search("ord");

    expect(mongoListCollections).toHaveBeenCalledTimes(50);
  });

  it("caches databases and collections across searches", async () => {
    mongoListDatabases.mockResolvedValue(["shop"]);
    mongoListCollections.mockResolvedValue([{ name: "orders", id: "orders" }]);

    const source = useMongoQuickOpenSource();
    await source.search("ord");
    await source.search("orde");

    expect(mongoListDatabases).toHaveBeenCalledTimes(1);
    expect(mongoListCollections).toHaveBeenCalledTimes(1);
  });

  // QuickOpenDialog is mounted for the whole app lifetime, so this composable
  // is instantiated exactly once. Without expiry, a collection created or
  // dropped after the first search would never show up (or would keep showing
  // up) for the rest of the session.
  it("re-lists after the cache TTL elapses", async () => {
    vi.useFakeTimers();
    try {
      mongoListDatabases.mockResolvedValue(["shop"]);
      mongoListCollections.mockResolvedValue([{ name: "orders", id: "orders" }]);

      const source = useMongoQuickOpenSource();
      await source.search("ord");
      expect(mongoListDatabases).toHaveBeenCalledTimes(1);
      expect(mongoListCollections).toHaveBeenCalledTimes(1);

      // Matches DATABASE_CACHE_TTL_MS in useMongoQuickOpenSource.ts (with 1
      // database, computeCollectionsCacheTtlMs(1) also floors at 30_000, so
      // this single-database test can't tell the two apart — see the
      // dedicated dynamic-TTL wiring test below for that).
      vi.setSystemTime(Date.now() + 30_001);
      mongoListCollections.mockResolvedValue([
        { name: "orders", id: "orders" },
        { name: "orders_archive", id: "orders_archive" },
      ]);
      await source.search("ord");

      expect(mongoListDatabases).toHaveBeenCalledTimes(2);
      expect(mongoListCollections).toHaveBeenCalledTimes(2);
      expect(source.items.value.map((item) => item.label)).toContain("orders_archive");
    } finally {
      vi.useRealTimers();
    }
  });

  // The test above uses 1 database, where computeCollectionsCacheTtlMs(1)
  // collapses onto the 30_000 floor — identical to DATABASE_CACHE_TTL_MS — so
  // it would pass even if loadCollections were wired to the wrong constant.
  // 38 databases yields 114_000, which is distinguishable from every constant
  // in the file (the 30_000 floor/DATABASE_CACHE_TTL_MS and the 300_000
  // ceiling), so holding at 113_999ms and refreshing at 114_001ms can only
  // happen if the dynamic per-connection TTL is actually the value reaching
  // loadCollections.
  it("wires the dynamic collections TTL into loadCollections at a value distinguishable from every constant in the file", async () => {
    vi.useFakeTimers();
    try {
      const databases = Array.from({ length: 38 }, (_, index) => `db${index}`);
      mongoListDatabases.mockResolvedValue(databases);
      mongoListCollections.mockResolvedValue([{ name: "orders", id: "orders" }]);

      const source = useMongoQuickOpenSource();
      await source.search("ord");
      expect(mongoListCollections).toHaveBeenCalledTimes(38);

      // Just before computeCollectionsCacheTtlMs(38) = 114_000: still cached.
      vi.setSystemTime(Date.now() + 113_999);
      await source.search("ord");
      expect(mongoListCollections).toHaveBeenCalledTimes(38);

      // Just after the same boundary: refreshes.
      vi.setSystemTime(Date.now() + 2);
      await source.search("ord");
      expect(mongoListCollections).toHaveBeenCalledTimes(76);
    } finally {
      vi.useRealTimers();
    }
  });

  it("survives a backend failure without throwing", async () => {
    mongoListDatabases.mockRejectedValue(new Error("connection refused"));

    const source = useMongoQuickOpenSource();
    await expect(source.search("shop")).resolves.toBeUndefined();
    expect(source.items.value).toEqual([]);
  });

  it("clears items on reset", async () => {
    mongoListDatabases.mockResolvedValue(["shop"]);
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    await source.search("shop");
    expect(source.items.value.length).toBeGreaterThan(0);

    source.reset();
    expect(source.items.value).toEqual([]);
  });

  it("discards results of a superseded search", async () => {
    let resolveFirst: (value: string[]) => void = () => {};
    mongoListDatabases.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    const first = source.search("shop");
    source.reset();
    resolveFirst(["shop"]);
    await first;

    expect(source.items.value).toEqual([]);
  });

  it("renders a healthy connection's results even while another connection hangs", async () => {
    connections.value.push({ id: "c3", name: "备用 Mongo", db_type: "mongodb" });
    mongoListDatabases.mockImplementation((connectionId: string) => {
      if (connectionId === "c1") return new Promise<string[]>(() => {}); // never settles
      return Promise.resolve(["shop"]);
    });
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    void source.search("shop");

    await vi.waitFor(() => {
      expect(source.items.value.some((item) => item.connectionId === "c3")).toBe(true);
    });
  });

  it("bounds the number of mongo connections scanned per search", async () => {
    connections.value = Array.from({ length: 10 }, (_, index) => ({ id: `m${index}`, name: `Mongo ${index}`, db_type: "mongodb" }));
    mongoListDatabases.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    await source.search("shop");

    // Matches MAX_CONNECTIONS in useMongoQuickOpenSource.ts, mirroring the
    // spirit of useQuickOpen's REMOTE_SEARCH_MAX_REQUESTS.
    expect(mongoListDatabases).toHaveBeenCalledTimes(8);
  });

  it("coalesces concurrent in-flight requests to the same connection", async () => {
    let resolveDatabases: (value: string[]) => void = () => {};
    mongoListDatabases.mockImplementation(
      () =>
        new Promise<string[]>((resolve) => {
          resolveDatabases = resolve;
        }),
    );
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    const first = source.search("shop");
    const second = source.search("shop");

    resolveDatabases(["shop"]);
    await Promise.all([first, second]);

    expect(mongoListDatabases).toHaveBeenCalledTimes(1);
  });

  it("evicts a rejected promise from the cache so a later search retries", async () => {
    mongoListDatabases.mockRejectedValueOnce(new Error("timeout"));
    mongoListDatabases.mockResolvedValueOnce(["shop"]);
    mongoListCollections.mockResolvedValue([]);

    const source = useMongoQuickOpenSource();
    await source.search("shop");
    expect(source.items.value).toEqual([]);

    await source.search("shop");
    const databaseItems = source.items.value.filter((item) => item.type === "database");
    expect(databaseItems).toHaveLength(1);
    expect(mongoListDatabases).toHaveBeenCalledTimes(2);
  });

  // Ordering must not depend on which loadCollections call happens to settle
  // first once the target loop is parallelised: results are indexed by target
  // position and flattened afterwards, not pushed on resolve.
  it("preserves target order across concurrent loadCollections calls even when later databases resolve before earlier ones", async () => {
    const databases = ["db0", "db1", "db2", "db3"];
    mongoListDatabases.mockResolvedValue(databases);
    const resolvers: Record<string, (value: unknown[]) => void> = {};
    mongoListCollections.mockImplementation(
      (_connectionId: string, database: string) =>
        new Promise((resolve) => {
          resolvers[database] = resolve;
        }),
    );

    const source = useMongoQuickOpenSource();
    const searchPromise = source.search("match");

    await vi.waitFor(() => {
      expect(Object.keys(resolvers)).toHaveLength(4);
    });

    // Resolve deliberately out of target order.
    resolvers.db3([{ name: "match3", id: "match3" }]);
    resolvers.db1([{ name: "match1", id: "match1" }]);
    resolvers.db0([{ name: "match0", id: "match0" }]);
    resolvers.db2([{ name: "match2", id: "match2" }]);
    await searchPromise;

    const labels = source.items.value.filter((item) => item.type === "table").map((item) => item.label);
    expect(labels).toEqual(["match0", "match1", "match2", "match3"]);
  });

  // Pins the single most-emphasised requirement in the spec: loadCollections
  // fan-out is bounded, not unbounded and not sequential. Instruments the mock
  // to track how many calls are simultaneously in flight (increment when
  // called, decrement when the test resolves it) and records the peak. 20
  // databases (more than double COLLECTIONS_LOAD_CONCURRENCY) forces at least
  // two full waves, so the bound actually binds instead of merely not being
  // exceeded by coincidence.
  //
  // This test fails in both directions if the pool regresses:
  // - Swap `mapWithConcurrencyLimit(...)` for an unbounded
  //   `Promise.allSettled(targets.map(...))` and all 20 calls land in the same
  //   synchronous wave, so `peak` becomes 20 and the `toBeLessThanOrEqual(8)`
  //   assertion fails.
  // - Swap it for a sequential `for (const database of targets) { await
  //   loadCollections(...) }` and only one call is ever in flight, so `peak`
  //   never reaches 8 and the wave-draining loop below times out waiting for
  //   a wave of 8 that never arrives — also a failure.
  it("bounds concurrent mongoListCollections calls at COLLECTIONS_LOAD_CONCURRENCY", async () => {
    const databases = Array.from({ length: 20 }, (_, index) => `db${index}`);
    mongoListDatabases.mockResolvedValue(databases);

    let inFlight = 0;
    let peak = 0;
    const pendingResolves: Array<() => void> = [];
    mongoListCollections.mockImplementation(
      () =>
        new Promise((resolvePromise) => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          pendingResolves.push(() => {
            inFlight--;
            resolvePromise([]);
          });
        }),
    );

    const source = useMongoQuickOpenSource();
    const searchPromise = source.search("ord");

    // Drain the pool wave by wave: with concurrency 8 and 20 targets, waves
    // of 8, 8, and 4 databases each claim their slot only once the previous
    // occupant of that slot has resolved.
    for (const waveSize of [8, 8, 4]) {
      await vi.waitFor(() => {
        expect(pendingResolves).toHaveLength(waveSize);
      });
      pendingResolves.splice(0).forEach((resolve) => resolve());
    }

    await searchPromise;

    expect(mongoListCollections).toHaveBeenCalledTimes(20);
    expect(peak).toBeGreaterThan(1);
    // Matches COLLECTIONS_LOAD_CONCURRENCY in useMongoQuickOpenSource.ts.
    expect(peak).toBeLessThanOrEqual(8);
  });

  // What the old sequential loop actually did on a rejection: `await
  // loadCollections(...)` threw out of the for-loop with no local catch, so
  // the exception propagated out of searchConnection entirely. The outer
  // try/catch in search() swallowed it (so quick-open didn't crash), but
  // `groups[index]` for that connection was never assigned — every collection
  // already collected for OTHER databases on the same connection (including
  // ones scanned before the failure) was discarded, not just the failing
  // database's own results. The fix must let one broken database fail without
  // erasing its siblings' results.
  it("does not let one rejecting database wipe out collections found in other databases on the same connection", async () => {
    const databases = ["alpha", "broken", "gamma"];
    mongoListDatabases.mockResolvedValue(databases);
    mongoListCollections.mockImplementation((_connectionId: string, database: string) => {
      if (database === "broken") return Promise.reject(new Error("listCollections failed"));
      if (database === "alpha") return Promise.resolve([{ name: "targetOne", id: "targetOne" }]);
      return Promise.resolve([{ name: "targetTwo", id: "targetTwo" }]);
    });

    const source = useMongoQuickOpenSource();
    await source.search("target");

    const labels = source.items.value.filter((item) => item.type === "table").map((item) => item.label);
    expect(labels).toContain("targetOne");
    expect(labels).toContain("targetTwo");
  });
});

describe("computeCollectionsCacheTtlMs", () => {
  it("floors small deployments at 30s, matching today's fixed TTL", () => {
    expect(computeCollectionsCacheTtlMs(1)).toBe(30_000);
    expect(computeCollectionsCacheTtlMs(8)).toBe(30_000);
  });

  it("scales with database count for the measured 38-database production case, yielding 114s", () => {
    expect(computeCollectionsCacheTtlMs(38)).toBe(114_000);
  });

  it("ceils large deployments at 5 minutes so a renamed/dropped collection cannot stay stale indefinitely", () => {
    expect(computeCollectionsCacheTtlMs(200)).toBe(300_000);
  });
});
