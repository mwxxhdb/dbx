use dbx_core::models::connection::ConnectionConfig;
use percent_encoding::percent_decode_str;
use serde_json::json;
use url::Url;

const ENV_PREFIX: &str = "DBX_CONN_";
const ID_PREFIX: &str = "env-";

/// `DBX_CONN_PROD_MONGO` -> `env-prod-mongo`. The id is derived from the
/// variable name so it stays stable across restarts — tab layout, query
/// history and AI sessions all key off it.
pub fn connection_id_from_var(var_name: &str) -> Option<String> {
    let suffix = var_name.strip_prefix(ENV_PREFIX)?;
    if suffix.is_empty() {
        return None;
    }
    Some(format!("{ID_PREFIX}{}", suffix.to_lowercase().replace('_', "-")))
}

/// Maps a DSN scheme to the serde name of `DatabaseType`
/// (see `crates/dbx-core/src/models/connection.rs`, `rename_all = "lowercase"`).
pub fn db_type_from_scheme(scheme: &str) -> Option<&'static str> {
    Some(match scheme {
        "mongodb" | "mongodb+srv" => "mongodb",
        "postgres" | "postgresql" => "postgres",
        // DatabaseType has no MariaDB variant; MariaDB rides on mysql.
        "mysql" | "mariadb" => "mysql",
        "redis" | "rediss" => "redis",
        "clickhouse" => "clickhouse",
        "sqlite" => "sqlite",
        "sqlserver" | "mssql" => "sqlserver",
        "oracle" => "oracle",
        "elasticsearch" => "elasticsearch",
        _ => return None,
    })
}

fn default_port(db_type: &str) -> u16 {
    match db_type {
        "mongodb" => 27017,
        "postgres" => 5432,
        "mysql" => 3306,
        "redis" => 6379,
        "clickhouse" => 8123,
        "sqlserver" => 1433,
        "oracle" => 1521,
        "elasticsearch" => 9200,
        _ => 0,
    }
}

fn decode(value: &str) -> String {
    percent_decode_str(value).decode_utf8_lossy().into_owned()
}

fn truthy(value: &str) -> bool {
    matches!(value.trim().to_lowercase().as_str(), "1" | "true" | "yes" | "on")
}

fn scheme_of(dsn: &str) -> String {
    dsn.split_once("://").map(|(scheme, _)| scheme.to_lowercase()).unwrap_or_default()
}

/// `Url::parse` rejects the replica-set form `mongodb://h1:27017,h2:27017/db`
/// outright ("invalid port number") — a comma-separated seed list is a MongoDB
/// convention, not a URL one. Everything the parsed `Url` is used for here
/// (host/port for display and SSH tunnelling, credentials, database, query
/// keys) is the same for the first seed, and the DSN the driver actually dials
/// is kept verbatim in `connection_string`, so parsing a single-host copy loses
/// nothing.
fn mongo_dsn_for_url_parsing(dsn: &str) -> std::borrow::Cow<'_, str> {
    let Some(rest_start) = dsn.find("://").map(|index| index + 3) else {
        return std::borrow::Cow::Borrowed(dsn);
    };
    let rest = &dsn[rest_start..];
    let authority_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let hosts_start = authority.rfind('@').map(|index| index + 1).unwrap_or(0);
    let Some(comma) = authority[hosts_start..].find(',') else {
        return std::borrow::Cow::Borrowed(dsn);
    };
    let cut = rest_start + hosts_start + comma;
    std::borrow::Cow::Owned(format!("{}{}", &dsn[..cut], &dsn[rest_start + authority_end..]))
}

/// The DSN to hand the MongoDB driver: the original one, minus the dbx-only
/// query keys (`name`/`color`/`ssl`), which the driver would reject as unknown
/// options.
///
/// Rebuilding a mongo URI from host/port/database (what `connection_url()`
/// does when `connection_string` is empty) is lossy in ways that make Atlas and
/// replica-set clusters unreachable: `mongodb+srv` collapses to `mongodb`,
/// dropping the SRV DNS seedlist and its implied TLS, and every seed but the
/// first disappears.
fn mongo_connection_string(dsn: &str, passthrough: &[String]) -> String {
    let base = dsn.split_once('?').map(|(base, _)| base).unwrap_or(dsn);
    if passthrough.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", passthrough.join("&"))
    }
}

/// Parses one `DBX_CONN_*` variable into a connection.
///
/// The config is built through `serde_json::from_value` rather than a struct
/// literal on purpose: `ConnectionConfig` has no `Default` and dozens of
/// fields, so a literal would stop compiling every time upstream adds one.
/// Only id/name/db_type/host/port/username/password/database lack a serde
/// default; everything else fills itself in.
pub fn parse_env_connection(var_name: &str, dsn: &str) -> Result<ConnectionConfig, String> {
    let id = connection_id_from_var(var_name).ok_or_else(|| format!("{var_name} is not a {ENV_PREFIX}* variable"))?;
    let is_mongo = matches!(scheme_of(dsn).as_str(), "mongodb" | "mongodb+srv");
    let parse_target = if is_mongo { mongo_dsn_for_url_parsing(dsn) } else { std::borrow::Cow::Borrowed(dsn) };
    let url = Url::parse(&parse_target).map_err(|e| format!("{var_name}: cannot parse DSN: {e}"))?;

    let scheme = url.scheme();
    let db_type = db_type_from_scheme(scheme).ok_or_else(|| format!("{var_name}: unsupported scheme '{scheme}'"))?;

    let is_sqlite = db_type == "sqlite";
    // `sqlite://data/app.db` (two slashes) parses as host="data", path="/app.db",
    // so the database silently becomes "/app.db"; `sqlite://relative.db` yields
    // an empty database. Both are almost always a missing slash — the correct
    // absolute form is `sqlite:///data/app.db` (three slashes). Warn rather than
    // fail: a host component is legal URL syntax and we cannot prove intent.
    if is_sqlite && !url.host_str().unwrap_or_default().is_empty() {
        log::warn!(
            "{var_name}: sqlite DSN '{dsn}' has a host component ('{}'), so only the path after it is used as the database file ('{}'). An absolute path needs three slashes: sqlite:///data/app.db",
            url.host_str().unwrap_or_default(),
            url.path()
        );
    }
    let host = if is_sqlite { String::new() } else { url.host_str().unwrap_or_default().to_string() };
    let port = if is_sqlite { 0 } else { url.port().unwrap_or_else(|| default_port(db_type)) };

    let database = if is_sqlite {
        Some(decode(url.path()))
    } else {
        let path = url.path().trim_start_matches('/');
        if path.is_empty() {
            None
        } else {
            Some(decode(path))
        }
    };

    let mut name = var_name.strip_prefix(ENV_PREFIX).unwrap_or(var_name).to_string();
    let mut color: Option<String> = None;
    let mut ssl = false;
    let mut passthrough: Vec<String> = Vec::new();

    // Iterate the raw query string ourselves instead of `url.query_pairs()`.
    // `query_pairs()` percent-decodes both key and value, and there is no
    // lossless way back: a passthrough value whose *encoded* form contains a
    // literal `&` or `=` (e.g. `options=%2Dc%20search_path%3Dfoo%26bar`)
    // would decode to `-c search_path=foo&bar`, and re-joining that into
    // `url_params` with `&` would corrupt it into extra bogus key/value
    // pairs. Every downstream consumer of `url_params`
    // (crates/dbx-core/src/models/connection.rs) expects it to still be a
    // raw, percent-encoded query string, so non-reserved entries are kept
    // byte-for-byte as they appeared in the DSN. Only the key is decoded,
    // and only to decide whether it is one of the three reserved keys.
    if let Some(query) = url.query() {
        for entry in query.split('&') {
            if entry.is_empty() {
                continue;
            }
            let (raw_key, raw_value) = entry.split_once('=').unwrap_or((entry, ""));
            match decode(raw_key).as_str() {
                "name" => name = decode(raw_value),
                "color" => color = Some(decode(raw_value)),
                "ssl" => ssl = truthy(&decode(raw_value)),
                _ => passthrough.push(entry.to_string()),
            }
        }
    }

    let mut config = json!({
        "id": id,
        "name": name,
        "db_type": db_type,
        "host": host,
        "port": port,
        "username": decode(url.username()),
        "password": decode(url.password().unwrap_or_default()),
        "database": database,
        "ssl": ssl,
    });

    if let Some(color) = color {
        config["color"] = json!(color);
    }
    if !passthrough.is_empty() {
        config["url_params"] = json!(passthrough.join("&"));
    }
    if is_mongo {
        // `ConnectionConfig::connection_url()` prefers `connection_string`
        // whenever it is non-empty and only falls back to rebuilding
        // `mongodb://{host}:{port}{db}{params}` otherwise. Handing it the
        // original DSN is what keeps `mongodb+srv` and multi-host seed lists
        // working. The SSH-tunnel path still works: `rewrite_mongo_uri_host`
        // accepts the `mongodb+srv://` prefix and swaps in the local forward.
        config["connection_string"] = json!(mongo_connection_string(dsn, &passthrough));
    }

    serde_json::from_value(config).map_err(|e| format!("{var_name}: cannot build connection: {e}"))
}

/// Turns a set of environment variables into connections, skipping (and
/// logging) any single variable that fails to parse. One typo must never
/// stop the server from starting.
///
/// Env var names are case-sensitive on POSIX, so `DBX_CONN_FOO` and
/// `DBX_CONN_foo` can both exist and both parse successfully, yet
/// `connection_id_from_var` lowercases the suffix, so they collide on the
/// same `id`. `Storage::save_connections` persists to a table with `id` as
/// primary key, so two configs sharing an id would fail the whole save
/// transaction — silently dropping every other env connection for that boot,
/// not just the colliding pair. To keep the "one bad entry is skipped, not a
/// batch failure" guarantee, collisions are resolved here: the first variable
/// in sorted order wins (deterministic across boots regardless of process
/// environment ordering) and every later variable that collides with an
/// already-claimed id is logged and skipped, same as a parse failure.
pub fn collect_env_connections(vars: Vec<(String, String)>) -> Vec<ConnectionConfig> {
    let mut candidates: Vec<(String, String)> =
        vars.into_iter().filter(|(key, _)| key.starts_with(ENV_PREFIX)).collect();
    candidates.sort_by(|left, right| left.0.cmp(&right.0));

    let mut configs = Vec::new();
    let mut claimed_by: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for (key, value) in candidates {
        match parse_env_connection(&key, &value) {
            Ok(config) => {
                if let Some(owner) = claimed_by.get(&config.id) {
                    log::error!("Skipping env datasource: {key}: id {} already claimed by {owner}", config.id);
                    continue;
                }
                claimed_by.insert(config.id.clone(), key);
                configs.push(config);
            }
            Err(error) => log::error!("Skipping env datasource: {error}"),
        }
    }
    configs
}

/// env is the single source of truth for managed connections: every stored
/// connection whose id starts with `env-` is dropped and rebuilt from the
/// environment. Manually created connections (uuid ids) are untouched.
pub fn merge_env_connections(
    existing: Vec<ConnectionConfig>,
    from_env: Vec<ConnectionConfig>,
) -> Vec<ConnectionConfig> {
    let mut merged = from_env;
    merged.extend(existing.into_iter().filter(|config| !config.id.starts_with(ID_PREFIX)));
    merged
}

/// Testable core of `apply_env_connections`: takes the variables explicitly
/// instead of reading the process environment.
pub async fn apply_env_connections_from(
    storage: &dbx_core::storage::Storage,
    vars: Vec<(String, String)>,
) -> Result<usize, String> {
    let from_env = collect_env_connections(vars);
    let count = from_env.len();
    let existing = storage.load_connections().await?;
    let merged = merge_env_connections(existing, from_env);
    storage.save_connections(&merged).await?;
    Ok(count)
}

/// Rebuilds every `env-` connection from `DBX_CONN_*` on startup.
///
/// Managed connections are overwritten wholesale on every boot — a UI edit to
/// one is silently rolled back, and a UI delete comes back. That is the
/// intended "env is the single source of truth" behaviour for container
/// deployments. Use a manually created connection for anything temporary.
pub async fn apply_env_connections(storage: &dbx_core::storage::Storage) -> Result<usize, String> {
    apply_env_connections_from(storage, std::env::vars().collect()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manual_connection(id: &str, name: &str) -> ConnectionConfig {
        serde_json::from_value(json!({
            "id": id,
            "name": name,
            "db_type": "mysql",
            "host": "127.0.0.1",
            "port": 3306,
            "username": "root",
            "password": "",
            "database": null,
        }))
        .unwrap()
    }

    #[test]
    fn only_dbx_conn_variables_are_collected() {
        let collected = collect_env_connections(vec![
            ("DBX_PORT".to_string(), "4224".to_string()),
            ("DBX_CONN_A".to_string(), "mongodb://host/admin".to_string()),
            ("HOME".to_string(), "/root".to_string()),
        ]);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].id, "env-a");
    }

    #[test]
    fn a_broken_variable_does_not_take_down_the_healthy_ones() {
        let collected = collect_env_connections(vec![
            ("DBX_CONN_BAD".to_string(), "nonsense://host/db".to_string()),
            ("DBX_CONN_GOOD".to_string(), "mongodb://host/admin".to_string()),
            ("DBX_CONN_ALSOBAD".to_string(), "not a url".to_string()),
        ]);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].id, "env-good");
    }

    #[test]
    fn collected_connections_are_ordered_by_variable_name() {
        let collected = collect_env_connections(vec![
            ("DBX_CONN_Z".to_string(), "mongodb://host/admin".to_string()),
            ("DBX_CONN_A".to_string(), "mongodb://host/admin".to_string()),
        ]);
        assert_eq!(collected.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["env-a", "env-z"]);
    }

    #[test]
    fn colliding_ids_keep_the_first_variable_in_sort_order() {
        // DBX_CONN_FOO and DBX_CONN_foo both normalize to id "env-foo".
        // Uppercase sorts before lowercase, so DBX_CONN_FOO wins.
        let collected = collect_env_connections(vec![
            ("DBX_CONN_foo".to_string(), "mongodb://host/from-lowercase".to_string()),
            ("DBX_CONN_FOO".to_string(), "mongodb://host/from-uppercase".to_string()),
        ]);
        assert_eq!(collected.len(), 1);
        assert_eq!(collected[0].id, "env-foo");
        assert_eq!(collected[0].database.as_deref(), Some("from-uppercase"));
    }

    #[test]
    fn a_collision_does_not_take_down_an_unrelated_healthy_variable() {
        let collected = collect_env_connections(vec![
            ("DBX_CONN_FOO".to_string(), "mongodb://host/a".to_string()),
            ("DBX_CONN_foo".to_string(), "mongodb://host/b".to_string()),
            ("DBX_CONN_BAR".to_string(), "mongodb://host/c".to_string()),
        ]);
        let ids = collected.iter().map(|c| c.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, vec!["env-bar", "env-foo"], "got {ids:?}");
    }

    #[test]
    fn merging_replaces_managed_connections_and_keeps_manual_ones() {
        let existing =
            vec![manual_connection("env-stale", "从前的 env 连接"), manual_connection("6f1c0e2a-uuid", "我手动建的")];
        let from_env = vec![manual_connection("env-fresh", "现在的 env 连接")];

        let merged = merge_env_connections(existing, from_env);

        let ids = merged.iter().map(|c| c.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids, vec!["env-fresh", "6f1c0e2a-uuid"]);
    }

    #[test]
    fn a_ui_edit_to_a_managed_connection_is_overwritten() {
        let existing = vec![manual_connection("env-prod", "被用户改过的名字")];
        let from_env = vec![manual_connection("env-prod", "env 里的名字")];

        let merged = merge_env_connections(existing, from_env);

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "env 里的名字");
    }

    #[test]
    fn dropping_a_variable_drops_the_connection() {
        let existing = vec![manual_connection("env-gone", "上次还在")];

        let merged = merge_env_connections(existing, vec![]);

        assert!(merged.is_empty());
    }

    #[tokio::test]
    async fn applying_env_connections_persists_them_and_keeps_manual_ones() {
        let dir = std::env::temp_dir().join(format!("dbx-web-env-conn-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = dbx_core::storage::Storage::open(&dir.join("dbx.db")).await.unwrap();

        storage
            .save_connections(&[
                manual_connection("6f1c0e2a-uuid", "我手动建的"),
                manual_connection("env-stale", "上次的"),
            ])
            .await
            .unwrap();

        let applied = apply_env_connections_from(
            &storage,
            vec![("DBX_CONN_FRESH".to_string(), "mongodb://host:27017/admin".to_string())],
        )
        .await
        .unwrap();
        assert_eq!(applied, 1);

        let stored = storage.load_connections().await.unwrap();
        let ids = stored.iter().map(|c| c.id.as_str()).collect::<std::collections::HashSet<_>>();
        assert!(ids.contains("env-fresh"), "got {ids:?}");
        assert!(ids.contains("6f1c0e2a-uuid"), "got {ids:?}");
        assert!(!ids.contains("env-stale"), "got {ids:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn applying_env_connections_survives_an_id_collision_and_keeps_manual_ones() {
        let dir = std::env::temp_dir().join(format!("dbx-web-env-conn-collision-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let storage = dbx_core::storage::Storage::open(&dir.join("dbx.db")).await.unwrap();

        storage.save_connections(&[manual_connection("6f1c0e2a-uuid", "我手动建的")]).await.unwrap();

        let applied = apply_env_connections_from(
            &storage,
            vec![
                ("DBX_CONN_FOO".to_string(), "mongodb://host:27017/a".to_string()),
                ("DBX_CONN_foo".to_string(), "mongodb://host:27017/b".to_string()),
                ("DBX_CONN_HEALTHY".to_string(), "mongodb://host:27017/c".to_string()),
            ],
        )
        .await
        .unwrap();
        assert_eq!(applied, 2);

        let stored = storage.load_connections().await.unwrap();
        let ids = stored.iter().map(|c| c.id.as_str()).collect::<std::collections::HashSet<_>>();
        assert_eq!(stored.len(), 3, "got {ids:?}");
        assert!(ids.contains("env-foo"), "got {ids:?}");
        assert!(ids.contains("env-healthy"), "got {ids:?}");
        assert!(ids.contains("6f1c0e2a-uuid"), "got {ids:?}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn connection_id_is_derived_from_the_variable_suffix() {
        assert_eq!(connection_id_from_var("DBX_CONN_PROD_MONGO"), Some("env-prod-mongo".to_string()));
        assert_eq!(connection_id_from_var("DBX_CONN_CACHE"), Some("env-cache".to_string()));
    }

    #[test]
    fn non_connection_variables_are_ignored() {
        assert_eq!(connection_id_from_var("DBX_PORT"), None);
        assert_eq!(connection_id_from_var("DBX_CONN_"), None);
        assert_eq!(connection_id_from_var("PATH"), None);
    }

    #[test]
    fn schemes_map_to_the_serde_names_of_database_type() {
        assert_eq!(db_type_from_scheme("mongodb"), Some("mongodb"));
        assert_eq!(db_type_from_scheme("mongodb+srv"), Some("mongodb"));
        assert_eq!(db_type_from_scheme("postgres"), Some("postgres"));
        assert_eq!(db_type_from_scheme("postgresql"), Some("postgres"));
        assert_eq!(db_type_from_scheme("mariadb"), Some("mysql"));
        assert_eq!(db_type_from_scheme("rediss"), Some("redis"));
        assert_eq!(db_type_from_scheme("mssql"), Some("sqlserver"));
        assert_eq!(db_type_from_scheme("nonsense"), None);
    }

    #[test]
    fn a_mongodb_dsn_becomes_a_connection_config() {
        let config =
            parse_env_connection("DBX_CONN_PROD_MONGO", "mongodb://alice:s3cr3t@192.0.2.10:27017/admin").unwrap();
        assert_eq!(config.id, "env-prod-mongo");
        assert_eq!(config.name, "PROD_MONGO");
        assert_eq!(config.host, "192.0.2.10");
        assert_eq!(config.port, 27017);
        assert_eq!(config.username, "alice");
        assert_eq!(config.password, "s3cr3t");
        assert_eq!(config.database.as_deref(), Some("admin"));
    }

    // Rebuilding a mongo URI from host/port/database drops the SRV seedlist and
    // its implied TLS, so `mongodb+srv://cluster/...` would become
    // `mongodb://cluster:27017/...` and Atlas clusters could not connect.
    #[test]
    fn a_mongodb_srv_dsn_is_kept_verbatim_in_connection_string() {
        let config = parse_env_connection(
            "DBX_CONN_ATLAS",
            "mongodb+srv://alice:s3cr3t@cluster.abc.mongodb.net/admin?retryWrites=true&w=majority",
        )
        .unwrap();
        assert_eq!(serde_json::to_value(config.db_type).unwrap(), json!("mongodb"));
        assert_eq!(
            config.connection_string.as_deref(),
            Some("mongodb+srv://alice:s3cr3t@cluster.abc.mongodb.net/admin?retryWrites=true&w=majority")
        );
        // The scalar fields still describe the cluster for the UI and for the
        // SSH-tunnel host rewrite.
        assert_eq!(config.host, "cluster.abc.mongodb.net");
        assert_eq!(config.username, "alice");
        assert_eq!(config.database.as_deref(), Some("admin"));
    }

    #[test]
    fn a_mongodb_srv_dsn_round_trips_through_connection_url() {
        let config =
            parse_env_connection("DBX_CONN_ATLAS", "mongodb+srv://alice:s3cr3t@cluster.abc.mongodb.net/admin").unwrap();
        assert_eq!(config.connection_url(), "mongodb+srv://alice:s3cr3t@cluster.abc.mongodb.net/admin");
    }

    // `Url::parse` rejects a comma-separated seed list with explicit ports
    // ("invalid port number"), so this whole DSN shape used to be unusable.
    #[test]
    fn a_replica_set_dsn_with_multiple_hosts_is_accepted() {
        let config =
            parse_env_connection("DBX_CONN_RS", "mongodb://alice:s3cr3t@h1:27017,h2:27018,h3:27019/app?replicaSet=rs0")
                .unwrap();
        assert_eq!(
            config.connection_string.as_deref(),
            Some("mongodb://alice:s3cr3t@h1:27017,h2:27018,h3:27019/app?replicaSet=rs0")
        );
        assert_eq!(config.connection_url(), "mongodb://alice:s3cr3t@h1:27017,h2:27018,h3:27019/app?replicaSet=rs0");
        // host/port describe the first seed, which is what the UI shows and
        // what an SSH tunnel would forward.
        assert_eq!(config.host, "h1");
        assert_eq!(config.port, 27017);
        assert_eq!(config.database.as_deref(), Some("app"));
    }

    #[test]
    fn a_replica_set_dsn_without_credentials_is_accepted() {
        let config = parse_env_connection("DBX_CONN_RS", "mongodb://h1:27017,h2:27017/app").unwrap();
        assert_eq!(config.host, "h1");
        assert_eq!(config.port, 27017);
        assert_eq!(config.connection_string.as_deref(), Some("mongodb://h1:27017,h2:27017/app"));
    }

    // name/color/ssl are dbx-only knobs; leaving them in the DSN would make the
    // driver reject the whole connection as carrying unknown options.
    #[test]
    fn dbx_only_query_keys_are_stripped_from_the_mongo_connection_string() {
        let config = parse_env_connection(
            "DBX_CONN_ATLAS",
            "mongodb+srv://cluster.abc.mongodb.net/admin?name=Atlas&color=%23e11d48&ssl=true&retryWrites=true",
        )
        .unwrap();
        assert_eq!(config.name, "Atlas");
        assert_eq!(config.color.as_deref(), Some("#e11d48"));
        assert!(config.ssl);
        assert_eq!(
            config.connection_string.as_deref(),
            Some("mongodb+srv://cluster.abc.mongodb.net/admin?retryWrites=true")
        );
    }

    #[test]
    fn a_mongo_dsn_without_query_parameters_keeps_a_bare_connection_string() {
        let config = parse_env_connection("DBX_CONN_M", "mongodb://host:27017/admin?name=Mongo").unwrap();
        assert_eq!(config.connection_string.as_deref(), Some("mongodb://host:27017/admin"));
    }

    #[test]
    fn non_mongo_connections_get_no_connection_string() {
        let config = parse_env_connection("DBX_CONN_PG", "postgres://host:5432/db").unwrap();
        assert_eq!(config.connection_string, None);
    }

    #[test]
    fn the_name_parameter_overrides_the_variable_suffix() {
        let config =
            parse_env_connection("DBX_CONN_PROD_MONGO", "mongodb://h:27017/admin?name=%E7%94%9F%E4%BA%A7%E5%BA%93")
                .unwrap();
        assert_eq!(config.name, "生产库");
    }

    #[test]
    fn percent_encoded_credentials_are_decoded() {
        let config = parse_env_connection("DBX_CONN_X", "postgres://us%40er:p%40ss%3Aword@localhost:5432/db").unwrap();
        assert_eq!(config.username, "us@er");
        assert_eq!(config.password, "p@ss:word");
    }

    #[test]
    fn the_port_falls_back_to_the_scheme_default() {
        let config = parse_env_connection("DBX_CONN_X", "mongodb://host/admin").unwrap();
        assert_eq!(config.port, 27017);

        let config = parse_env_connection("DBX_CONN_Y", "postgres://host/db").unwrap();
        assert_eq!(config.port, 5432);
    }

    #[test]
    fn color_and_ssl_are_consumed_and_the_rest_passes_through_to_url_params() {
        let config = parse_env_connection(
            "DBX_CONN_X",
            "postgres://host:5432/db?color=%23e11d48&ssl=true&application_name=dbx&sslmode=require",
        )
        .unwrap();
        assert_eq!(config.color.as_deref(), Some("#e11d48"));
        assert!(config.ssl);
        let params = config.url_params.unwrap();
        assert!(params.contains("application_name=dbx"), "got {params}");
        assert!(params.contains("sslmode=require"), "got {params}");
        assert!(!params.contains("color="), "got {params}");
        // Exact-key check, not a raw substring check: "application_name=dbx" is a
        // legitimate passthrough entry and contains "name=" as a substring, so
        // `params.contains("name=")` would false-positive on it. What this
        // assertion actually verifies is that the consumed `name` override key
        // itself never leaks into url_params.
        assert!(!params.split('&').any(|kv| kv.starts_with("name=")), "got {params}");
    }

    #[test]
    fn a_sqlite_dsn_puts_the_path_in_database_and_leaves_host_empty() {
        let config = parse_env_connection("DBX_CONN_LOCAL", "sqlite:///data/app.db").unwrap();
        assert_eq!(config.host, "");
        assert_eq!(config.port, 0);
        assert_eq!(config.database.as_deref(), Some("/data/app.db"));
    }

    // Documents the trap rather than fixing it: a sqlite DSN with a host
    // component is legal URL syntax, so it cannot be rejected, but the
    // resulting database path is almost never what the author meant. The
    // matching `log::warn!` in parse_env_connection is what a user actually
    // sees; this test pins the surprising values so the warning's wording
    // stays true.
    #[test]
    fn a_sqlite_dsn_with_too_few_slashes_yields_a_surprising_path() {
        let config = parse_env_connection("DBX_CONN_LOCAL", "sqlite://data/app.db").unwrap();
        assert_eq!(config.database.as_deref(), Some("/app.db"));

        let config = parse_env_connection("DBX_CONN_LOCAL", "sqlite://relative.db").unwrap();
        assert_eq!(config.database.as_deref(), Some(""));
    }

    #[test]
    fn a_sqlite_path_with_percent_encoded_characters_is_decoded() {
        let config = parse_env_connection("DBX_CONN_LOCAL", "sqlite:///data/my%20app.db").unwrap();
        assert_eq!(config.database.as_deref(), Some("/data/my app.db"));
    }

    #[test]
    fn a_passthrough_value_containing_encoded_reserved_characters_survives_still_encoded() {
        let config = parse_env_connection(
            "DBX_CONN_X",
            "postgres://host:5432/db?options=%2Dc%20search_path%3Dfoo%26bar&sslmode=require",
        )
        .unwrap();
        let params = config.url_params.unwrap();
        assert!(params.contains("options=%2Dc%20search_path%3Dfoo%26bar"), "got {params}");
        assert!(params.contains("sslmode=require"), "got {params}");
        // The %26 in the options value must not have been decoded into a
        // literal '&' before joining, or splitting on '&' would produce more
        // than 2 parts.
        assert_eq!(params.split('&').count(), 2, "got {params}");
    }

    #[test]
    fn a_query_entry_without_an_equals_sign_does_not_panic() {
        let config = parse_env_connection("DBX_CONN_X", "postgres://host:5432/db?flag&sslmode=require").unwrap();
        let params = config.url_params.unwrap();
        assert!(params.contains("flag"), "got {params}");
        assert!(params.contains("sslmode=require"), "got {params}");
    }

    #[test]
    fn an_unknown_scheme_is_an_error_rather_than_a_panic() {
        let error = parse_env_connection("DBX_CONN_X", "nonsense://host/db").unwrap_err();
        assert!(error.contains("nonsense"), "got {error}");
    }

    #[test]
    fn a_malformed_dsn_is_an_error_rather_than_a_panic() {
        assert!(parse_env_connection("DBX_CONN_X", "not a url at all").is_err());
    }
}
