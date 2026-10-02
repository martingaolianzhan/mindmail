import "./network";
import { validateTestDatabaseUrl } from "./test-database-url.js";

validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
// Override any historical .env DATABASE_URL before any production DB import.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
