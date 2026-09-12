import { evaluateIndependentReport, reportListSummary } from './independent-report.js';

export function accountError(status, code, message) {
    return Object.assign(new Error(message), { status, code });
}

const userView = row => row ? { id: row.id, email: row.email, name: row.name, picture: row.picture_url || '',
    googleSub: row.google_sub, authoritativeEmail: row.email_authoritative === 1,
    googleVerifiedAt: row.google_verified_at ? new Date(row.google_verified_at).toISOString() : null
} : null;
const licenseView = row => row ? {
    licenseId: row.license_id, freemiusUserId: row.freemius_user_id,
    mode: row.mode, active: row.active === 1, verifiedAt: new Date(row.verified_at).toISOString(),
    inactiveReason: row.active === 1 ? '' : row.inactive_reason || ''
} : null;
const reportView = row => ({
    id: row.id, report: JSON.parse(row.report_json), note: row.note,
    createdAt: new Date(row.created_at).toISOString(),
    evaluation: row.evaluation_json ? JSON.parse(row.evaluation_json) : null
});
const CHECKOUT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const GOOGLE_PROOF_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const REPORT_STORAGE_LIMITS = Object.freeze({
    free: Object.freeze({ reports: 20, bytes: 1024 * 1024 }),
    premium: Object.freeze({ reports: 200, bytes: 10 * 1024 * 1024 })
});
// Reserve enough UTF-8 space for every permitted 500-character note, including
// future edits. Storage admission never requires deleting an existing report.
const NOTE_STORAGE_BYTES = 2048;
// A started review reserves its bounded revisions and comparison metadata. The
// reservation participates in the same admission query as ordinary reports.
export const REVIEW_STORAGE_BYTES = 65536;
const REPORT_STORAGE_SQL = `SELECT usage.*,
    CASE WHEN entitlement.active THEN ? ELSE ? END AS maxReports,
    CASE WHEN entitlement.active THEN ? ELSE ? END AS maxBytes
    FROM (SELECT COUNT(*) AS reportCount, COALESCE(SUM(length(CAST(report_json AS BLOB))
        + COALESCE(length(CAST(evaluation_json AS BLOB)), 0) + COALESCE(length(CAST(summary_json AS BLOB)), 0) + ?), 0)
        + (SELECT COUNT(*) * ${REVIEW_STORAGE_BYTES} FROM account_reviews WHERE user_id = ?) AS bytes
        FROM account_reports WHERE user_id = ?) usage
    CROSS JOIN (SELECT EXISTS(SELECT 1 FROM account_licenses WHERE user_id = ? AND mode = ? AND active = 1) AS active) entitlement`;

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

    reportStorageParams(userId) {
        const { free, premium } = REPORT_STORAGE_LIMITS;
        return [premium.reports, free.reports, premium.bytes, free.bytes, NOTE_STORAGE_BYTES, userId, userId, userId, this.mode];
    }

    getReportStorage(userId) {
        return this.statement(REPORT_STORAGE_SQL, ...this.reportStorageParams(userId)).first();
    }

    async getReportByRun(userId, runId) {
        const row = await this.statement('SELECT * FROM account_reports WHERE user_id = ? AND run_id = ?', userId, runId).first();
        return row ? reportView(row) : null;
    }

    async getReport(userId, id) {
        const row = await this.statement('SELECT * FROM account_reports WHERE user_id = ? AND id = ?', userId, id).first();
        return row ? reportView(row) : null;
    }

    async freezeLegacyEvaluation(userId, entry) {
        if (entry.evaluation) return entry;
        const evaluation = evaluateIndependentReport(entry.report, undefined, { legacy: true });
        const serialized = JSON.stringify(evaluation), summary = JSON.stringify(reportListSummary(entry.report, evaluation));
        const bytes = new TextEncoder().encode(serialized + summary).byteLength;
        const results = await this.db.batch([
            this.statement(`WITH storage AS (${REPORT_STORAGE_SQL}) UPDATE account_reports
                SET evaluation_json = ?, summary_json = ? WHERE id = ? AND user_id = ? AND evaluation_json IS NULL
                AND EXISTS(SELECT 1 FROM storage WHERE bytes + ? <= maxBytes)
                AND EXISTS(SELECT 1 FROM account_licenses WHERE user_id = ? AND mode = ? AND active = 1)`,
            ...this.reportStorageParams(userId), serialized, summary, entry.id, userId, bytes, userId, this.mode),
            this.statement('SELECT * FROM account_reports WHERE user_id = ? AND id = ?', userId, entry.id)
        ]);
        const row = results[1].results[0];
        if (!row) throw accountError(404, 'report_not_found', 'This report was deleted.');
        if (!row.evaluation_json) throw accountError(409, 'report_storage_full', 'Make room in your archive to prepare this legacy result.');
        return reportView(row);
    }

    async createReview(userId, reportId, state) {
        const serialized = JSON.stringify(state), now = Date.now();
        const results = await this.db.batch([
            this.statement(`WITH storage AS (${REPORT_STORAGE_SQL})
                INSERT INTO account_reviews(id, user_id, mode, report_id, state_json, created_at, updated_at)
                SELECT ?, ?, ?, ?, ?, ?, ? FROM storage WHERE bytes + ? <= maxBytes
                AND EXISTS (SELECT 1 FROM account_reports WHERE id = ? AND user_id = ?)
                ON CONFLICT(user_id, mode, report_id) DO NOTHING`, ...this.reportStorageParams(userId),
            crypto.randomUUID(), userId, this.mode, reportId, serialized, now, now, REVIEW_STORAGE_BYTES, reportId, userId),
            this.statement('SELECT * FROM account_reviews WHERE user_id = ? AND mode = ? AND report_id = ?', userId, this.mode, reportId)
        ]);
        const row = results[1].results[0];
        if (!row) throw accountError(409, 'report_storage_full', 'There is not enough space to save this review. Your recording result is preserved.');
        return row;
    }

    getReview(userId, id) {
        return this.statement('SELECT * FROM account_reviews WHERE id = ? AND user_id = ? AND mode = ?', id, userId, this.mode).first();
    }

    getReviewByRun(userId, runId) {
        return this.statement(`SELECT r.* FROM account_reviews r JOIN account_reports p ON p.id = r.report_id
            WHERE r.user_id = ? AND r.mode = ? AND p.run_id = ?`, userId, this.mode, runId).first();
    }

    async updateReview(userId, id, revision, state) {
        const serialized = JSON.stringify(state);
        if (new TextEncoder().encode(serialized).byteLength > REVIEW_STORAGE_BYTES) {
            throw accountError(409, 'review_storage_full', 'This review has reached its saved history limit. Your existing result is preserved.');
        }
        const row = await this.statement(`UPDATE account_reviews SET state_json = ?, revision = revision + 1, updated_at = ?
            WHERE id = ? AND user_id = ? AND mode = ? AND revision = ? RETURNING *`,
        serialized, Date.now(), id, userId, this.mode, revision).first();
        if (!row) throw accountError(409, 'review_changed', 'The review changed in another window. Reopen it to see the saved result.');
        return row;
    }

    async addChallenge(hash, expiresAt, context = null) {
        await this.db.batch([
            this.statement('DELETE FROM account_login_challenges WHERE expires_at <= ?', Date.now()),
            this.statement('INSERT INTO account_login_challenges (nonce_hash, expires_at, context_json) VALUES (?, ?, ?)', hash, expiresAt, context ? JSON.stringify(context) : null)
        ]);
    }

    async consumeChallenge(hash) {
        return this.statement('DELETE FROM account_login_challenges WHERE nonce_hash = ? AND expires_at > ? RETURNING nonce_hash, context_json', hash, Date.now()).first();
    }

    async upsertUser(identity) {
        const now = Date.now();
        return userView(await this.statement(`INSERT INTO accounts (id, google_sub, email, name, created_at, updated_at, email_authoritative, google_verified_at, picture_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(google_sub) DO UPDATE SET
            email = excluded.email, name = excluded.name, updated_at = excluded.updated_at,
            email_authoritative = excluded.email_authoritative, google_verified_at = excluded.google_verified_at,
            picture_url = excluded.picture_url RETURNING *`,
        crypto.randomUUID(), identity.sub, identity.email, identity.name || '', now, now, identity.authoritativeEmail ? 1 : 0, now, identity.picture || '').first());
    }

    async addSession(hash, userId, expiresAt, oldHash, expectedOwner = null) {
        const now = Date.now();
        const statements = [
            this.statement('DELETE FROM account_sessions WHERE expires_at <= ?', now),
            expectedOwner
                ? this.statement(`INSERT INTO account_sessions (token_hash, user_id, created_at, expires_at)
                    SELECT ?, ?, ?, ? FROM account_sessions WHERE token_hash = ? AND user_id = ? AND expires_at > ?`,
                hash, userId, now, expiresAt, oldHash, expectedOwner, now)
                : this.statement('INSERT INTO account_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', hash, userId, now, expiresAt)
        ];
        // Only the attempt that still owns the old session can replace it.
        if (oldHash) statements.push(this.statement(`DELETE FROM account_sessions WHERE token_hash = ?
            AND EXISTS (SELECT 1 FROM account_sessions WHERE token_hash = ?)`, oldHash, hash));
        const results = await this.db.batch(statements);
        return results[1].meta.changes === 1;
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

    async getLicenses(userId) {
        const { results } = await this.statement(`SELECT * FROM account_licenses WHERE user_id = ? AND mode = ?
            ORDER BY active DESC, (verified_at = 0) DESC, verified_at DESC, license_id DESC`, userId, this.mode).all();
        return results.map(licenseView);
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

    async updateLicense(licenseId, { active, verifiedAt, inactiveReason = '', checkedAt = null }) {
        // A delayed provider response must not overwrite a check started later.
        // If two checks start in the same millisecond, revocation wins the tie.
        await this.statement(`UPDATE account_licenses SET active = ?, verified_at = ?, inactive_reason = ? WHERE mode = ? AND license_id = ?
            AND (? IS NULL OR verified_at < ? OR (verified_at = ? AND active >= ?))`,
        active ? 1 : 0, verifiedAt, active ? '' : inactiveReason, this.mode, licenseId, checkedAt, checkedAt, checkedAt, active ? 1 : 0).run();
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

    async recoverCheckout(license, email, licenseCreatedAt, expectedUserId = null) {
        const candidates = [this.mode, email, licenseCreatedAt, licenseCreatedAt,
            Date.now() - CHECKOUT_RETENTION_MS, GOOGLE_PROOF_MAX_AGE_MS, license.licenseId];
        const results = await this.db.batch([
            this.statement(`${RECOVERY_CANDIDATES}
                INSERT INTO account_licenses (user_id, mode, license_id, freemius_user_id, active, verified_at)
                SELECT user_id, ?, ?, ?, ?, ? FROM sole_owner WHERE user_id IS NOT NULL
                AND (? IS NULL OR user_id = ?)
                ON CONFLICT DO NOTHING`, ...candidates, this.mode, license.licenseId,
            license.freemiusUserId, license.active ? 1 : 0, license.verifiedAt, expectedUserId, expectedUserId),
            this.statement(`${RECOVERY_CANDIDATES}
                UPDATE account_checkouts SET completed_license_id = ? WHERE state_hash IN (SELECT state_hash FROM candidates)
                AND user_id = (SELECT user_id FROM sole_owner)
                AND (? IS NULL OR user_id = ?)
                AND EXISTS (SELECT 1 FROM account_licenses l WHERE l.user_id = account_checkouts.user_id AND l.mode = ? AND l.license_id = ?)`,
            ...candidates, license.licenseId, expectedUserId, expectedUserId, this.mode, license.licenseId),
            this.statement(`${RECOVERY_CANDIDATES}
                SELECT l.* FROM account_licenses l JOIN sole_owner o ON o.user_id = l.user_id WHERE l.mode = ? AND l.license_id = ?
                AND (? IS NULL OR l.user_id = ?)`,
            ...candidates, this.mode, license.licenseId, expectedUserId, expectedUserId)
        ]);
        const row = results[2].results[0];
        return row ? { ...licenseView(row), userId: row.user_id } : null;
    }

    async saveReport(userId, report, note) {
        // Return the same committed snapshot even if another tab deletes the
        // report immediately after this save or idempotent retry completes.
        const serialized = JSON.stringify(report);
        const evaluation = JSON.stringify(evaluateIndependentReport(report));
        const summary = JSON.stringify(reportListSummary(report, JSON.parse(evaluation)));
        const bytes = new TextEncoder().encode(serialized + evaluation + summary).byteLength + NOTE_STORAGE_BYTES;
        const results = await this.db.batch([
            this.statement(`WITH storage AS (${REPORT_STORAGE_SQL})
                INSERT INTO account_reports (id, user_id, run_id, report_json, note, created_at, evaluation_json, summary_json)
                SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM storage WHERE reportCount < maxReports AND bytes + ? <= maxBytes
                AND EXISTS(SELECT 1 FROM account_licenses WHERE user_id = ? AND mode = ? AND active = 1)
                AND NOT EXISTS(SELECT 1 FROM account_report_deletions WHERE user_id = ? AND run_id = ?)
                ON CONFLICT(user_id, run_id) DO NOTHING`,
            ...this.reportStorageParams(userId), crypto.randomUUID(), userId, report.run.id, serialized, note, Date.now(), evaluation, summary,
            bytes, userId, this.mode, userId, report.run.id),
            this.statement(`SELECT * FROM account_reports WHERE user_id = ? AND run_id = ?
                AND EXISTS(SELECT 1 FROM account_licenses WHERE user_id = ? AND mode = ? AND active = 1)`,
            userId, report.run.id, userId, this.mode)
        ]);
        const row = results[1].results[0];
        if (!row) {
            if (await this.statement('SELECT 1 FROM account_report_deletions WHERE user_id = ? AND run_id = ?', userId, report.run.id).first())
                throw accountError(410, 'report_deleted', 'This saved report was deleted.');
            const license = await this.getLicense(userId);
            if (!license?.active) throw accountError(Date.parse(license?.verifiedAt) === 0 ? 503 : 403,
                Date.parse(license?.verifiedAt) === 0 ? 'billing_temporarily_unavailable' : 'premium_access_required', 'Premium is required to save new reports.');
            throw accountError(409, 'report_storage_full',
            'Your saved report storage is full. Remove an older report to make room. Your new result is still available on this browser.');
        }
        return reportView(row);
    }

    async listReports(userId, limit, cursor) {
        const params = [userId];
        let condition = '';
        if (cursor) {
            condition = ' AND (created_at < ? OR (created_at = ? AND id < ?))';
            params.push(cursor.time, cursor.time, cursor.id);
        }
        const { results } = await this.statement(`SELECT id, note, created_at, COALESCE(summary_json,
            json_object('run', json_extract(report_json, '$.run'), 'generatedAt', json_extract(report_json, '$.generatedAt'),
                'profile', json_object('id', json_extract(report_json, '$.profile.id'), 'label', json_extract(report_json, '$.profile.label')),
                'legacy', json('true'))) AS summary_json FROM account_reports WHERE user_id = ?${condition}
            ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, limit + 1).all();
        const more = results.length > limit;
        const rows = results.slice(0, limit);
        const last = rows.at(-1);
        return { reports: rows.map(row => ({ id: row.id, note: row.note, createdAt: new Date(row.created_at).toISOString(),
            report: JSON.parse(row.summary_json), summaryOnly: true })), cursor: more ? { time: last.created_at, id: last.id } : null };
    }

    async updateReportNote(userId, reportId, note) {
        const row = await this.statement('UPDATE account_reports SET note = ? WHERE id = ? AND user_id = ? RETURNING *', note, reportId, userId).first();
        return row ? reportView(row) : null;
    }

    async deleteReport(userId, reportId, { byRun = false } = {}) {
        const key = byRun ? 'run_id' : 'id';
        const results = await this.db.batch([
            byRun
                ? this.statement('INSERT OR IGNORE INTO account_report_deletions(user_id, run_id, deleted_at) VALUES (?, ?, ?)', userId, reportId, Date.now())
                : this.statement(`INSERT OR IGNORE INTO account_report_deletions(user_id, run_id, deleted_at)
                    SELECT user_id, run_id, ? FROM account_reports WHERE id = ? AND user_id = ?`, Date.now(), reportId, userId),
            // Old comparisons must not retain a deleted report's measurements.
            // Legacy decisions/answers remain read-only; no new comparison is created.
            this.statement(`UPDATE account_reviews SET state_json = json_set(state_json, '$.comparison', NULL,
                '$.history', json(COALESCE((SELECT json_group_array(json_remove(value, '$.comparison'))
                    FROM json_each(state_json, '$.history')), '[]')))
                WHERE user_id = ? AND EXISTS(SELECT 1 FROM account_reports WHERE ${key} = ? AND user_id = ?)`, userId, reportId, userId),
            this.statement(`DELETE FROM account_reports WHERE ${key} = ? AND user_id = ? RETURNING id`, reportId, userId)
        ]);
        return byRun || !!results[2].results[0];
    }
}
