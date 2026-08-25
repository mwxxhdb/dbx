// dbx-custom(mongo-quick-open): regression coverage for the 5 insertion points
// useQuickOpen.ts makes into useMongoQuickOpenSource.ts (see CUSTOMIZATIONS.md).
// useQuickOpen.spec.ts (upstream) never constructs a `db_type: "mongodb"`
// connection, so orderedMongoConnections() there always returns [] and none
// of these wiring points are exercised. This file is new (not an edit to the
// upstream spec) so it adds zero merge-conflict surface.
import { nextTick } from "vue";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuickOpen } from "@/composables/useQuickOpen";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { getSqlFileFolderPaths } from "@/lib/sqlFile/sqlFileFolders";

const mongoListDatabases = vi.fn();
const mongoListCollections = vi.fn();

vi.mock("@/lib/backend/api", () => ({
  listSqlFilesInFolder: vi.fn(),
  readExternalSqlFile: vi.fn(),
  mongoListDatabases: (...args: unknown[]) => mongoListDatabases(...args),
  mongoListCollections: (...args: unknown[]) => mongoListCollections(...args),
}));

vi.mock("@/stores/connectionStore", () => ({
  useConnectionStore: vi.fn(),
}));

vi.mock("@/stores/savedSqlStore", () => ({
  useSavedSqlStore: vi.fn(),
}));

vi.mock("@/lib/sqlFile/sqlFileFolders", async () => {
  const { ref } = await import("vue");
  return {
    getSqlFileFolderPaths: vi.fn(),
    sqlFileFoldersVersion: ref(0),
  };
});

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await nextTick();
}

/**
 * A mongodb connection plus (unless overridden) a mysql connection with its
 * own database. Keeping a SQL connection around for most tests means
 * `remoteSearchContexts()` in useQuickOpen.ts returns a non-empty array,
 * which is the condition contract 3 below cares about distinguishing.
 */
function storeWithMongo(overrides: Record<string, unknown> = {}) {
  return {
    connections: [
      { id: "sql1", name: "MySQL", db_type: "mysql", database: "app" },
      { id: "m1", name: "Mongo", db_type: "mongodb" },
    ],
    activeConnectionId: null,
    connectedIds: new Set<string>(),
    treeNodes: [],
    listCompletionTables: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("useQuickOpen mongo wiring", () => {
  beforeEach(() => {
    mongoListDatabases.mockReset();
    mongoListCollections.mockReset();
    vi.mocked(useSavedSqlStore).mockReturnValue({ allFiles: [], getFile: vi.fn() } as any);
    vi.mocked(getSqlFileFolderPaths).mockReturnValue([]);
    mongoListDatabases.mockResolvedValue(["app"]);
    mongoListCollections.mockResolvedValue([{ name: "shipments", id: "ship1" }]);
  });

  // Contract 1: `void mongoSource.search(normalizedQuery)` must run and its
  // results must be merged into filteredItems. If either half of the wiring
  // is deleted, a query that only a mongo collection can satisfy stops
  // producing that collection.
  it("surfaces a matching mongo collection once search settles", async () => {
    vi.mocked(useConnectionStore).mockReturnValue(storeWithMongo() as any);

    const { filteredItems, setQuery } = useQuickOpen();
    setQuery("sh");

    await vi.waitFor(() => {
      expect(filteredItems.value.some((item) => item.label === "shipments" && item.type === "table")).toBe(true);
    });
  });

  // Contract 2: mongo search must stay gated behind
  // REMOTE_SEARCH_MIN_QUERY_LENGTH. A 1-character query must not call the
  // mongo API at all.
  it("does not call the mongo API for a query shorter than the minimum length", async () => {
    vi.mocked(useConnectionStore).mockReturnValue(storeWithMongo() as any);

    const { setQuery } = useQuickOpen();
    setQuery("s");
    await flushAsyncWork();

    expect(mongoListDatabases).not.toHaveBeenCalled();
  });

  // Contract 3: `mongoSource.search(...)` must run before the
  // `if (contexts.length === 0) return;` gate. With only a mongo connection
  // configured, remoteSearchContexts() is empty (mongodb is a
  // REMOTE_SEARCH_UNSUPPORTED_TYPES entry), so this is the one setup where a
  // wrongly-ordered search call would silently no-op while every test above
  // (which also has a SQL connection) kept passing.
  it("still surfaces mongo results when there is no SQL connection at all", async () => {
    vi.mocked(useConnectionStore).mockReturnValue(storeWithMongo({ connections: [{ id: "m1", name: "Mongo", db_type: "mongodb" }] }) as any);

    const { filteredItems, setQuery } = useQuickOpen();
    setQuery("sh");

    await vi.waitFor(() => {
      expect(filteredItems.value.some((item) => item.label === "shipments" && item.type === "table")).toBe(true);
    });
  });

  // Contract 4: `mongoSource.reset()` must run on every keystroke. Shrinking
  // the query back below the minimum length must clear previously-shown
  // mongo results, not leave them stuck in filteredItems.
  it("clears mongo results once the query shrinks back below the minimum length", async () => {
    vi.mocked(useConnectionStore).mockReturnValue(storeWithMongo() as any);

    const { filteredItems, setQuery } = useQuickOpen();
    setQuery("sh");
    await vi.waitFor(() => {
      expect(filteredItems.value.some((item) => item.label === "shipments")).toBe(true);
    });

    setQuery("s");
    await flushAsyncWork();

    expect(filteredItems.value.some((item) => item.label === "shipments")).toBe(false);
  });

  // ---------------------------------------------------------------------
  // Silent-rot probe.
  //
  // This fork's whole reason for having a dedicated mongo source is that
  // `mongodb` sits in REMOTE_SEARCH_UNSUPPORTED_TYPES in useQuickOpen.ts, so
  // mongo connections never reach the SQL metadata path
  // (`connectionStore.listCompletionTables`).
  //
  // If upstream ever removes `mongodb` from that set, mongo connections would
  // flow through BOTH paths: the SQL one (producing broken items built from
  // SQL metadata endpoints that MongoDB does not implement) and ours. That
  // change would merge with zero conflicts and would not break any other test,
  // which is exactly why this probe exists.
  //
  // WHEN THIS GOES RED: upstream has changed how MongoDB is routed. Read the
  // upstream change first, then either (a) upstream gained real MongoDB
  // quick-open support — delete this fork's 7 intrusion points (5 in
  // useQuickOpen.ts, 2 in App.vue) and useMongoQuickOpenSource.ts /
  // mongoQuickOpenNavigation.ts entirely and use theirs, or (b) it was an
  // unrelated refactor — restore the mongo exclusion
  // (locally, in this fork's own code if possible) so the two paths do not
  // double up. Do NOT just delete this test.
  it("never routes a mongodb connection through the SQL completion path", async () => {
    const store = storeWithMongo({
      // A `database` is what makes remoteSearchContexts() willing to build a
      // context for a connection at all — without it the probe would pass for
      // the wrong reason.
      connections: [{ id: "m1", name: "Mongo", db_type: "mongodb", database: "app" }],
    });
    vi.mocked(useConnectionStore).mockReturnValue(store as any);

    const { filteredItems, setQuery } = useQuickOpen();
    setQuery("sh");

    // Wait past REMOTE_SEARCH_DEBOUNCE_MS (180ms) so a leaked SQL search has
    // every chance to fire.
    await vi.waitFor(() => {
      expect(filteredItems.value.some((item) => item.label === "shipments")).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(vi.mocked(store.listCompletionTables).mock.calls.filter((call) => call[0] === "m1")).toEqual([]);
  });
});
