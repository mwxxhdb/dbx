// dbx-custom(mongo-quick-open): 快速打开选中 MongoDB 结果后的导航逻辑。
// 见 CUSTOMIZATIONS.md。新增文件，不会与上游冲突；App.vue 里只留一行 hook。
import { mongoCollectionTableTypeFromNode } from "@/lib/sidebar/mongoCollectionMutation";
import { findTreeNodeById } from "@/lib/sql/newQueryContext";
import type { useConnectionStore } from "@/stores/connectionStore";
import type { useQueryStore } from "@/stores/queryStore";
import type { MongoCollectionKind } from "@/types/database";
import type { QuickOpenItem } from "@/composables/useQuickOpen";

/**
 * A quick-open item that additionally remembers which flavour of MongoDB
 * collection it came from. `useQuickOpen.ts` (upstream) has no field for this,
 * and widening its `QuickOpenItem` would enlarge our merge surface, so the
 * extra field lives here and is only read back by this module.
 */
export type MongoQuickOpenItem = QuickOpenItem & { mongoCollectionKind?: MongoCollectionKind };

type ConnectionStore = ReturnType<typeof useConnectionStore>;
type QueryStore = ReturnType<typeof useQueryStore>;

/**
 * Open a quick-open result that belongs to a MongoDB connection.
 *
 * `useMongoQuickOpenSource` emits collections as `type: "table"` and databases
 * as `type: "database"` so they match and dedup like every other item. The
 * generic handlers for those two types are SQL-only: `openTableTarget()` would
 * build a `SELECT * FROM ...` data tab, and the database branch would call
 * `loadTables()` — both wrong for MongoDB. This mirrors what the sidebar does
 * instead (`openMongoTreeData` / `loadMongoCollections` in
 * SidebarTreeRuntimeHost.vue and connectionStore.ts).
 *
 * Returns true when the item was handled, so the caller can stop; false when
 * the item is not a MongoDB database/collection and the generic path applies.
 */
export async function openMongoQuickOpenTarget(item: MongoQuickOpenItem, connectionStore: ConnectionStore, queryStore: QueryStore): Promise<boolean> {
  if (!item?.connectionId) return false;
  if (connectionStore.getConfig(item.connectionId)?.db_type !== "mongodb") return false;

  if (item.type === "database") {
    if (!item.database) return false;
    await expandMongoDatabase(item.connectionId, item.database, connectionStore);
    return true;
  }

  if (item.type === "table") {
    const collection = item.objectName || item.tableName;
    if (!item.database || !collection) return false;
    openMongoCollectionTab(item, item.database, collection, queryStore);
    return true;
  }

  return false;
}

async function expandMongoDatabase(connectionId: string, database: string, connectionStore: ConnectionStore): Promise<void> {
  const connectionNode = findTreeNodeById(connectionStore.treeNodes, connectionId);
  if (connectionNode && !connectionNode.isExpanded) await connectionStore.loadMongoDatabases(connectionId);

  const databaseNode = findTreeNodeById(connectionStore.treeNodes, `${connectionId}:${database}`);
  if (databaseNode && !databaseNode.isExpanded) await connectionStore.loadMongoCollections(connectionId, database);
}

function openMongoCollectionTab(item: MongoQuickOpenItem, database: string, collection: string, queryStore: QueryStore): void {
  // Same three calls the sidebar makes: a `mongo` tab is the document viewer,
  // the "sql" of that tab is the bare collection name, and tableMeta is what
  // the document grid reads to know what it is showing.
  const tabId = queryStore.createTab(item.connectionId, database, `${database}.${collection}`, "mongo");
  queryStore.updateSql(tabId, collection);
  queryStore.setTableMeta(tabId, {
    database,
    tableName: collection,
    tableType: mongoCollectionTableTypeFromNode({ meta: item.mongoCollectionKind ? { collectionKind: item.mongoCollectionKind } : undefined }),
    columns: [],
    primaryKeys: [],
  });
}
