import initSql from "./0000_init.sql?raw";
import catalogueSql from "./0001_catalogue.sql?raw";
import historySql from "./0002_history.sql?raw";
import sessionsSql from "./0003_sessions_costs.sql?raw";
import backupsSql from "./0004_backups.sql?raw";
import settingsSql from "./0005_settings_telemetry.sql?raw";
import parallelSessionsSql from "./0007_parallel_sessions.sql?raw";
import pinnedConversationsSql from "./0008_pinned_conversations.sql?raw";
import messageReasoningSql from "./0009_message_reasoning.sql?raw";
import usageSql from "./0010_usage.sql?raw";
import accountsSql from "./0011_accounts.sql?raw";
import accountScopeSql from "./0012_account_scope.sql?raw";
import accountCapabilitiesSql from "./0013_account_capabilities.sql?raw";

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
  { version: 6, name: "settings_telemetry", sql: settingsSql },
  { version: 7, name: "parallel_sessions", sql: parallelSessionsSql },
  { version: 8, name: "pinned_conversations", sql: pinnedConversationsSql },
  { version: 9, name: "message_reasoning", sql: messageReasoningSql },
  { version: 10, name: "usage_metrics", sql: usageSql },
  { version: 11, name: "accounts", sql: accountsSql },
  { version: 12, name: "account_scope", sql: accountScopeSql },
  { version: 13, name: "account_capabilities", sql: accountCapabilitiesSql }
];
