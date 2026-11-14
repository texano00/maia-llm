-- Account capabilities (specs/007-setup-notices-and-portal).
--
-- A JSON array of "debug" / "operator". `operator` implies `debug` on read, so
-- the stored value stays exactly what an operator granted. Unknown entries are
-- dropped by the validation layer rather than by the database.
ALTER TABLE accounts ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '[]';
