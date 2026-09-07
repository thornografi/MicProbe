import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The shared service uses D1's prepared-statement API in both runtimes. */
export function createNodeAccountDb(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    const sqlite = new DatabaseSync(filename);
    sqlite.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    sqlite.exec('CREATE TABLE IF NOT EXISTS account_schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of readdirSync(directory).filter(value => /^\d+_[\w-]+\.sql$/.test(value)).sort()) {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
            if (!sqlite.prepare('SELECT name FROM account_schema_migrations WHERE name = ?').get(name)) {
                sqlite.exec(readFileSync(new URL(name, directory), 'utf8'));
                sqlite.prepare('INSERT INTO account_schema_migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
            }
            sqlite.exec('COMMIT');
        } catch (error) {
            sqlite.exec('ROLLBACK');
            sqlite.close();
            throw error;
        }
    }

    function prepare(sql, values = []) {
        const execute = () => {
            const statement = sqlite.prepare(sql);
            if (statement.columns().length) {
                const results = statement.all(...values).map(row => ({ ...row }));
                return { success: true, results, meta: { changes: Number(sqlite.prepare('SELECT changes() AS n').get().n) } };
            }
            const result = statement.run(...values);
            return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        };
        return {
            bind: (...bound) => prepare(sql, bound),
            first: async (column) => {
                const row = execute().results[0] || null;
                return column && row ? row[column] : row;
            },
            all: async () => execute(),
            run: async () => execute(),
            _execute: execute
        };
    }

    return {
        prepare,
        async batch(statements) {
            sqlite.exec('BEGIN IMMEDIATE');
            try {
                const results = statements.map(statement => statement._execute());
                sqlite.exec('COMMIT');
                return results;
            } catch (error) {
                sqlite.exec('ROLLBACK');
                throw error;
            }
        },
        close: () => sqlite.close()
    };
}
