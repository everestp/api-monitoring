
import pg from "pg";
import config from "./index.js";
import logger from "./logger.js";

const { Pool } = pg;

/**
 * PostgreSQL connection manager.
 *
 * Responsibilities:
 * - Create and maintain one shared PostgreSQL connection pool.
 * - Provide a reusable query method.
 * - Verify database connectivity during application startup.
 * - Gracefully close database connections during application shutdown.
 *
 * Why use a singleton pool?
 * Creating a new PostgreSQL pool for every query is expensive and can
 * quickly exhaust database connections. This class creates one pool and
 * reuses it throughout the application's lifecycle.
 */
class PostgresConnection {
    constructor() {
        /**
         * The pool is initialized lazily.
         *
         * This means the application can import this module without
         * immediately opening database connections. The pool is created
         * only when it is first needed.
         *
         * @type {pg.Pool | null}
         */
        this.pool = null;
    }

    /**
     * Returns the shared PostgreSQL connection pool.
     *
     * The pool is created only once and reused for all future database
     * operations. Reusing a pool improves performance and prevents
     * unnecessary database connections.
     *
     * @returns {pg.Pool}
     */
    getPool() {
        if (this.pool) {
            return this.pool;
        }

        this.pool = new Pool({
            host: config.postgres.host,
            port: config.postgres.port,
            database: config.postgres.database,
            user: config.postgres.user,
            password: config.postgres.password,

            /**
             * Maximum number of database clients allowed in this pool.
             *
             * Keep this configurable because the ideal value depends on:
             * - Database connection limits
             * - Number of application instances
             * - Expected traffic
             *
             * Example:
             * 5 application instances × 20 connections = 100 possible
             * database connections.
             */
            max: config.postgres.maxConnections ?? 20,

            /**
             * Close unused clients after this period.
             *
             * This helps release idle database connections while keeping
             * frequently used connections available for reuse.
             */
            idleTimeoutMillis:
                config.postgres.idleTimeoutMillis ?? 30_000,

            /**
             * Maximum time to wait for a database connection.
             *
             * A timeout prevents requests from waiting indefinitely when
             * the database is unavailable or the pool is exhausted.
             */
            connectionTimeoutMillis:
                config.postgres.connectionTimeoutMillis ?? 2_000,

            /**
             * Automatically close connections after their maximum lifetime.
             *
             * This is useful for long-running applications because it
             * gradually refreshes old connections.
             */
            maxLifetimeSeconds:
                config.postgres.maxLifetimeSeconds ?? 3_600,

            /**
             * Allow the Node.js process to exit when the pool is idle.
             *
             * This is useful for scripts, workers, and serverless
             * environments. For traditional long-running servers,
             * this can safely remain false.
             */
            allowExitOnIdle: false,
        });

        /**
         * This event is triggered when an unexpected error occurs on an
         * idle client managed by the pool.
         *
         * Without this listener, an idle-client error may cause an
         * unhandled error event and terminate the Node.js process.
         */
        this.pool.on("error", (error) => {
            logger.error(
                {
                    err: error,
                },
                "Unexpected PostgreSQL error on an idle client"
            );
        });

        /**
         * Helpful pool lifecycle logs.
         *
         * Avoid logging credentials, connection strings, or sensitive
         * database configuration.
         */
        this.pool.on("connect", () => {
            logger.debug("New PostgreSQL client connected");
        });

        this.pool.on("remove", () => {
            logger.debug("PostgreSQL client removed from pool");
        });

        logger.info(
            {
                host: config.postgres.host,
                port: config.postgres.port,
                database: config.postgres.database,
                maxConnections:
                    config.postgres.maxConnections ?? 20,
            },
            "PostgreSQL connection pool created"
        );

        return this.pool;
    }

    /**
     * Tests PostgreSQL connectivity.
     *
     * This method should normally be called during application startup.
     * It verifies that:
     * - The database is reachable.
     * - Authentication is valid.
     * - A connection can be acquired from the pool.
     * - A basic SQL query can be executed.
     *
     * @returns {Promise<void>}
     * @throws {Error} When PostgreSQL cannot be reached.
     */
    async testConnection() {
        const pool = this.getPool();
        const startTime = performance.now();

        try {
            /**
             * Acquire a dedicated client from the pool.
             *
             * A dedicated client is used here so we can explicitly verify
             * that connection acquisition works.
             */
            const client = await pool.connect();

            try {
                const result = await client.query(
                    "SELECT NOW() AS connected_at"
                );

                const durationMs = Number(
                    (performance.now() - startTime).toFixed(2)
                );

                logger.info(
                    {
                        connectedAt:
                            result.rows[0].connected_at,
                        durationMs,
                    },
                    "PostgreSQL connected successfully"
                );
            } finally {
                /**
                 * Always return the client to the pool.
                 *
                 * `finally` guarantees that the client is released even
                 * when the query throws an error.
                 */
                client.release();
            }
        } catch (error) {
            logger.error(
                {
                    err: error,
                },
                "Failed to connect to PostgreSQL"
            );

            throw error;
        }
    }

    /**
     * Executes a parameterized SQL query.
     *
     * Always use query parameters instead of inserting user-controlled
     * values directly into SQL strings.
     *
     * Safe:
     *   db.query(
     *       "SELECT * FROM users WHERE email = $1",
     *       [email]
     *   );
     *
     * Unsafe:
     *   db.query(
     *       `SELECT * FROM users WHERE email = '${email}'`
     *   );
     *
     * @param {string} text - SQL query text.
     * @param {unknown[]} [params=[]] - Values for SQL placeholders.
     * @returns {Promise<pg.QueryResult>}
     * @throws {Error} When query execution fails.
     */
    async query(text, params = []) {
        const pool = this.getPool();
        const startTime = performance.now();

        try {
            const result = await pool.query(text, params);

            const durationMs = Number(
                (performance.now() - startTime).toFixed(2)
            );

            /**
             * Do not log query parameters by default.
             *
             * Parameters may contain passwords, tokens, emails, personal
             * information, or other sensitive data.
             */
            logger.debug(
                {
                    durationMs,
                    rowCount: result.rowCount,
                },
                "PostgreSQL query executed"
            );

            /**
             * Log slow queries separately so they are easier to monitor.
             *
             * The threshold should be configurable in production.
             */
            const slowQueryThreshold =
                config.postgres.slowQueryThresholdMs ?? 500;

            if (durationMs >= slowQueryThreshold) {
                logger.warn(
                    {
                        durationMs,
                        thresholdMs: slowQueryThreshold,
                        rowCount: result.rowCount,
                    },
                    "Slow PostgreSQL query detected"
                );
            }

            return result;
        } catch (error) {
            /**
             * Avoid logging query parameters because they may contain
             * sensitive application or user data.
             */
            logger.error(
                {
                    err: error,
                },
                "PostgreSQL query execution failed"
            );

            throw error;
        }
    }

    /**
     * Executes multiple queries inside a database transaction.
     *
     * If the callback completes successfully:
     *   COMMIT
     *
     * If the callback throws an error:
     *   ROLLBACK
     *
     * Example:
     *
     * await db.transaction(async (client) => {
     *     await client.query(
     *         "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
     *         [amount, senderId]
     *     );
     *
     *     await client.query(
     *         "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
     *         [amount, receiverId]
     *     );
     * });
     *
     * @template T
     * @param {(client: pg.PoolClient) => Promise<T>} callback
     * @returns {Promise<T>}
     */
    async transaction(callback) {
        const pool = this.getPool();
        const client = await pool.connect();

        try {
            await client.query("BEGIN");

            const result = await callback(client);

            await client.query("COMMIT");

            return result;
        } catch (error) {
            /**
             * Roll back all changes when any operation fails.
             */
            try {
                await client.query("ROLLBACK");
            } catch (rollbackError) {
                logger.error(
                    {
                        err: rollbackError,
                    },
                    "PostgreSQL transaction rollback failed"
                );
            }

            logger.error(
                {
                    err: error,
                },
                "PostgreSQL transaction failed"
            );

            throw error;
        } finally {
            /**
             * Always return the transaction client to the pool.
             */
            client.release();
        }
    }

    /**
     * Gracefully closes the PostgreSQL connection pool.
     *
     * Call this during application shutdown, for example after receiving:
     * - SIGTERM
     * - SIGINT
     *
     * `pool.end()` waits for active clients to finish before closing
     * the pool.
     *
     * @returns {Promise<void>}
     */
    async close() {
        if (!this.pool) {
            return;
        }

        try {
            await this.pool.end();

            logger.info(
                "PostgreSQL connection pool closed successfully"
            );
        } catch (error) {
            logger.error(
                {
                    err: error,
                },
                "Failed to close PostgreSQL connection pool"
            );

            throw error;
        } finally {
            /**
             * Reset the pool so the instance can be initialized again
             * if required by tests or application lifecycle logic.
             */
            this.pool = null;
        }
    }

    /**
     * Returns useful pool metrics for health checks and monitoring.
     *
     * These values can be exported to Prometheus, OpenTelemetry,
     * Grafana, or another observability platform.
     *
     * @returns {{
     *   totalConnections: number,
     *   idleConnections: number,
     *   waitingRequests: number
     * }}
     */
    getPoolMetrics() {
        const pool = this.getPool();

        return {
            totalConnections: pool.totalCount,
            idleConnections: pool.idleCount,
            waitingRequests: pool.waitingCount,
        };
    }
}

/**
 * Export one shared database manager for the entire application.
 *
 * Usage:
 *
 * import db from "./config/postgres.js";
 *
 * const result = await db.query(
 *     "SELECT * FROM users WHERE id = $1",
 *     [userId]
 * );
 */
export default new PostgresConnection();
