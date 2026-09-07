export function accountError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

const userView = row => row ? { id: row.id, email: row.email, name: row.name,
    authoritativeEmail: row.email_authoritative === 1,
    googleVerifiedAt: row.google_verified_at ? new Date(row.google_verified_at).toISOString() : null
} : null;
const licenseView = row => row ? {
    licenseId: row.license_id, freemiusUserId: row.freemius_user_id,
    mode: row.mode, active: row.active === 1, verifiedAt: new Date(row.verified_at).toISOString()
} : null;
const reportView = row => ({
    id: row.id, report: JSON.parse(row.report_json), note: row.note,
    createdAt: new Date(row.created_at).toISOString()
});
const CHECKOUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const GOOGLE_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Recovery proves a single recently verified email owner, not which particular
// checkout produced the purchase. Every condition is rechecked inside the batch.
const RECOVERY_CANDIDATES = `WITH candidates AS (
    SELECT c.state_hash, c.user_id FROM account_checkouts c JOIN accounts a ON a.id = c.user_id
    WHERE c.mode = ? AND c.recovery_email = ? AND c.created_at <= ? AND c.expires_at >= ?
    AND c.created_at >= ? AND c.recovery_verified_at BETWEEN c.created_at - ? AND c.created_at
    AND c.recovery_email = lower(a.email) AND a.email_authoritative = 1
    AND (c.completed_license_id IS NULL OR c.completed_license_id = ?)
), sole_owner AS (
    SELECT min(user_id) AS user_id FROM candidates HAVING count(DISTINCT user_id) = 1
)`;

export class AccountStore {
    constructor(db, mode) {
        this.db = db;
        this.mode = mode;
    }

    statement(sql, ...values) { return this.db.prepare(sql).bind(...values); }

    async addChallenge(hash, expiresAt) {
        await this.db.batch([
            this.statement('DELETE FROM account_login_challenges WHERE expires_at <= ?', Date.now()),
            this.statement('INSERT INTO account_login_challenges (nonce_hash, expires_at) VALUES (?, ?)', hash, expiresAt)
        ]);
    }

    async consumeChallenge(hash) {
        return !!await this.statement('DELETE FROM account_login_challenges WHERE nonce_hash = ? AND expires_at > ? RETURNING nonce_hash', hash, Date.now()).first();
    }

    async upsertUser(identity) {
        const now = Date.now();
        return userView(await this.statement(`INSERT INTO accounts (id, google_sub, email, name, created_at, updated_at, email_authoritative, google_verified_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(google_sub) DO UPDATE SET
            email = excluded.email, name = excluded.name, updated_at = excluded.updated_at,
            email_authoritative = excluded.email_authoritative, google_verified_at = excluded.google_verified_at RETURNING *`,
        crypto.randomUUID(), identity.sub, identity.email, identity.name || '', now, now, identity.authoritativeEmail ? 1 : 0, now).first());
    }

    async addSession(hash, userId, expiresAt, oldHash) {
        const statements = [
            this.statement('DELETE FROM account_sessions WHERE expires_at <= ?', Date.now()),
            this.statement('INSERT INTO account_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', hash, userId, Date.now(), expiresAt)
        ];
        if (oldHash) statements.push(this.statement('DELETE FROM account_sessions WHERE token_hash = ?', oldHash));
        await this.db.batch(statements);
    }

    async getUser(sessionHash) {
        return userView(await this.statement(`SELECT a.* FROM accounts a
            JOIN account_sessions s ON s.user_id = a.id WHERE s.token_hash = ? AND s.expires_at > ?`, sessionHash, Date.now()).first());
    }

    async deleteSession(hash) { await this.statement('DELETE FROM account_sessions WHERE token_hash = ?', hash).run(); }

    async getLicense(userId) {
        // An unconfirmed new purchase (timestamp 0) must be retried before an
        // older revoked purchase can make the account appear ready to buy again.
        return licenseView(await this.statement(`SELECT * FROM account_licenses WHERE user_id = ? AND mode = ?
            ORDER BY active DESC, (verified_at = 0) DESC, verified_at DESC, license_id DESC LIMIT 1`, userId, this.mode).first());
    }

    async getLicenseById(licenseId) {
        const row = await this.statement('SELECT * FROM account_licenses WHERE license_id = ? AND mode = ?', licenseId, this.mode).first();
        return row ? { ...licenseView(row), userId: row.user_id } : null;
    }

    async saveLicense(userId, license) {
        try {
            await this.statement(`INSERT INTO account_licenses (user_id, mode, license_id, freemius_user_id, active, verified_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(mode, license_id) DO NOTHING`,
            userId, this.mode, license.licenseId, license.freemiusUserId, license.active ? 1 : 0, license.verifiedAt).run();
            const row = await this.statement('SELECT * FROM account_licenses WHERE mode = ? AND license_id = ?', this.mode, license.licenseId).first();
            if (!row || row.user_id !== userId) throw accountError(409, 'license_already_linked', 'This purchase is already linked to an account.');
            return licenseView(row);
        } catch (error) {
            if (/UNIQUE constraint/.test(error.message)) throw accountError(409, 'license_already_linked', 'A different purchase is already linked to this account.');
            throw error;
        }
    }

    async updateLicense(licenseId, { active, verifiedAt, checkedAt = null }) {
        // A delayed provider response must not overwrite a check started later.
        // If two checks start in the same millisecond, revocation wins the tie.
        await this.statement(`UPDATE account_licenses SET active = ?, verified_at = ? WHERE mode = ? AND license_id = ?
            AND (? IS NULL OR verified_at < ? OR (verified_at = ? AND active >= ?))`,
        active ? 1 : 0, verifiedAt, this.mode, licenseId, checkedAt, checkedAt, checkedAt, active ? 1 : 0).run();
        return licenseView(await this.statement('SELECT * FROM account_licenses WHERE mode = ? AND license_id = ?', this.mode, licenseId).first());
    }

    async createCheckout(hash, userId) {
        const now = Date.now();
        await this.db.batch([
            this.statement('DELETE FROM account_checkouts WHERE created_at < ? AND completed_license_id IS NULL', now - CHECKOUT_RETENTION_MS),
            this.statement(`INSERT INTO account_checkouts (state_hash, user_id, mode, created_at, expires_at, recovery_email, recovery_verified_at)
                SELECT ?, id, ?, ?, ?, CASE WHEN email_authoritative = 1 AND google_verified_at BETWEEN ? AND ? THEN lower(email) END,
                CASE WHEN email_authoritative = 1 AND google_verified_at BETWEEN ? AND ? THEN google_verified_at END
                FROM accounts WHERE id = ?`, hash, this.mode, now, now + 3600000,
            now - GOOGLE_PROOF_MAX_AGE_MS, now, now - GOOGLE_PROOF_MAX_AGE_MS, now, userId)
        ]);
    }

    async getCheckout(hash, userId) {
        const row = await this.statement(`SELECT * FROM account_checkouts WHERE state_hash = ? AND user_id = ? AND mode = ?
            AND (expires_at > ? OR completed_license_id IS NOT NULL)`, hash, userId, this.mode, Date.now()).first();
        return row ? { userId: row.user_id, mode: row.mode, expiresAt: row.expires_at, licenseId: row.completed_license_id } : null;
    }

    async completeCheckout(hash, userId, license) {
        // Both writes depend on the same unexpired intent. D1 batch is transactional;
        // the license's unique ownership constraint also prevents concurrent claims.
        const now = Date.now();
        try {
            await this.db.batch([
                this.statement(`INSERT INTO account_licenses (user_id, mode, license_id, freemius_user_id, active, verified_at)
                    SELECT user_id, mode, ?, ?, ?, ? FROM account_checkouts WHERE state_hash = ? AND user_id = ? AND mode = ?
                    AND (expires_at > ? OR completed_license_id = ?) AND (completed_license_id IS NULL OR completed_license_id = ?)
                    ON CONFLICT(mode, license_id) DO NOTHING`,
                license.licenseId, license.freemiusUserId, license.active ? 1 : 0, license.verifiedAt,
                hash, userId, this.mode, now, license.licenseId, license.licenseId),
                this.statement(`UPDATE account_checkouts SET completed_license_id = ? WHERE state_hash = ? AND user_id = ? AND mode = ?
                    AND (expires_at > ? OR completed_license_id = ?) AND (completed_license_id IS NULL OR completed_license_id = ?)
                    AND EXISTS (SELECT 1 FROM account_licenses WHERE user_id = ? AND mode = ? AND license_id = ?)`,
                license.licenseId, hash, userId, this.mode, now, license.licenseId, license.licenseId, userId, this.mode, license.licenseId)
            ]);
        } catch (error) {
            if (/UNIQUE constraint/.test(error.message)) throw accountError(409, 'license_already_linked', 'A different purchase is already linked to this account.');
            throw error;
        }
        const intent = await this.getCheckout(hash, userId);
        if (!intent || intent.licenseId !== license.licenseId) {
            throw accountError(409, 'checkout_not_linked', 'This checkout could not be linked. Sign in to the account that started it.');
        }
        return licenseView(await this.statement('SELECT * FROM account_licenses WHERE mode = ? AND license_id = ?', this.mode, license.licenseId).first());
    }

    async recoverCheckout(license, email, licenseCreatedAt) {
        const candidates = [this.mode, email, licenseCreatedAt, licenseCreatedAt,
            Date.now() - CHECKOUT_RETENTION_MS, GOOGLE_PROOF_MAX_AGE_MS, license.licenseId];
        const results = await this.db.batch([
            this.statement(`${RECOVERY_CANDIDATES}
                INSERT INTO account_licenses (user_id, mode, license_id, freemius_user_id, active, verified_at)
                SELECT user_id, ?, ?, ?, ?, ? FROM sole_owner WHERE user_id IS NOT NULL
                ON CONFLICT DO NOTHING`, ...candidates, this.mode, license.licenseId,
            license.freemiusUserId, license.active ? 1 : 0, license.verifiedAt),
            this.statement(`${RECOVERY_CANDIDATES}
                UPDATE account_checkouts SET completed_license_id = ? WHERE state_hash IN (SELECT state_hash FROM candidates)
                AND user_id = (SELECT user_id FROM sole_owner)
                AND EXISTS (SELECT 1 FROM account_licenses l WHERE l.user_id = account_checkouts.user_id AND l.mode = ? AND l.license_id = ?)`,
            ...candidates, license.licenseId, this.mode, license.licenseId),
            this.statement(`${RECOVERY_CANDIDATES}
                SELECT l.* FROM account_licenses l JOIN sole_owner o ON o.user_id = l.user_id WHERE l.mode = ? AND l.license_id = ?`,
            ...candidates, this.mode, license.licenseId)
        ]);
        const row = results[2].results[0];
        return row ? { ...licenseView(row), userId: row.user_id } : null;
    }

    async saveReport(userId, report, note) {
        // Return the same committed snapshot even if another tab deletes the
        // report immediately after this save or idempotent retry completes.
        const results = await this.db.batch([
            this.statement(`INSERT INTO account_reports (id, user_id, run_id, report_json, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, run_id) DO NOTHING`,
            crypto.randomUUID(), userId, report.run.id, JSON.stringify(report), note, Date.now()),
            this.statement('SELECT * FROM account_reports WHERE user_id = ? AND run_id = ?', userId, report.run.id)
        ]);
        return reportView(results[1].results[0]);
    }

    async listReports(userId, limit, cursor) {
        const params = [userId];
        let condition = '';
        if (cursor) {
            condition = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
            params.push(cursor.time, cursor.time, cursor.id);
        }
        const { results } = await this.statement(`SELECT * FROM account_reports WHERE user_id = ?${condition}
            ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, limit + 1).all();
        const more = results.length > limit;
        const rows = results.slice(0, limit);
        const last = rows.at(-1);
        return { reports: rows.map(reportView), cursor: more ? { time: last.created_at, id: last.id } : null };
    }

    async updateReportNote(userId, reportId, note) {
        const row = await this.statement('UPDATE account_reports SET note = ? WHERE id = ? AND user_id = ? RETURNING *', note, reportId, userId).first();
        return row ? reportView(row) : null;
    }

    async deleteReport(userId, reportId) {
        return !!await this.statement('DELETE FROM account_reports WHERE id = ? AND user_id = ? RETURNING id', reportId, userId).first();
    }
}
