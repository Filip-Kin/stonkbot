// #region test setup
// Point every test at a throwaway database BEFORE any module that opens one is
// imported. db.ts memoises its handle on first call, so a test that sets this
// itself only works when it happens to load first — which made the suite pass
// or fail depending on file order.
import { mkdirSync } from "node:fs";

const DIR = "/tmp/stonkbot-test-data";
mkdirSync(DIR, { recursive: true });
process.env.STONKBOT_DATA_DIR = DIR;
// #endregion
