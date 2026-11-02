
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const databasePath = path.resolve("apps/api/fdr-assure.db");
const db = new DatabaseSync(databasePath);

const events = db
  .prepare("SELECT * FROM audit_log ORDER BY eventId DESC")
  .all();

console.log(JSON.stringify(events, null, 2));

db.close();
