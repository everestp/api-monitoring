
import amqp from "amqplib";
import config from "./index.js";
import logger from "./logger.js";

/**
 * Manages the shared RabbitMQ connection and channel.
 *
 * A single connection is reused across the application to avoid
 * creating unnecessary RabbitMQ connections and channels.
 */
class RabbitMQConnection {
    constructor() {
        /** @type {import("amqplib").Channel | null} */
        this.channel = null;

        /** @type {import("amqplib").ChannelModel | null} */
        this.connection = null;

        /**
         * Stores the active connection attempt.
         *
         * Multiple callers can wait for the same connection instead of
         * creating multiple RabbitMQ connections.
         */
        this.connectionPromise = null;
    }

    /**
     * Connects to RabbitMQ and initializes the application queues.
     *
     * If a connection already exists, the existing channel is returned.
     * If another connection attempt is running, this method waits for it.
     *
     * @returns {Promise<import("amqplib").Channel>}
     * @throws {Error} If RabbitMQ cannot be reached.
     */
    async connect() {
        if (this.channel) {
            return this.channel;
        }

        // Reuse the active connection attempt.
        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        this.connectionPromise = this.createConnection();

        try {
            return await this.connectionPromise;
        } finally {
            this.connectionPromise = null;
        }
    }

    /**
     * Creates the RabbitMQ connection, channel, and required queues.
     *
     * @private
     * @returns {Promise<import("amqplib").Channel>}
     */
    async createConnection() {
        try {
            logger.info(
                {
                    queue: config.rabbitmq.queue,
                },
                "Connecting to RabbitMQ"
            );

            this.connection = await amqp.connect(
                config.rabbitmq.url
            );

            this.channel =
                await this.connection.createChannel();

            const queueName = config.rabbitmq.queue;
            const deadLetterQueue = `${queueName}.dlq`;

            /**
             * Messages rejected without requeueing are moved here.
             */
            await this.channel.assertQueue(
                deadLetterQueue,
                {
                    durable: true,
                }
            );

            /**
             * Main application queue.
             *
             * Durable queues survive RabbitMQ broker restarts.
             */
            await this.channel.assertQueue(
                queueName,
                {
                    durable: true,
                    arguments: {
                        "x-dead-letter-exchange": "",
                        "x-dead-letter-routing-key":
                            deadLetterQueue,
                    },
                }
            );

            this.registerConnectionEvents();

            logger.info(
                {
                    queue: queueName,
                    deadLetterQueue,
                },
                "RabbitMQ connected successfully"
            );

            return this.channel;
        } catch (error) {
            this.connection = null;
            this.channel = null;

            logger.error(
                {
                    err: error,
                },
                "Failed to connect to RabbitMQ"
            );

            throw error;
        }
    }

    /**
     * Registers RabbitMQ connection lifecycle handlers.
     *
     * The stored connection state is cleared when RabbitMQ disconnects
     * so the next `connect()` call can create a new connection.
     *
     * @private
     * @returns {void}
     */
    registerConnectionEvents() {
        this.connection.on("close", () => {
            this.connection = null;
            this.channel = null;

            logger.warn(
                "RabbitMQ connection closed"
            );
        });

        this.connection.on("error", (error) => {
            logger.error(
                {
                    err: error,
                },
                "RabbitMQ connection error"
            );
        });
    }

    /**
     * Returns the active RabbitMQ channel.
     *
     * @returns {import("amqplib").Channel | null}
     */
    getChannel() {
        return this.channel;
    }

    /**
     * Returns the current RabbitMQ connection status.
     *
     * @returns {"connected" | "connecting" | "disconnected"}
     */
    getStatus() {
        if (this.channel) {
            return "connected";
        }

        if (this.connectionPromise) {
            return "connecting";
        }

        return "disconnected";
    }

    /**
     * Gracefully closes the RabbitMQ channel and connection.
     *
     * This should be called during application shutdown.
     *
     * @returns {Promise<void>}
     */
    async close() {
        try {
            if (this.channel) {
                await this.channel.close();
                this.channel = null;
            }

            if (this.connection) {
                await this.connection.close();
                this.connection = null;
            }

            logger.info(
                "RabbitMQ connection closed"
            );
        } catch (error) {
            logger.error(
                {
                    err: error,
                },
                "Failed to close RabbitMQ connection"
            );
        }
    }
}

export default new RabbitMQConnection();
