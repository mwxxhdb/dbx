// dbx-custom(mongo-quick-open): what actually happens when a user picks a
// MongoDB result out of quick open. Before this existed, a collection item
// (type "table") fell through to openTableTarget() and produced a SQL data tab
// running `SELECT * FROM "orders"` against MongoDB, and a database item fell
// through to loadTables(). Both are asserted against below.
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectionStore: {
    activeConnectionId: "",
    treeNodes: [] as any[],
    getConfig: vi.fn((connectionId: string) => ({ id: connectionId, db_type: "mongodb" })),
    loadMongoDatabases: vi.fn(),
    loadMongoCollections: vi.fn(),
    loadTables: vi.fn(),
    // Upstream's queryStore.setTableMeta() reads the connection metadata
    // generation (issue #6623 / PR #6640). Not stubbing it makes every test
    // that opens a tab throw. Upstream's own specs stub it the same way
    // (e.g. useNavigationTargets.store.spec.ts).
    metadataGenerationFor: vi.fn(() => 0),
  },
  loadOpenTabsState: vi.fn(),
  saveOpenTabsState: vi.fn(),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: () => mocks.connectionStore,
}));

vi.mock("@/lib/backend/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/backend/api")>();
  return {
    ...actual,
    loadOpenTabsState: mocks.loadOpenTabsState,
    saveOpenTabsState: mocks.saveOpenTabsState,
  };
});

function installLocalStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => data.set(key, value)),
    removeItem: vi.fn((key: string) => data.delete(key)),
  });
}

async function setup() {
  setActivePinia(createPinia());
  const { useQueryStore } = await import("@/stores/queryStore");
  const { openMongoQuickOpenTarget } = await import("@/lib/app/mongoQuickOpenNavigation");
  const { useConnectionStore } = await import("@/stores/connectionStore");
  return { queryStore: useQueryStore(), connectionStore: useConnectionStore(), openMongoQuickOpenTarget };
}

function collectionItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "table-m1-shop--orders",
    type: "table",
    label: "orders",
    connectionId: "m1",
    database: "shop",
    tableName: "orders",
    searchText: "mongo shop orders",
    ...overrides,
  } as any;
}

describe("openMongoQuickOpenTarget", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    installLocalStorage();
    mocks.connectionStore.treeNodes = [];
    mocks.connectionStore.getConfig.mockImplementation((connectionId: string) => ({ id: connectionId, db_type: "mongodb" }));
    mocks.connectionStore.loadMongoDatabases.mockResolvedValue(undefined);
    mocks.connectionStore.loadMongoCollections.mockResolvedValue(undefined);
    mocks.loadOpenTabsState.mockResolvedValue(null);
    mocks.saveOpenTabsState.mockResolvedValue(undefined);
  });

  it("opens a collection in a document-view tab, not a SQL data tab", async () => {
    const { queryStore, connectionStore, openMongoQuickOpenTarget } = await setup();

    const handled = await openMongoQuickOpenTarget(collectionItem(), connectionStore as any, queryStore);

    expect(handled).toBe(true);
    expect(queryStore.tabs).toHaveLength(1);
    const tab = queryStore.tabs[0];
    expect(tab.mode).toBe("mongo");
    expect(tab.title).toBe("shop.orders");
    expect(tab.connectionId).toBe("m1");
    expect(tab.database).toBe("shop");
    // The "sql" of a mongo tab is the bare collection name — never a SELECT.
    expect(tab.sql).toBe("orders");
    expect(tab.tableMeta).toMatchObject({
      database: "shop",
      tableName: "orders",
      tableType: "TABLE",
      columns: [],
      primaryKeys: [],
    });
  });

  it("carries the collection kind into tableMeta so views are not treated as plain collections", async () => {
    const { queryStore, connectionStore, openMongoQuickOpenTarget } = await setup();

    await openMongoQuickOpenTarget(collectionItem({ label: "recent_orders", tableName: "recent_orders", mongoCollectionKind: "view" }), connectionStore as any, queryStore);
    await openMongoQuickOpenTarget(collectionItem({ label: "metrics", tableName: "metrics", mongoCollectionKind: "timeseries" }), connectionStore as any, queryStore);

    expect(queryStore.tabs.map((tab) => tab.tableMeta?.tableType)).toEqual(["VIEW", "TIMESERIES"]);
  });

  it("reuses an already open tab for the same collection", async () => {
    const { queryStore, connectionStore, openMongoQuickOpenTarget } = await setup();

    await openMongoQuickOpenTarget(collectionItem(), connectionStore as any, queryStore);
    await openMongoQuickOpenTarget(collectionItem(), connectionStore as any, queryStore);

    expect(queryStore.tabs).toHaveLength(1);
  });

  it("expands a mongo database through the mongo path, never loadTables", async () => {
    const { queryStore, connectionStore, openMongoQuickOpenTarget } = await setup();
    mocks.connectionStore.treeNodes = [{ id: "m1", isExpanded: false, children: [{ id: "m1:shop", isExpanded: false }] }];

    const handled = await openMongoQuickOpenTarget({ id: "db-m1-shop", type: "database", label: "shop", connectionId: "m1", database: "shop", searchText: "shop" } as any, connectionStore as any, queryStore);

    expect(handled).toBe(true);
    expect(mocks.connectionStore.loadMongoDatabases).toHaveBeenCalledWith("m1");
    expect(mocks.connectionStore.loadMongoCollections).toHaveBeenCalledWith("m1", "shop");
    expect(mocks.connectionStore.loadTables).not.toHaveBeenCalled();
    expect(queryStore.tabs).toHaveLength(0);
  });

  it("does not re-expand nodes that are already expanded", async () => {
    const { queryStore, connectionStore, openMongoQuickOpenTarget } = await setup();
    mocks.connectionStore.treeNodes = [{ id: "m1", isExpanded: true, children: [{ id: "m1:shop", isExpanded: true }] }];

    await openMongoQuickOpenTarget({ id: "db-m1-shop", type: "database", label: "shop", connectionId: "m1", database: "shop", searchText: "shop" } as any, connectionStore as any, queryStore);

    expect(mocks.connectionStore.loadMongoDatabases).not.toHaveBeenCalled();
    expect(mocks.connectionStore.loadMongoCollections).not.toHaveBeenCalled();
  });

  it("declines non-mongodb connections so the generic SQL path still runs", async () => {
    const { queryStore, connectionStore, openMongoQuickOpenTarget } = await setup();
    mocks.connectionStore.getConfig.mockImplementation((connectionId: string) => ({ id: connectionId, db_type: "postgres" }));

    const handled = await openMongoQuickOpenTarget(collectionItem(), connectionStore as any, queryStore);

    expect(handled).toBe(false);
    expect(queryStore.tabs).toHaveLength(0);
  });

  it("declines item types it does not own", async () => {
    const { queryStore, connectionStore, openMongoQuickOpenTarget } = await setup();

    const handled = await openMongoQuickOpenTarget({ id: "conn-m1", type: "connection", label: "Mongo", connectionId: "m1", searchText: "mongo" } as any, connectionStore as any, queryStore);

    expect(handled).toBe(false);
  });
});

// dbx-custom(mongo-quick-open): silent-rot probe for the App.vue intrusion.
// Nothing else in the suite fails if App.vue stops calling
// openMongoQuickOpenTarget — an upstream refactor of handleQuickOpenSelect takes
// the import and the call together, so even the TS6133 unused-import diagnostic
// stays quiet. The visible consequence is that a found collection opens as
// `SELECT * FROM ...` in a SQL data tab (openTableTarget has no mongodb
// branch). If this goes red, re-insert the call per CUSTOMIZATIONS.md
// 'mongo-quick-open'.
describe("App.vue wiring (source-text probe)", () => {
  it("dispatches to openMongoQuickOpenTarget after ensureConnected and before the type switch", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../../../App.vue", import.meta.url), "utf8");

    const ensure = source.indexOf("connectionStore.ensureConnected(item.connectionId)");
    const call = source.indexOf("openMongoQuickOpenTarget(item");
    const dispatch = source.indexOf('item.type === "connection"');

    expect(ensure).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(-1);
    expect(dispatch).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(ensure);
    expect(call).toBeLessThan(dispatch);
  });
});
