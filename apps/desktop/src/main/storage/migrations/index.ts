import initSql from "./0000_init.sql?raw";
import catalogueSql from "./0001_catalogue.sql?raw";
import historySql from "./0002_history.sql?raw";
import sessionsSql from "./0003_sessions_costs.sql?raw";
import backupsSql from "./0004_backups.sql?raw";
import settingsSql from "./0005_settings_telemetry.sql?raw";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  { version: 1, name: "init", sql: initSql },
  { version: 2, name: "catalogue", sql: catalogueSql },
  { version: 3, name: "history", sql: historySql },
  { version: 4, name: "sessions_costs", sql: sessionsSql },
  { version: 5, name: "backups", sql: backupsSql },
  { version: 6, name: "settings_telemetry", sql: settingsSql }
];
